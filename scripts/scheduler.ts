import { PrismaClient } from '@prisma/client';
import { getBulletinSchedule } from '../src/lib/config/settings-service';
import {
  isPublicationDay,
  publicationRunAt,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';
import {
  runArchiveRefresh,
  runBulkOdds,
  runBulletinPublication,
  runDiscovery,
  runFeatureRebuild,
  runFixtureTopup,
  runMatchOddsSync,
  runHayal,
  runNarration,
  runInsight,
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
  const now = new Date();

  /**
   * A priced fixture the model has not spoken on is new work, whatever else
   * is on the slate. The old test — "is any upcoming match on a coupon?" —
   * was satisfied by one Thursday coupon while a hundred Saturday fixtures
   * arrived and were priced, and the site went into the weekend with
   * nothing: the publication had run on Thursday, before the free plan could
   * serve those days, and nothing asked it to look again.
   */
  const unpredicted = await prisma.match.findFirst({
    where: {
      status: 'SCHEDULED',
      excludedFromGeneration: false,
      scheduledKickoffUtc: { gt: now },
      odds: { some: {} },
      predictions: { none: { supersededAt: null } },
    },
    select: { id: true },
  });
  if (unpredicted) return true;

  const upcoming = await prisma.match.findFirst({
    where: { status: 'SCHEDULED', scheduledKickoffUtc: { gt: now } },
    select: { id: true },
  });
  if (!upcoming) return false;

  const covered = await prisma.couponSelection.findFirst({
    where: { match: { status: 'SCHEDULED', scheduledKickoffUtc: { gt: now } } },
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
        : runBulletinPublication({ force: true, refresh: true }),
  },
  {
    // Fills window days the provider's plan could not serve earlier.
    name: 'fixture-topup',
    everyMs: 6 * 60 * MINUTE,
    run: () => runFixtureTopup(),
  },
  {
    /**
     * The only source for most of a Turkish bulletin.
     *
     * Bulk pricing covers 1X2 and totals and nothing else, so double chance,
     * both-teams-to-score, half-time result, HT/FT and the goal ladder come
     * from here or not at all — moving pricing wholesale to the odds provider
     * silently emptied five markets and left Banko with two legs.
     *
     * Affordable again because results are fetched by date now: one or two
     * requests a day, against a hundred.
     */
    name: 'match-odds',
    everyMs: 4 * 60 * MINUTE,
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
    /**
     * Before the narration, so the analyses describe the news-adjusted view.
     * Hourly is the cadence of team news; the pass reads only what is due.
     */
    name: 'insight',
    everyMs: 60 * MINUTE,
    run: () => runInsight(),
  },
  {
    name: 'rebuild-features',
    everyMs: 24 * 60 * MINUTE,
    run: () => runFeatureRebuild(),
  },
  {
    /**
     * The archive is rewritten as results come in, and it is where the models'
     * history lives. Unmetered, so weekly costs nothing; the run key is the ISO
     * week, so a restart does not re-import what this week already pulled.
     */
    name: 'archive-refresh',
    everyMs: 12 * 60 * MINUTE,
    run: () => runArchiveRefresh(),
  },
  {
    /**
     * Twelve hours, which is a budget decision rather than a cadence one.
     *
     * Judging stored prices is free, but the same job also buys the half-time
     * markets no other job fetches, at four credits a fixture. With one
     * fixture a run that is eight credits a day: the 99 credits left this
     * month carry it twelve days, and a fresh 500 carries a full month at 240
     * while leaving the bulk pricing its share. Running it every half hour
     * would have spent the month in a day.
     */
    name: 'hayal',
    everyMs: 12 * 60 * MINUTE,
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
