import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const leagues = await p.league.findMany({
    select: { name: true, apiFootballId: true, oddsApiKey: true },
    orderBy: [{ tier: 'asc' }, { name: 'asc' }],
  });
  console.log('LEAGUE MAPPING (api-football id | league)');
  for (const l of leagues) console.log(`  ${String(l.apiFootballId ?? '--').padStart(4)} | ${l.name}`);

  const [matches, teams, aliases, odds, withPrices, snapshots] = await Promise.all([
    p.match.count(),
    p.team.count(),
    p.teamAlias.count(),
    p.odds.count(),
    p.match.count({ where: { odds: { some: {} } } }),
    p.matchResultSnapshot.count(),
  ]);
  console.log(`\nmatches=${matches} teams=${teams} aliases=${aliases} odds=${odds} matchesWithPrices=${withPrices} resultSnapshots=${snapshots}`);

  const byMarket = await p.odds.groupBy({ by: ['marketId'], _count: true });
  const marketNames = await p.bettingMarket.findMany({ select: { id: true, code: true } });
  const nameById = new Map(marketNames.map((m) => [m.id, m.code]));
  console.log('\nPRICES BY MARKET');
  for (const row of byMarket) console.log(`  ${String(row._count).padStart(5)}  ${nameById.get(row.marketId)}`);

  const sample = await p.match.findFirst({
    where: { odds: { some: {} } },
    select: {
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      _count: { select: { odds: true } },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
  });
  console.log('\nSAMPLE PRICED FIXTURE');
  console.log(`  ${sample?.league.name}: ${sample?.homeTeam.name} v ${sample?.awayTeam.name}`);
  console.log(`  kickoff ${sample?.scheduledKickoffUtc.toISOString()}  prices=${sample?._count.odds}`);

  const quota = await p.providerRequestLog.groupBy({
    by: ['provider'],
    _sum: { cost: true },
    _count: true,
  });
  console.log('\nPROVIDER USAGE');
  for (const q of quota) console.log(`  ${q.provider}: ${q._count} calls, ${q._sum.cost} credits`);
}

main().finally(() => p.$disconnect());
