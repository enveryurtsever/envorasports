import { PrismaClient } from '@prisma/client';
import { getBulletinSchedule } from '../src/lib/config/settings-service';
import {
  isPublicationDay,
  publicationRunAt,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';
import {
  runBulkOdds,
  runBulletinPublication,
  runDiscovery,
  runFeatureRebuild,
  runFixtureTopup,
  runMatchOddsSync,
  runHayal,
  runNarration,
  runResultSync,
  runSettlementSweep,
} from '../src/services/jobs/registry';

/**
 * Local scheduler for extended testing.
 *
 * Long-running process that ticks once a minute and fires each job when it is
 * due. It calls the job registry directly, so it needs no web server and no
 * external cron — `npm run scheduler` and leave it running.
 *
 * Every job is idempotent and carries its own lock, so a duplicate tick, a
 * restart mid-run, or running this alongside a manual trigger are all safe.
 * Jobs that spend provider quota check it before every call.
 */

const prisma = new PrismaClient();

const MINUTE = 60_000;

interface ScheduledJob {
  name: string;
  everyMs: number;
  run: () => Promise<{ status: string; reason?: string; itemsProcessed?: number }>;
  /** Extra gate beyond the interval. */
  when?: () => Promise<boolean>;
}

const lastRun = new Map<string, number>();

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(message: string, detail?: unknown): void {
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
  console.log(`[${stamp()}] ${message}${suffix}`);
}

/**
 * The publication is due once its local publish time has passed on a
 * publication day. The job itself is keyed on the publication date, so a second
 * attempt the same day is skipped rather than duplicated.
 */
async function scheduledPublicationDue(): Promise<boolean> {
  const schedule = await getBulletinSchedule();
  if (!schedule.enabled) return false;

  const today = todayInSchedule(schedule);
  if (!isPublicationDay(today, schedule)) return false;

  return publicationRunAt(today, schedule).getTime() <= Date.now();
}

async function publicationIsDue(): Promise<boolean> {
  const schedule = await getBulletinSchedule();
  if (!schedule.enabled) return false;

  return (await scheduledPublicationDue()) || uncoveredFixturesExist();
}

/**
 * True when fixtures are waiting that no coupon covers.
 *
 * The bulletin is not a weekly event in practice: a day's matches finish and
 * the next day's arrive, and waiting for the next publication day leaves the
 * site showing yesterday's slate. The publication job is keyed on its date and
 * takes a lock, so asking it to run when there is new work is safe — it becomes
 * a no-op when there is nothing to do.
 */
async function uncoveredFixturesExist(): Promise<boolean> {
  const upcoming = await prisma.match.findMany({
    where: { status: 'SCHEDULED', scheduledKickoffUtc: { gt: new Date() } },
    select: { scheduledKickoffUtc: true },
    take: 200,
  });
  if (upcoming.length === 0) return false;

  const covered = await prisma.couponSelection.findFirst({
    where: { match: { status: 'SCHEDULED', scheduledKickoffUtc: { gt: new Date() } } },
    select: { id: true },
  });

  // Nothing upcoming is on a coupon: either the slate has all been played out
  // or new fixtures have arrived since it was built.
  return covered === null;
}

const JOBS: ScheduledJob[] = [
  {
    /**
     * Costs nothing. The Odds API meters odds, not enumeration, so finding out
     * what football exists is free and can run on a short interval — which is
     * what stopped the 100-a-day fixture budget paying for discovery.
     */
    name: 'discovery',
    everyMs: 60 * MINUTE,
    run: () => runDiscovery(),
  },
  {
    // Prices whole competitions at once: measured at 2 credits for 22 priced
    // events, against 22 requests of a hard 100/day on the other provider.
    name: 'bulk-odds',
    everyMs: 4 * 60 * MINUTE,
    run: () => runBulkOdds(),
  },
  {
    name: 'bulletin-publication',
    everyMs: 10 * MINUTE,
    when: publicationIsDue,
    /**
     * The scheduled run is keyed on its publication date and skips once done.
     * A run triggered by new fixtures has to force, or the day's key stops it —
     * and forcing is safe: generation replaces its own pending coupons and
     * leaves settled ones alone.
     */
    run: async () =>
      (await scheduledPublicationDue())
        ? runBulletinPublication()
        : runBulletinPublication({ force: true }),
  },
  {
    // Fills window days the provider's plan could not serve earlier.
    name: 'fixture-topup',
    everyMs: 6 * 60 * MINUTE,
    run: () => runFixtureTopup(),
  },
  {
    /**
     * Fallback only, now that bulk odds carry the slate.
     *
     * It spends the fixture provider's hard budget one fixture at a time — 219
     * of 100 requests in a day, at its worst — so it runs rarely and exists for
     * the case where the odds provider's monthly credits run out entirely.
     */
    name: 'match-odds',
    everyMs: 12 * 60 * MINUTE,
    run: () => runMatchOddsSync(),
  },
  {
    // Self-throttles per match: costs nothing when nothing is due.
    name: 'result-sync',
    everyMs: 10 * MINUTE,
    run: () => runResultSync(),
  },
  {
    name: 'settlement',
    everyMs: 20 * MINUTE,
    run: () => runSettlementSweep(),
  },
  {
    // Cheap when everything is already cached, so it can run often: a fresh
    // publication gets its analyses written well before anyone opens a card.
    name: 'narrate-analyses',
    everyMs: 60 * MINUTE,
    run: () => runNarration(),
  },
  {
    name: 'rebuild-features',
    everyMs: 24 * 60 * MINUTE,
    run: () => runFeatureRebuild(),
  },
  {
    // Reads stored prices only, so it costs no provider quota and can run
    // often enough to catch a fixture the moment its signal market is priced.
    name: 'hayal',
    everyMs: 30 * MINUTE,
    run: () => runHayal(),
  },
];

async function tick(): Promise<void> {
  const now = Date.now();

  for (const job of JOBS) {
    const previous = lastRun.get(job.name) ?? 0;
    if (now - previous < job.everyMs) continue;

    if (job.when) {
      try {
        if (!(await job.when())) continue;
      } catch (error) {
        log(`${job.name}: gate failed`, String(error));
        continue;
      }
    }

    lastRun.set(job.name, now);

    try {
      const outcome = await job.run();
      // A skip is normal — not a publication day, quota exhausted, already
      // done. Only surface it when it carries a reason worth reading.
      if (outcome.status === 'SKIPPED') {
        log(`${job.name}: skipped`, outcome.reason);
      } else {
        log(`${job.name}: ${outcome.status}`, { processed: outcome.itemsProcessed ?? 0 });
      }
    } catch (error) {
      // A job should never throw here, but the scheduler must survive it if it
      // does — a month of testing cannot end because one tick failed.
      log(`${job.name}: threw`, String(error));
    }
  }
}

async function main(): Promise<void> {
  const schedule = await getBulletinSchedule();

  log('scheduler started', {
    timezone: schedule.timezone,
    publicationWeekdays: schedule.publicationWeekdays,
    coverageDays: schedule.coverageDays,
    publishTimeLocal: schedule.publishTimeLocal,
  });
  log('jobs', JOBS.map((j) => `${j.name} every ${Math.round(j.everyMs / MINUTE)}m`));

  // Run one pass immediately so a restart does not wait for the first interval.
  await tick();

  const timer = setInterval(() => {
    void tick();
  }, MINUTE);

  const shutdown = async (signal: string) => {
    log(`received ${signal}, stopping`);
    clearInterval(timer);
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (error) => {
  console.error('Scheduler failed to start:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
