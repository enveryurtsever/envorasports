import { PrismaClient } from '@prisma/client';
import { importSeasons } from '../src/services/ingestion/historical-import';

/**
 * Bulk history import from football-data.co.uk.
 *
 *   npx tsx scripts/import-history.ts 2026,2025 [E0,SP1,...]
 *
 * Unmetered, so this is where years of results and closing prices come from.
 */
const prisma = new PrismaClient();

async function main() {
  const seasons = (process.argv[2] ?? '2026,2025')
    .split(',')
    .map(Number)
    .filter(Number.isInteger);

  const divisionArg = process.argv[3];
  const divisions = divisionArg
    ? divisionArg.split(',').filter(Boolean)
    : (
        await prisma.league.findMany({
          where: { active: true, csvDivision: { not: null } },
          select: { csvDivision: true },
          orderBy: { tier: 'asc' },
        })
      )
        .map((l) => l.csvDivision)
        .filter((d): d is string => d !== null);

  console.log(`Importing ${divisions.length} divisions x ${seasons.length} seasons`);

  let matches = 0;
  let odds = 0;
  const unresolved = new Set<string>();

  for (const division of divisions) {
    const results = await importSeasons(division, seasons);
    const divMatches = results.reduce((sum, r) => sum + r.matchesImported, 0);
    const divOdds = results.reduce((sum, r) => sum + r.oddsImported, 0);
    results.forEach((r) => r.unresolvedTeams.forEach((n) => unresolved.add(n)));
    matches += divMatches;
    odds += divOdds;
    console.log(`  ${division.padEnd(4)} matches=${String(divMatches).padStart(4)} odds=${divOdds}`);
  }

  console.log(`\nTotal: ${matches} matches, ${odds} price rows`);
  if (unresolved.size > 0) {
    console.log(`Unresolved team names (${unresolved.size}): ${[...unresolved].slice(0, 20).join(', ')}`);
  }
}

main()
  .catch((error) => {
    console.error('Import failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
