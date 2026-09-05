import { syncMatchOddsForWindow } from '../src/services/ingestion/match-odds-sync';
import { getBulletinSchedule } from '../src/lib/config/settings-service';
import {
  coverageWindow,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';

/** Pulls the full market set for the active bulletin window. One call/fixture. */
async function main() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const publication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });

  const max = process.argv[2] ? Number(process.argv[2]) : undefined;
  const window = coverageWindow(publication, schedule);
  console.log(`window ${window.startUtc.toISOString()} -> ${window.endUtc.toISOString()}`);

  const result = await syncMatchOddsForWindow(window, max ? { maxFixtures: max } : {});
  console.log(
    `considered=${result.fixturesConsidered} requested=${result.fixturesRequested} ` +
      `priced=${result.fixturesPriced} prices=${result.pricesStored} quota=${result.quotaRemaining}`,
  );
  console.log('markets:', result.marketsSeen.join(', ') || '(none)');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
