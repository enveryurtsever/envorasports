import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import { ResultBadge } from '@/components/ui/result-badge';
import { Modal } from '@/components/ui/modal';
import { AiAnalysis } from '@/components/predictions/ai-analysis';
import { referenceStakeFor } from '@/lib/format/currency';
import type { UnlockedCoupon } from '@/services/coupons/coupon-access';

const ACCENT: Record<string, 'emerald' | 'gold' | 'none'> = {
  HIGH_CONFIDENCE: 'emerald',
  BALANCED_PICKS: 'none',
  HIGH_VALUE: 'gold',
  COMBINATION_SYSTEM: 'gold',
};

/**
 * One prediction card, sized for a three-across grid.
 *
 * The written analysis is rendered on the server into a modal rather than
 * fetched on click, so opening it is instant and works without JavaScript
 * having to call back.
 */
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
  const tCat = await getTranslations('categories');
  const format = await getFormatter();
  const locale = await getLocale();

  const stake = referenceStakeFor(locale);
  const potentialReturn = coupon.totalOdds * stake.amount;

  return (
    <PremiumCard accent={ACCENT[coupon.category] ?? 'none'} className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="inline-block rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase">
            {tCat(`${coupon.category}.short`)}
          </span>
          <p className="mt-1.5 truncate text-[0.7rem] text-muted">
            {coupon.reference}
            {isPreview ? ` · ${te('freePreview')}` : ''}
          </p>
        </div>
        <ResultBadge status={coupon.resultStatus} />
      </div>

      <div className="flex items-baseline gap-2">
        <span className="tabular text-2xl leading-none font-semibold">
          {format.number(coupon.totalOdds, 'odds')}
        </span>
        <span className="text-xs text-muted">{t('totalOdds')}</span>
      </div>

      <p className="tabular text-sm text-gold-light">
        {format.number(potentialReturn, {
          style: 'currency',
          currency: stake.currency,
          maximumFractionDigits: 0,
        })}
        <span className="ml-1 text-[0.7rem] text-muted-dark">
          {te('perStake', {
            stake: format.number(stake.amount, {
              style: 'currency',
              currency: stake.currency,
              maximumFractionDigits: 0,
            }),
          })}
        </span>
      </p>

      <dl className="tabular grid grid-cols-3 gap-2 border-y border-white/10 py-2 text-center">
        <div>
          <dt className="text-[0.6rem] text-muted uppercase">{tm('confidence')}</dt>
          <dd className="text-sm font-semibold text-emerald-bright">
            {format.number(coupon.confidenceScore, 'percent')}
          </dd>
        </div>
        <div>
          <dt className="text-[0.6rem] text-muted uppercase">{t('estimatedProbability')}</dt>
          <dd className="text-sm font-semibold">
            {format.number(coupon.estimatedProbability, 'percent')}
          </dd>
        </div>
        <div>
          <dt className="text-[0.6rem] text-muted uppercase">{tm('ev')}</dt>
          <dd
            className={`text-sm font-semibold ${
              coupon.expectedValue >= 0 ? 'text-emerald-bright' : 'text-rose-300'
            }`}
          >
            {format.number(coupon.expectedValue, 'signedPercent')}
          </dd>
        </div>
      </dl>

      <ul className="flex-1 space-y-2">
        {coupon.selections.map((selection) => (
          <li key={selection.id} className="text-xs">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">
                {selection.match.homeTeam} – {selection.match.awayTeam}
              </span>
              <span className="tabular font-semibold">
                {format.number(selection.odds, 'odds')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-muted">
              <span className="min-w-0 flex-1 truncate">
                {format.dateTime(selection.match.kickoffUtc, 'kickoff')} · {selection.selectionCode}
              </span>
              {selection.resultStatus !== 'PENDING' ? (
                <ResultBadge status={selection.resultStatus} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      <Modal
        triggerLabel={t('openAnalysis')}
        closeLabel={t('closeAnalysis')}
        title={t('analysisFor', { reference: coupon.reference })}
        triggerClassName="w-full rounded-lg border border-white/15 px-3 py-2 text-xs font-medium transition-colors hover:border-emerald-bright hover:text-emerald-bright"
      >
        <AiAnalysis
          entityType="coupon"
          entityId={coupon.id}
          locale={locale === 'tr' ? 'tr' : 'en'}
          payload={{
            reference: coupon.reference,
            category: coupon.category,
            totalOdds: coupon.totalOdds,
            estimatedProbability: coupon.estimatedProbability,
            expectedValue: coupon.expectedValue,
            confidence: coupon.confidenceScore,
            risk: coupon.riskScore,
            selections: coupon.selections.map((s) => ({
              match: `${s.match.homeTeam} - ${s.match.awayTeam}`,
              league: s.match.league,
              market: s.marketCode,
              selection: s.selectionCode,
              odds: s.odds,
              probability: s.probability,
              impliedProbability: s.impliedProbability,
              edge: s.edge,
            })),
          }}
        />
      </Modal>
    </PremiumCard>
  );
}
