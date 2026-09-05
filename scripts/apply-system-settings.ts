import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_SYSTEM_SETTINGS } from '../src/lib/config/coupon-settings';

/** Pushes the coded system-slate defaults into the stored settings row. */
const p = new PrismaClient();

async function main() {
  const d = DEFAULT_SYSTEM_SETTINGS;
  const row = await p.systemCouponSetting.findFirst({ select: { id: true } });
  if (!row) throw new Error('no system settings row to update');

  await p.systemCouponSetting.update({
    where: { id: row.id },
    data: {
      couponCount: d.couponCount,
      stakePerColumn: new Prisma.Decimal(d.stakePerColumn),
      minBaseSelections: d.minBaseSelections,
      maxBaseSelections: d.maxBaseSelections,
      minCombinedProbability: new Prisma.Decimal(d.minCombinedProbability),
    },
  });

  console.log(
    `system: ${d.couponCount} kupon, ${d.stakePerColumn} ${d.currency}/kolon, ` +
      `taban ${d.minBaseSelections}-${d.maxBaseSelections}`,
  );
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => p.$disconnect());
