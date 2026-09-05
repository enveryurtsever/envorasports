import { PrismaClient } from '@prisma/client';
import { serverEnv } from '../src/lib/env';

/**
 * Seeds the quota guard from API-Football's own /status.
 *
 * Our budget window is the UTC day; the provider's resets on its own schedule.
 * When they disagree the guard over-counts and refuses calls the provider is
 * happy to serve. One authoritative reading unblocks it, and from then on every
 * response carries the daily header and keeps it accurate.
 */
async function main() {
  const env = serverEnv();
  const base = env.FOOTBALL_API_BASE_URL.replace(/\/$/, '');
  const res = await fetch(`${base}/status`, { headers: { 'x-apisports-key': env.FOOTBALL_API_KEY } });
  const body = (await res.json()) as { response?: { requests?: { current: number; limit_day: number } } };

  const requests = body.response?.requests;
  if (!requests) throw new Error('provider did not report request counts');

  const remaining = Math.max(0, requests.limit_day - requests.current);
  const prisma = new PrismaClient();
  await prisma.providerRequestLog.create({
    data: {
      provider: 'api-football',
      endpoint: '/status',
      success: true,
      statusCode: res.status,
      cost: 1,
      quotaRemaining: remaining,
    },
  });
  console.log(`provider: ${requests.current}/${requests.limit_day} used -> ${remaining} remaining, recorded`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
