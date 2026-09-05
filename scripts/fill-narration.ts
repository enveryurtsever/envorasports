import { PrismaClient } from '@prisma/client';
import { narrateWindow } from '../src/services/narration/narration-job';
import { getBulletinSchedule } from '../src/lib/config/settings-service';
import {
  coverageWindow,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';

/** Fills the narration cache for the active window. Paced against the rate limit. */
const prisma = new PrismaClient();

async function main() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const publication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });

  const max = process.argv[2] ? Number(process.argv[2]) : 16;
  const result = await narrateWindow(coverageWindow(publication, schedule), { maxPerRun: max });

  console.log(
    `coupons+matches considered=${result.considered} calls=${result.callsMade} ` +
      `fromModel=${result.generated} fromTemplate=${result.fromTemplate}`,
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
