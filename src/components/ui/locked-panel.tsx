import { getFormatter, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { PremiumCard } from './card';
import type { CouponCategory } from '@/lib/config/coupon-settings';
import type { HiddenSummary } from '@/services/coupons/coupon-access';

/**
 * The locked view of a category, or of the remainder after a free preview.
 *
 * The blurred rows are placeholders, not concealed content: the server never
 * sent those selections, so there is nothing here to recover from the payload
 * (§23). What is shown is the shape of the offer — how many predictions, the
 * odds band and the best possible return.
 */
export async function LockedPanel({
  category,
  summary,
  variant = 'locked',
}: {
  category: CouponCategory;
  summary: HiddenSummary;
  variant?: 'locked' | 'remainder';
}) {
  const t = await getTranslations('entitlement');
  const tCat = await getTranslations('categories');
  const tp = await getTranslations('predictions');
  const format = await getFormatter();

  const planName = summary.requiredPlan ?? 'ELITE';
  const money = (value: number) =>
    format.number(value, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  return (
    <PremiumCard accent="gold" className="relative overflow-hidden">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold">
            {variant === 'remainder' ? t('remainingTitle') : tCat(`${category}.name`)}
          </h3>
          <p className="mt-1 text-sm text-muted">{tp('count', { count: summary.count })}</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-0.5 text-xs font-medium text-gold-light">
          <span aria-hidden>🔒</span>
          {t('locked')}
        </span>
      </div>

      {/* Exactly what a locked viewer is allowed to see: totals and best return. */}
      <dl className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-muted uppercase">{tp('totalOdds')}</dt>
          <dd className="tabular mt-0.5 text-lg font-semibold">
            {summary.minTotalOdds !== null && summary.maxTotalOdds !== null
              ? `${format.number(summary.minTotalOdds, 'odds')} – ${format.number(summary.maxTotalOdds, 'odds')}`
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted uppercase">{t('maxReturn')}</dt>
          <dd className="tabular mt-0.5 text-lg font-semibold text-gold-light">
            {money(summary.maxPotentialReturn)}
          </dd>
          <dd className="text-[0.7rem] text-muted-dark">
            {t('perStake', { stake: money(summary.referenceStake) })}
          </dd>
        </div>
      </dl>

      <div aria-hidden className="mt-5 space-y-2 blur-[5px] select-none">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/5 p-3">
            <div className="h-3 flex-1 rounded bg-white/20" />
            <div className="h-3 w-16 rounded bg-white/15" />
            <div className="h-3 w-10 rounded bg-emerald-primary/40" />
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href="/pricing"
          className="rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-ink transition-opacity hover:opacity-90"
        >
          {t('upgradeTo', { plan: planName })}
        </Link>
        <p className="text-xs text-muted">{t('lockedHint')}</p>
      </div>
    </PremiumCard>
  );
}
