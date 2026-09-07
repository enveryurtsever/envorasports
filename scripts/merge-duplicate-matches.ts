import { PrismaClient } from '@prisma/client';

/**
 * Merges fixtures that discovery created beside one the fixture provider
 * already had.
 *
 * `findMatchForEvent` only looks at fixtures that are unmapped and still
 * scheduled, because its job is mapping. Anything already mapped or already
 * finished was invisible to it, so when the fixture provider had served the
 * same match first, a second copy was created next to it — eighteen of them,
 * each showing SCHEDULED with no score beside a twin that carried the result.
 * Discovery no longer does this; these are the ones already written.
 *
 * Nothing is deleted while anything still points at it. The result is copied
 * from the real fixture onto the phantom so its predictions and coupon legs
 * settle correctly, and the phantom is then excluded from generation and
 * listings. A phantom nothing depends on is removed outright.
 *
 *   npx tsx scripts/merge-duplicate-matches.ts [--apply]
 */

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

async function main(): Promise<void> {
  const rows = await prisma.match.findMany({
    select: {
      id: true,
      source: true,
      status: true,
      homeScore: true,
      awayScore: true,
      halfTimeHomeScore: true,
      halfTimeAwayScore: true,
      finishedAtUtc: true,
      homeTeamId: true,
      awayTeamId: true,
      scheduledKickoffUtc: true,
      excludedFromGeneration: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      _count: { select: { odds: true, predictions: true, couponSelections: true } },
    },
  });

  const groups = new Map<string, typeof rows>();
  for (const match of rows) {
    const key = `${match.homeTeamId}|${match.awayTeamId}|${match.scheduledKickoffUtc
      .toISOString()
      .slice(0, 10)}`;
    groups.set(key, [...(groups.get(key) ?? []), match]);
  }

  let merged = 0;
  let deleted = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // The real one is whichever the fixture provider owns; failing that, the
    // one that actually carries a result.
    const real =
      group.find((m) => m.source === 'api-football') ??
      group.find((m) => m.homeScore !== null);
    if (!real) continue;

    for (const phantom of group) {
      if (phantom.id === real.id) continue;

      const dependents =
        phantom._count.odds + phantom._count.predictions + phantom._count.couponSelections;

      const label = `${phantom.homeTeam.name} - ${phantom.awayTeam.name}`;
      if (dependents === 0) {
        console.log(`delete  ${label} (${phantom.source}, nothing depends on it)`);
        if (apply) await prisma.match.delete({ where: { id: phantom.id } });
        deleted++;
        continue;
      }

      console.log(
        `merge   ${label} (${phantom.source}) <- result ${real.homeScore}-${real.awayScore}` +
          ` [${dependents} dependent rows kept]`,
      );
      if (apply) {
        await prisma.match.update({
          where: { id: phantom.id },
          data: {
            status: real.status,
            homeScore: real.homeScore,
            awayScore: real.awayScore,
            halfTimeHomeScore: real.halfTimeHomeScore,
            halfTimeAwayScore: real.halfTimeAwayScore,
            finishedAtUtc: real.finishedAtUtc,
            // Never build anything new on a duplicate, and keep it out of the
            // listings that showed the same fixture twice.
            excludedFromGeneration: true,
          },
        });
      }
      merged++;
    }
  }

  console.log(`\n${apply ? 'applied' : 'dry run'}: ${merged} merged, ${deleted} deleted`);
  if (!apply) console.log('re-run with --apply to make the changes');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
