import { PrismaClient } from '@prisma/client';

/**
 * Assigns each competition an Elo offset so cross-league ties can be read.
 *
 * These numbers are a judgement, not a measurement. Elo cannot supply them:
 * every league is a closed pool centred on 1500, so the ratings carry no
 * information about how the pools compare. Until enough European ties have
 * been graded to fit the offsets from results, they come from what is
 * generally known about the standard of these competitions — roughly the
 * ordering UEFA's own coefficients give, expressed in rating points.
 *
 * They are deliberately conservative. An offset that is too small leaves some
 * of the old bias in place; one that is too large invents a new bias pointing
 * the other way, and the second is harder to notice.
 *
 * Domestic ties are unaffected: the offset is only applied when the two sides
 * come from different leagues, where it cancels out.
 *
 *   npx tsx scripts/set-league-strength.ts [--apply]
 */

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

/** Offset in Elo points above a neutral baseline. */
const STRENGTH: Record<string, number> = {
  // The five strongest domestic leagues, in the order they are usually ranked.
  soccer_epl: 140,
  soccer_spain_la_liga: 120,
  soccer_italy_serie_a: 110,
  soccer_germany_bundesliga: 100,
  soccer_france_ligue_one: 80,

  // Strong second tier of Europe. The Championship is placed here rather than
  // with second divisions: its upper half beats much of this group.
  soccer_netherlands_eredivisie: 55,
  soccer_portugal_primeira_liga: 55,
  soccer_efl_champ: 45,
  soccer_belgium_first_div: 40,
  soccer_turkey_super_league: 40,
  soccer_greece_super_league: 20,
  soccer_spl: 15,

  // Second divisions of strong countries.
  soccer_germany_bundesliga2: 10,
  soccer_spain_segunda_division: 5,
  soccer_italy_serie_b: 0,
  soccer_france_ligue_two: -5,

  // Third and fourth tiers.
  soccer_england_league1: -40,
  soccer_england_league2: -75,

  /**
   * Cups take no offset of their own. A team in the Champions League carries
   * the standard of the league it actually plays in, and that is where its
   * rating was earned — giving the competition an offset would add it twice.
   */
  soccer_uefa_champs_league: 0,
  soccer_uefa_europa_league: 0,
  soccer_uefa_europa_conference_league: 0,
  soccer_england_efl_cup: 0,
  soccer_fa_cup: 0,
};

async function main(): Promise<void> {
  const leagues = await prisma.league.findMany({
    select: { id: true, name: true, oddsApiKey: true, strengthOffset: true },
    orderBy: { name: 'asc' },
  });

  for (const league of leagues) {
    const offset = league.oddsApiKey ? STRENGTH[league.oddsApiKey] : undefined;
    if (offset === undefined) {
      console.log(`${league.name.padEnd(30)} no rating assigned — left at ${league.strengthOffset}`);
      continue;
    }

    const sign = offset > 0 ? `+${offset}` : String(offset);
    console.log(`${league.name.padEnd(30)} ${String(league.strengthOffset).padStart(5)} -> ${sign}`);
    if (apply) {
      await prisma.league.update({ where: { id: league.id }, data: { strengthOffset: offset } });
    }
  }

  console.log(apply ? '\napplied' : '\ndry run — re-run with --apply');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
