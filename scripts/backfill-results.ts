import { PrismaClient } from '@prisma/client';
import { serverEnv } from '../src/lib/env';

/**
 * One-off backfill of finished-match results.
 *
 * The scheduled path goes through the quota guard, which is currently
 * over-counting against a provider window that resets on its own schedule. This
 * asks the provider directly for the specific fixtures a settlement is waiting
 * on, records every call it makes, and stops when the provider says stop.
 */
const STATUS_MAP: Record<string, string> = {
  FT: 'FINISHED', AET: 'FINISHED', PEN: 'FINISHED',
  PST: 'POSTPONED', CANC: 'CANCELED', ABD: 'ABANDONED', AWD: 'AWARDED', WO: 'AWARDED',
  '1H': 'LIVE', '2H': 'LIVE', HT: 'HALF_TIME', NS: 'SCHEDULED',
};

async function main() {
  const env = serverEnv();
  const base = env.FOOTBALL_API_BASE_URL.replace(/\/$/, '');
  const prisma = new PrismaClient();

  const pending = await prisma.match.findMany({
    where: {
      status: { in: ['SCHEDULED', 'LIVE', 'HALF_TIME'] },
      scheduledKickoffUtc: { lt: new Date(Date.now() - 105 * 60_000), gte: new Date(Date.now() - 3 * 864e5) },
    },
    select: { id: true, externalId: true, homeTeam: { select: { name: true } }, awayTeam: { select: { name: true } } },
    orderBy: { scheduledKickoffUtc: 'desc' },
    take: Number(process.argv[2] ?? 12),
  });

  console.log(`bitmiş olması gereken ${pending.length} maç sorgulanıyor`);
  let updated = 0;

  for (const match of pending) {
    const res = await fetch(`${base}/fixtures?id=${match.externalId}`, {
      headers: { 'x-apisports-key': env.FOOTBALL_API_KEY },
    });
    const remaining = Number(res.headers.get('x-ratelimit-requests-remaining'));

    await prisma.providerRequestLog.create({
      data: {
        provider: 'api-football', endpoint: '/fixtures', success: res.ok,
        statusCode: res.status, cost: 1,
        quotaRemaining: Number.isFinite(remaining) ? remaining : null,
      },
    });

    if (!res.ok) { console.log(`  ${res.status} — durduruldu`); break; }

    const body = (await res.json()) as { response?: Array<Record<string, never>> };
    const fx = body.response?.[0] as
      | { fixture: { status: { short: string } }; goals: { home: number | null; away: number | null };
          score: { halftime: { home: number | null; away: number | null } } }
      | undefined;
    if (!fx) continue;

    const status = STATUS_MAP[fx.fixture.status.short] ?? 'SCHEDULED';
    if (status === 'SCHEDULED') continue;

    await prisma.match.update({
      where: { id: match.id },
      data: {
        status: status as never,
        homeScore: fx.goals.home,
        awayScore: fx.goals.away,
        halfTimeHomeScore: fx.score.halftime.home,
        halfTimeAwayScore: fx.score.halftime.away,
        finishedAtUtc: status === 'FINISHED' ? new Date() : null,
        resultLastSyncedAt: new Date(),
      },
    });
    updated++;
    console.log(`  ${match.homeTeam.name} ${fx.goals.home}-${fx.goals.away} ${match.awayTeam.name}  [${status}]`);
  }

  console.log(`güncellenen: ${updated}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
