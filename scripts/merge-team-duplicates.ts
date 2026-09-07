import { PrismaClient } from '@prisma/client';
import { normalizeTeamName, similarity } from '../src/services/ingestion/team-resolver';

/**
 * Folds thin provider rows into the archive row that carries the club's history.
 *
 * The archive writes short names — "Dortmund", "Ath Madrid", "Nott'm Forest" —
 * and the fixture provider writes long ones. Where both exist as separate
 * teams, a discovered fixture attaches to whichever the name matched, and if
 * that is the empty one the engine skips the match for want of features. Forty
 * four clubs were split this way, which is most of why a slate of twenty
 * fixtures produced eleven predictions.
 *
 * History decides which row survives, and history lives in the archive. The
 * candidate must be nearly untouched (a couple of fixtures at most, so almost
 * nothing is lost if a pairing is wrong), in the same country, and the survivor
 * must actually have played.
 *
 *   npx tsx scripts/merge-team-duplicates.ts [--apply] [--min-similarity 0.6]
 */

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const minSimilarityArg = process.argv.indexOf('--min-similarity');
const MIN_SIMILARITY = minSimilarityArg >= 0 ? Number(process.argv[minSimilarityArg + 1]) : 0.6;

/** At most this many fixtures on the row being folded away. */
const MAX_MATCHES_ON_DUPLICATE = 2;
/** At least this many on the row that keeps them. */
const MIN_MATCHES_ON_SURVIVOR = 20;

async function main(): Promise<void> {
  const teams = await prisma.team.findMany({
    select: {
      id: true,
      name: true,
      source: true,
      country: true,
      _count: { select: { homeMatches: true, awayMatches: true } },
    },
  });

  const played = (t: (typeof teams)[number]) => t._count.homeMatches + t._count.awayMatches;
  const thin = teams.filter((t) => played(t) <= MAX_MATCHES_ON_DUPLICATE);
  const rich = teams.filter((t) => played(t) >= MIN_MATCHES_ON_SURVIVOR);

  const pairs: Array<{ drop: (typeof teams)[number]; keep: (typeof teams)[number]; score: number }> = [];

  /**
   * A reserve side is a different club, however similar the name.
   *
   * "Real Sociedad II" scores 0.64 against "Sociedad" and folding it in would
   * put a first team's history behind a B team's fixtures — the one kind of
   * wrong merge this scan can plausibly make.
   */
  const RESERVE = /\b(ii|b|c|u\s?1[6-9]|u\s?2[0-3]|res|reserves?|academy|youth)\b/i;

  for (const duplicate of thin) {
    if (RESERVE.test(duplicate.name)) {
      console.log(`skip  ${duplicate.name} — reads as a reserve or youth side`);
      continue;
    }
    const normalized = normalizeTeamName(duplicate.name);
    let best: { keep: (typeof teams)[number]; score: number } | null = null;

    for (const survivor of rich) {
      // A club does not change country. Without this, short names collide
      // across leagues and the merge would invent a history.
      if (duplicate.country && survivor.country && duplicate.country !== survivor.country) continue;
      const score = similarity(normalized, normalizeTeamName(survivor.name));
      if (!best || score > best.score) best = { keep: survivor, score };
    }

    if (best && best.score >= MIN_SIMILARITY) {
      pairs.push({ drop: duplicate, keep: best.keep, score: best.score });
    }
  }

  pairs.sort((a, b) => a.score - b.score);
  for (const pair of pairs) {
    console.log(
      `${pair.score.toFixed(2)}  ${pair.drop.name.padEnd(26)}(${played(pair.drop)})` +
        ` -> ${pair.keep.name} (${played(pair.keep)}, ${pair.keep.source})`,
    );
  }
  console.log(`\n${pairs.length} pairs at similarity >= ${MIN_SIMILARITY}`);

  if (!apply) {
    console.log('dry run — re-run with --apply');
    await prisma.$disconnect();
    return;
  }

  let merged = 0;
  for (const { drop, keep } of pairs) {
    await prisma.match.updateMany({ where: { homeTeamId: drop.id }, data: { homeTeamId: keep.id } });
    await prisma.match.updateMany({ where: { awayTeamId: drop.id }, data: { awayTeamId: keep.id } });

    // The folded spelling must keep resolving, or the next sync recreates it.
    const normalized = normalizeTeamName(drop.name);
    const claimed = await prisma.teamAlias.findFirst({
      where: { source: drop.source, normalized },
    });
    if (claimed) {
      await prisma.teamAlias.update({ where: { id: claimed.id }, data: { teamId: keep.id } });
    } else {
      await prisma.teamAlias.create({
        data: {
          teamId: keep.id,
          source: drop.source,
          alias: drop.name,
          normalized,
          confidence: 1,
          verified: false,
        },
      });
    }

    for (const alias of await prisma.teamAlias.findMany({ where: { teamId: drop.id } })) {
      const clash = await prisma.teamAlias.findFirst({
        where: { source: alias.source, normalized: alias.normalized, NOT: { id: alias.id } },
      });
      if (clash) await prisma.teamAlias.delete({ where: { id: alias.id } });
      else await prisma.teamAlias.update({ where: { id: alias.id }, data: { teamId: keep.id } });
    }

    // Derived rows rebuild themselves from the matches that just moved.
    await prisma.eloRating.deleteMany({ where: { teamId: drop.id } });
    await prisma.teamFormSnapshot.deleteMany({ where: { teamId: drop.id } });
    await prisma.teamSeason.deleteMany({ where: { teamId: drop.id } });
    await prisma.matchStatistic.deleteMany({ where: { teamId: drop.id } });
    await prisma.player.deleteMany({ where: { teamId: drop.id } });
    await prisma.team.delete({ where: { id: drop.id } });
    merged++;
  }

  console.log(`\nmerged ${merged} teams. Rebuild Elo next: the folded ratings are gone by design.`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
