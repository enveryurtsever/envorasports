import { PrismaClient } from '@prisma/client';
import { normalizeTeamName } from '../src/services/ingestion/team-resolver';

/**
 * Folds a club that exists twice into the row that carries its history.
 *
 * The archive writes short names — "Sp Lisbon", "Sp Gijon" — and the fixture
 * provider writes full ones. When both end up as separate teams, a discovered
 * fixture can attach to the empty row and the engine then skips it for want of
 * features: Sporting CP had two matches beside Sp Lisbon's hundred and forty,
 * and the Galatasaray tie produced no prediction at all.
 *
 * The survivor is whichever row has played more. Everything pointing at the
 * duplicate is repointed, the duplicate's name is kept as an alias so the
 * spelling still resolves, and only then is it removed.
 *
 *   npx tsx scripts/merge-duplicate-teams.ts "Sp Lisbon" "Sporting CP" [--apply]
 */

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const names = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

async function main(): Promise<void> {
  if (names.length !== 2) {
    console.log('usage: merge-duplicate-teams.ts "<team a>" "<team b>" [--apply]');
    await prisma.$disconnect();
    return;
  }

  const teams = await Promise.all(
    names.map((name) =>
      prisma.team.findFirst({
        where: { name },
        select: {
          id: true,
          name: true,
          source: true,
          _count: { select: { homeMatches: true, awayMatches: true } },
        },
      }),
    ),
  );

  if (teams.some((team) => team === null)) {
    console.log('one of those names is not a team:', names);
    await prisma.$disconnect();
    return;
  }

  const resolved = teams as NonNullable<(typeof teams)[number]>[];
  const a = resolved[0]!;
  const b = resolved[1]!;
  const played = (t: typeof a) => t._count.homeMatches + t._count.awayMatches;

  // History is what the models need, so the row that has it survives.
  const keep = played(a) >= played(b) ? a : b;
  const drop = keep === a ? b : a;
  console.log(`keep  ${keep.name} (${keep.source}, ${played(keep)} matches)`);
  console.log(`merge ${drop.name} (${drop.source}, ${played(drop)} matches)`);

  if (!apply) {
    console.log('\ndry run — re-run with --apply');
    await prisma.$disconnect();
    return;
  }

  const moved = {
    homeMatches: (await prisma.match.updateMany({ where: { homeTeamId: drop.id }, data: { homeTeamId: keep.id } })).count,
    awayMatches: (await prisma.match.updateMany({ where: { awayTeamId: drop.id }, data: { awayTeamId: keep.id } })).count,
  };

  // The duplicate's spelling has to keep resolving, or the next sync recreates
  // it. Aliases are the place that reconciliation already lives.
  const normalized = normalizeTeamName(drop.name);
  // The alias table is unique on (source, normalized), not per team, so a
  // spelling already claimed elsewhere is moved rather than duplicated.
  const existing = await prisma.teamAlias.findFirst({
    where: { source: drop.source, normalized },
  });
  if (existing) {
    await prisma.teamAlias.update({ where: { id: existing.id }, data: { teamId: keep.id } });
  } else {
    await prisma.teamAlias.create({
      data: {
        teamId: keep.id,
        source: drop.source,
        alias: drop.name,
        normalized,
        confidence: 1,
        verified: true,
      },
    });
  }

  /**
   * Anything else still pointing at it is dropped rather than merged: ratings
   * and form snapshots are derived and rebuild themselves from the matches.
   * Aliases move where the spelling is free and are discarded where it is not —
   * the surviving row already answers to it.
   */
  for (const alias of await prisma.teamAlias.findMany({ where: { teamId: drop.id } })) {
    const clash = await prisma.teamAlias.findFirst({
      where: { source: alias.source, normalized: alias.normalized, NOT: { id: alias.id } },
    });
    if (clash) await prisma.teamAlias.delete({ where: { id: alias.id } });
    else await prisma.teamAlias.update({ where: { id: alias.id }, data: { teamId: keep.id } });
  }
  await prisma.eloRating.deleteMany({ where: { teamId: drop.id } });
  await prisma.teamFormSnapshot.deleteMany({ where: { teamId: drop.id } });
  await prisma.teamSeason.deleteMany({ where: { teamId: drop.id } });
  await prisma.matchStatistic.deleteMany({ where: { teamId: drop.id } });
  await prisma.player.deleteMany({ where: { teamId: drop.id } });
  await prisma.team.delete({ where: { id: drop.id } });

  console.log(`moved ${moved.homeMatches} home and ${moved.awayMatches} away fixtures onto ${keep.name}`);
  console.log('rebuild Elo afterwards: the ratings for the dropped row are gone by design');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
