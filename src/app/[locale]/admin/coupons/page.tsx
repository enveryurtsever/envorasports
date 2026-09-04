import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { availableAdditions } from '@/services/coupons/coupon-editor';
import { EmptyState, SectionHeading } from '@/components/ui/card';
import { CouponEditor } from './coupon-editor-ui';

export const dynamic = 'force-dynamic';

/** Operator view of the generated coupons, with editing (§39). */
export default async function AdminCouponsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const tp = await getTranslations('predictions');
  const format = await getFormatter();

  const coupons = await prisma.coupon.findMany({
    orderBy: [{ targetDate: 'desc' }, { reference: 'asc' }],
    take: 40,
    select: {
      id: true,
      reference: true,
      category: true,
      kind: true,
      resultStatus: true,
      targetDate: true,
      totalOdds: true,
      estimatedProbability: true,
      expectedValue: true,
      selectionCount: true,
      selections: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          marketCode: true,
          selectionCode: true,
          odds: true,
          probability: true,
          resultStatus: true,
          match: {
            select: {
              scheduledKickoffUtc: true,
              homeTeam: { select: { name: true } },
              awayTeam: { select: { name: true } },
            },
          },
        },
      },
      systemCoupon: { select: { systemType: true, columnCount: true, totalStake: true } },
    },
  });

  // Candidates are only offered for coupons that can still be edited.
  const additions = await Promise.all(
    coupons.map(async (coupon) =>
      coupon.resultStatus === 'PENDING'
        ? { couponId: coupon.id, options: await availableAdditions(coupon.id, 25) }
        : { couponId: coupon.id, options: [] },
    ),
  );
  const additionsById = new Map(additions.map((a) => [a.couponId, a.options]));

  return (
    <div className="space-y-6">
      <SectionHeading title={t('couponEditor')} description={t('couponEditorHint')} />

      {coupons.length === 0 ? (
        <EmptyState title={tp('noneForCategory')} hint={tp('noneForCategoryHint')} />
      ) : (
        coupons.map((coupon) => (
          <CouponEditor
            key={coupon.id}
            coupon={{
              id: coupon.id,
              reference: coupon.reference,
              category: coupon.category,
              kind: coupon.kind,
              resultStatus: coupon.resultStatus,
              targetDate: format.dateTime(coupon.targetDate, {
                day: '2-digit',
                month: 'short',
                timeZone: 'UTC',
              }),
              totalOdds: Number(coupon.totalOdds),
              estimatedProbability: Number(coupon.estimatedProbability),
              expectedValue: Number(coupon.expectedValue),
              selectionCount: coupon.selectionCount,
              system: coupon.systemCoupon
                ? {
                    systemType: coupon.systemCoupon.systemType,
                    columnCount: coupon.systemCoupon.columnCount,
                    totalStake: Number(coupon.systemCoupon.totalStake),
                  }
                : null,
              selections: coupon.selections.map((s) => ({
                id: s.id,
                label: `${s.match.homeTeam.name} – ${s.match.awayTeam.name}`,
                kickoff: format.dateTime(s.match.scheduledKickoffUtc, 'kickoff'),
                marketCode: s.marketCode,
                selectionCode: s.selectionCode,
                odds: Number(s.odds),
                probability: Number(s.probability),
                resultStatus: s.resultStatus,
              })),
            }}
            additions={(additionsById.get(coupon.id) ?? []).map((a) => ({
              predictionId: a.predictionId,
              label: `${a.label} · ${a.selectionCode} @ ${a.odds.toFixed(2)}`,
            }))}
          />
        ))
      )}
    </div>
  );
}
