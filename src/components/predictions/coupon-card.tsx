import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { PremiumCard } from '@/components/ui/card';
import { getReferenceStake } from '@/lib/format/currency';
import { METRIC_TOKENS } from '@/lib/format/metric-tokens';
import { formatSelection } from '@/lib/markets/labels';
import { KickoffCountdown } from '@/components/predictions/kickoff-countdown';
import { cn } from '@/lib/format/cn';
import type { UnlockedCoupon } from '@/services/coupons/coupon-access';

const ACCENT: Record<string, 'emerald' | 'gold' | 'none'> = {
  HIGH_CONFIDENCE: 'emerald',
  BALANCED_PICKS: 'none',
  HIGH_VALUE: 'gold',
  COMBINATION_SYSTEM: 'gold',
};

/** A settled leg reads at a glance; a pending one stays quiet. */
const LEG_MARK: Record<string, { glyph: string; className: string }> = {
  WON: { glyph: '✓', className: 'bg-emerald-primary text-white' },
  HALF_WON: { glyph: '✓', className: 'bg-emerald-primary/70 text-white' },
  LOST: { glyph: '✕', className: 'bg-rose-500 text-white' },
  HALF_LOST: { glyph: '✕', className: 'bg-rose-500/70 text-white' },
  VOID: { glyph: '—', className: 'bg-white/20 text-paper' },
  PUSHED: { glyph: '=', className: 'bg-sky-500/70 text-white' },
  CANCELED: { glyph: '—', className: 'bg-white/20 text-paper' },
};

/**
 * One prediction card, sized for a three-across grid.
 *
 * A won coupon is unmistakable: green banner, the amount in gold, and a tick
 * beside each leg that landed. A pending one shows the price, the outlay and
 * the best case, which are the three numbers a reader actually wants.
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
  const ts = await getTranslations('status');
  const format = await getFormatter();
  const locale = await getLocale();
  const translate = await getTranslations();

  const stake = await getReferenceStake(locale);

  // A system's stake is its own: columns x stake per column. A straight coupon
  // is quoted against the configured reference stake.
  const couponStake = coupon.system ? coupon.system.totalStake : stake.amount;
  const currency = coupon.system ? coupon.system.currency : stake.currency;

  // Best case for a system is every column landing, which is the sum of the
  // columns' own returns — not the accumulator odds times the stake.
  const potentialReturn = coupon.system
    ? coupon.system.maxReturn
    : coupon.totalOdds * stake.amount;

  const won = coupon.resultStatus === 'WON' || coupon.resultStatus === 'PARTIAL_WIN';
  const settled = coupon.resultStatus !== 'PENDING';

  const wonAmount = coupon.system
    ? coupon.system.totalReturn
    : (coupon.effectiveOdds ?? coupon.totalOdds) * stake.amount;

  const money = (value: number) =>
    format.number(value, { style: 'currency', currency, maximumFractionDigits: 2 });

  return (
    <PremiumCard
      accent={won ? 'emerald' : (ACCENT[coupon.category] ?? 'none')}
      className={cn('flex h-full flex-col gap-3 p-0', won && 'ring-1 ring-emerald-primary/50')}
    >
      {/* Won banner, modelled on a real slip: result left, amount right. */}
      {won ? (
        <div className="flex items-center justify-between gap-2 rounded-t-[--radius-card] bg-emerald-primary px-4 py-2.5">
          <span className="text-sm font-bold tracking-wide text-white">
            ({t('legCount', { count: coupon.selections.length })}){' '}
            {format.dateTime(coupon.settledAt ?? coupon.targetDate, {
              day: '2-digit',
              month: '2-digit',
              year: 'numeric',
            })}
          </span>
          <span className="text-sm font-bold text-gold-light">
            {money(wonAmount)} {ts('WON')}
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-3 px-4 pt-4 pb-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="inline-block rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase">
                {tCat(`${coupon.category}.short`)}
              </span>
              {isPreview ? (
                <span className="inline-block rounded-full border border-emerald-primary/40 bg-emerald-primary/10 px-2 py-0.5 text-[0.65rem] font-medium text-emerald-bright">
                  {te('freePreview')}
                </span>
              ) : null}
            </span>

            <KickoffCountdown
              firstKickoffIso={coupon.firstKickoffUtc.toISOString()}
              lastKickoffIso={coupon.lastKickoffUtc.toISOString()}
              settled={settled}
              className="text-[0.7rem] font-medium"
            />
          </div>

          {/* The headline number: the chance every leg lands together. A lost
              coupon says so instead — the result outranks the estimate. */}
          {settled && !won ? (
            <span className="shrink-0 rounded-full border border-rose-500/50 bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-300">
              {ts(coupon.resultStatus)}
            </span>
          ) : (
            <span
              className={cn(
                'shrink-0 rounded-lg border px-2.5 py-1 text-center',
                METRIC_TOKENS.modelProbability.border,
                METRIC_TOKENS.modelProbability.bg,
              )}
            >
              <span className="block text-[0.55rem] leading-none tracking-wide text-muted uppercase">
                {/* A system pays out when its smallest size lands, not when
                    every leg does, so its number answers a different question
                    and must not be read as the chance of the maximum return. */}
                {coupon.system ? tm('returnProbability') : tm('winProbability')}
              </span>
              <span
                className={cn(
                  'tabular mt-0.5 block text-base leading-none font-bold',
                  METRIC_TOKENS.modelProbability.text,
                )}
              >
                {format.number(coupon.estimatedProbability, 'percent')}
              </span>
            </span>
          )}
        </div>

        {/* Price and best case side by side. The payout is what a reader
            actually compares between coupons, so the odds are set a size
            smaller rather than competing with it. */}
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="min-w-0">
            <span className="block text-[0.6rem] tracking-wide text-muted uppercase">
              {t('totalOdds')}
            </span>
            <span
              className={cn(
                'tabular block truncate text-base leading-tight font-bold',
                METRIC_TOKENS.odds.text,
              )}
            >
              {format.number(coupon.totalOdds, 'odds')}
            </span>
          </div>

          <div className="min-w-0 text-right">
            <span className="block text-[0.6rem] tracking-wide text-muted uppercase">
              {te('maxReturn')}
            </span>
            <span
              className={cn(
                'tabular block truncate text-lg leading-tight font-bold',
                METRIC_TOKENS.payout.text,
              )}
            >
              {money(potentialReturn)}
            </span>
          </div>
        </div>

        {/* Each leg is two lines of its own, so without a rule between them the
            second line of one match reads as part of the next. */}
        <ul className="flex-1 divide-y divide-white/10">
          {coupon.selections.map((selection) => {
            const mark = LEG_MARK[selection.resultStatus];
            const score =
              selection.match.homeScore !== null && selection.match.awayScore !== null
                ? `${selection.match.homeScore}-${selection.match.awayScore}`
                : null;

            return (
              <li
                key={selection.id}
                className="flex items-start gap-2 py-2 text-xs first:pt-0 last:pb-0"
              >
                <span
                  aria-label={mark ? ts(selection.resultStatus) : undefined}
                  className={cn(
                    'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-[0.6rem] font-bold',
                    mark?.className ?? 'bg-white/10 text-muted',
                  )}
                >
                  {mark?.glyph ?? '·'}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {selection.match.homeTeam} – {selection.match.awayTeam}
                    </span>
                    {score ? <span className="tabular shrink-0 text-muted">{score}</span> : null}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="shrink-0 text-muted">
                      {format.dateTime(selection.match.kickoffUtc, 'kickoff')}
                    </span>
                    <span className="truncate rounded border border-white/20 bg-white/10 px-1.5 py-0.5 text-[0.65rem] font-semibold text-paper">
                      {formatSelection(translate, selection.marketCode, selection.selectionCode, {
                        home: selection.match.homeTeam,
                        away: selection.match.awayTeam,
                      })}
                    </span>
                  </span>
                </span>

                {/* The odds get their own fixed column, centred on the two
                    lines of the leg, so they read down the card as one column
                    instead of drifting with the length of each team name. */}
                <span
                  className={cn(
                    'tabular w-12 shrink-0 self-center text-center font-semibold',
                    METRIC_TOKENS.odds.text,
                  )}
                >
                  {format.number(selection.odds, 'odds')}
                </span>
              </li>
            );
          })}
        </ul>

        {/* Foot of the card, the way a slip prints it: what was played on the
            left, what it cost on the right. */}
        <div className="flex items-end justify-between gap-2 border-t border-white/10 pt-2">
          <span className="min-w-0 truncate text-[0.7rem] leading-tight font-semibold text-gold-light">
            {coupon.system
              ? `${t('systemLabel', { label: coupon.system.systemLabel })}${
                  won
                    ? ` · ${t('columnsWon', {
                        won: coupon.system.winningColumns,
                        total: coupon.system.columnCount,
                      })}`
                    : ''
                }`
              : ''}
          </span>

          <span className="shrink-0 text-right">
            <span className="block text-[0.6rem] tracking-wide text-muted uppercase">
              {t('couponStake')}
            </span>
            <span className="tabular block text-base leading-tight font-bold">
              {money(couponStake)}
            </span>
          </span>
        </div>

      </div>
    </PremiumCard>
  );
}
