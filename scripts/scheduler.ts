import { PrismaClient } from '@prisma/client';
import { getBulletinSchedule } from '../src/lib/config/settings-service';
import {
  isPublicationDay,
  publicationRunAt,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';
import {
  runBulletinPublication,
  runFeatureRebuild,
  runFixtureTopup,
  runMatchOddsSync,
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
async function publicationIsDue(): Promise<boolean> {
  const schedule = await getBulletinSchedule();
  if (!schedule.enabled) return false;

  const today = todayInSchedule(schedule);
  if (!isPublicationDay(today, schedule)) return false;

  return publicationRunAt(today, schedule).getTime() <= Date.now();
}

const JOBS: ScheduledJob[] = [
  {
    name: 'bulletin-publication',
    everyMs: 10 * MINUTE,
    when: publicationIsDue,
    run: () => runBulletinPublication(),
  },
  {
    // Fills window days the provider's plan could not serve earlier.
    name: 'fixture-topup',
    everyMs: 6 * 60 * MINUTE,
    run: () => runFixtureTopup(),
  },
  {
    // One request per fixture against a 100/day allowance, so four times a day
    // keeps prices current without crowding out fixtures and result sync.
    name: 'match-odds',
    everyMs: 6 * 60 * MINUTE,
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
