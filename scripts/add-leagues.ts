import { PrismaClient } from '@prisma/client';

/**
 * Adds competitions the odds provider already covers.
 *
 * Only two kinds are worth adding, and for opposite reasons.
 *
 * A league with a football-data.co.uk archive can be backfilled for nothing, so
 * its models work from the first day. A cup made of teams we already track
 * needs no history at all — form is computed per team across every match a
 * side has played, so a Champions League tie between two sides we already model
 * is predictable immediately, and the league scoring baseline falls back to the
 * long-run average when a competition has none of its own.
 *
 * Everything else the provider carries — MLS, Brazil, Saudi, Argentina — is
 * deliberately left out. Their fixtures would be discovered and priced, and
 * then produce nothing but INSUFFICIENT_HISTORY for months. Coverage that
 * cannot be predicted is not coverage.
 *
 *   npx tsx scripts/add-leagues.ts
 */

const prisma = new PrismaClient();
const SOURCE = 'manual';

interface NewLeague {
  externalId: string;
  name: string;
  country: string;
  oddsApiKey: string;
  type: 'League' | 'Cup';
  tier: number | null;
  csvDivision: string | null;
  /** 0..1, feeds the data-quality score. Lower where the archive is thinner. */
  dataQuality: number;
}

const LEAGUES: NewLeague[] = [
  // Archive-backed: history is free and immediate.
  {
    externalId: 'E2',
    name: 'League One',
    country: 'England',
    oddsApiKey: 'soccer_england_league1',
    type: 'League',
    tier: 3,
    csvDivision: 'E2',
    dataQuality: 0.55,
  },
  {
    externalId: 'E3',
    name: 'League Two',
    country: 'England',
    oddsApiKey: 'soccer_england_league2',
    type: 'League',
    tier: 4,
    csvDivision: 'E3',
    dataQuality: 0.5,
  },
  /**
   * Cups. No archive, and none needed: every side in them already has a
   * domestic history in this database. What they do add is a different kind of
   * fixture — cross-league ties the coupon builder can use to widen a slate
   * that is otherwise five games from the same three countries.
   */
  {
    externalId: 'UCL',
    name: 'UEFA Champions League',
    country: 'Europe',
    oddsApiKey: 'soccer_uefa_champs_league',
    type: 'Cup',
    tier: 1,
    csvDivision: null,
    dataQuality: 0.7,
  },
  {
    /**
     * Europa and Conference are added ahead of their fixtures — 16 September
     * and 15 October respectively. Discovery costs nothing, so a competition
     * configured early simply starts collecting the moment its draw is priced,
     * rather than being noticed the week it matters.
     */
    externalId: 'UEL',
    name: 'UEFA Europa League',
    country: 'Europe',
    oddsApiKey: 'soccer_uefa_europa_league',
    type: 'Cup',
    tier: 1,
    csvDivision: null,
    dataQuality: 0.6,
  },
  {
    externalId: 'UECL',
    name: 'UEFA Europa Conference League',
    country: 'Europe',
    oddsApiKey: 'soccer_uefa_europa_conference_league',
    type: 'Cup',
    tier: 2,
    csvDivision: null,
    // Thinner: most of its field comes from leagues this database does not
    // carry, so many of its fixtures will have no history behind either side.
    dataQuality: 0.45,
  },
  {
    externalId: 'EFL_CUP',
    name: 'EFL Cup',
    country: 'England',
    oddsApiKey: 'soccer_england_efl_cup',
    type: 'Cup',
    tier: null,
    csvDivision: null,
    dataQuality: 0.6,
  },
  {
    externalId: 'FA_CUP',
    name: 'FA Cup',
    country: 'England',
    oddsApiKey: 'soccer_fa_cup',
    type: 'Cup',
    tier: null,
    csvDivision: null,
    dataQuality: 0.6,
  },
];

/** The season a fixture created today belongs to. */
function currentSeasonYear(now = new Date()): number {
  // European seasons run August to May, so a January fixture belongs to the
  // season that started the previous year.
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

async function main(): Promise<void> {
  const year = currentSeasonYear();

  for (const definition of LEAGUES) {
    const existing = await prisma.league.findFirst({
      where: { oddsApiKey: definition.oddsApiKey },
      select: { id: true, name: true },
    });

    if (existing) {
      console.log(`already configured: ${existing.name} (${definition.oddsApiKey})`);
      continue;
    }

    const league = await prisma.league.create({
      data: {
        source: SOURCE,
        externalId: definition.externalId,
        name: definition.name,
        country: definition.country,
        type: definition.type,
        tier: definition.tier,
        oddsApiKey: definition.oddsApiKey,
        csvDivision: definition.csvDivision,
        dataQuality: definition.dataQuality,
        active: true,
      },
      select: { id: true },
    });

    // Discovery creates fixtures against a season, so one has to exist before
    // the league can carry anything.
    await prisma.season.create({
      data: {
        leagueId: league.id,
        source: SOURCE,
        externalId: `${definition.externalId}-${year}`,
        name: `${year}/${String(year + 1).slice(2)}`,
        startDate: new Date(Date.UTC(year, 6, 1)),
        endDate: new Date(Date.UTC(year + 1, 5, 30)),
        current: true,
      },
    });

    console.log(
      `added: ${definition.name} (${definition.oddsApiKey})` +
        `${definition.csvDivision ? ` csv=${definition.csvDivision}` : ' cup, no archive'}`,
    );
  }

  const total = await prisma.league.count({ where: { active: true } });
  console.log(`\nactive leagues: ${total}`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
