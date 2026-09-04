import { getFormatter, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import { ResultBadge } from '@/components/ui/result-badge';
import type { UnlockedCoupon } from '@/services/coupons/coupon-access';

/** One prediction card (§20). Every figure comes from the stored coupon. */
export async function CouponCard({
  coupon,
  isPreview = false,
}: {
  coupon: UnlockedCoupon;
  isPreview?: boolean;
}) {
  const t = await getTranslations('predictions');
  const tm = await getTranslations('metrics');
  const te = await getTranslations('entitlement');
  const format = await getFormatter();

  return (
    <PremiumCard accent={isPreview ? 'gold' : 'emerald'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs tracking-wide text-muted uppercase">
            {coupon.reference}
            {isPreview ? ` · ${te('freePreview')}` : ''}
          </p>
          <p className="tabular mt-1 text-xl font-semibold">
            {t('totalOdds')} {format.number(coupon.totalOdds, 'odds')}
          </p>
        </div>
        <ResultBadge status={coupon.resultStatus} />
      </div>

      <dl className="tabular mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted uppercase">{tm('confidence')}</dt>
          <dd className="font-semibold">{format.number(coupon.confidenceScore, 'percent')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted uppercase">{t('estimatedProbability')}</dt>
          <dd className="font-semibold">{format.number(coupon.estimatedProbability, 'percent')}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted uppercase">{tm('ev')}</dt>
          <dd className="font-semibold text-emerald-bright">
            {format.number(coupon.expectedValue, 'signedPercent')}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted uppercase">{tm('risk')}</dt>
          <dd className="font-semibold">{format.number(coupon.riskScore, 'percent')}</dd>
        </div>
      </dl>

      <ul className="mt-4 divide-y divide-white/10 rounded-lg border border-white/10">
        {coupon.selections.map((selection) => (
          <li key={selection.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {selection.match.homeTeam} – {selection.match.awayTeam}
              </p>
              <p className="text-xs text-muted">
                {selection.match.league} · {format.dateTime(selection.match.kickoffUtc, 'kickoff')}
              </p>
            </div>
            <span className="text-xs text-muted">{selection.marketCode}</span>
            <span className="tabular text-sm font-semibold">
              {format.number(selection.odds, 'odds')}
            </span>
            <ResultBadge status={selection.resultStatus} />
          </li>
        ))}
      </ul>
    </PremiumCard>
  );
}
