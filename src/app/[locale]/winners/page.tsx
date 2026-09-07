import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { getViewer } from '@/lib/auth/session';
import { getReferenceStake } from '@/lib/format/currency';
import { METRIC_TOKENS } from '@/lib/format/metric-tokens';
import { EmptyState, MetricCard, PremiumCard } from '@/components/ui/card';
import { formatSelection } from '@/lib/markets/labels';

export const dynamic = 'force-dynamic';

/**
 * Winners.
 *
 * Only settled coupons appear here, each with the date it was graded, so every
 * claim on this page can be checked against the prediction history. Nothing is
 * selected for looking good — it is simply every coupon that won.
 */
export default async function WinnersPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('winners');
  const tw = await getTranslations('weekly');
  const tCat = await getTranslations('categories');
  const tc = await getTranslations('common');
  const tm = await getTranslations('metrics');
  // Untyped root accessor: selection labels resolve their own keys.
  const translate = await getTranslations();
  const format = await getFormatter();

  const viewer = await getViewer();
  const stake = await getReferenceStake(locale);

  const [winners, totals] = await Promise.all([
    prisma.coupon.findMany({
      where: { resultStatus: { in: ['WON', 'PARTIAL_WIN'] } },
      orderBy: [{ settledAt: 'desc' }],
      take: 50,
      select: {
        id: true,
        reference: true,
        category: true,
        totalOdds: true,
        effectiveOdds: true,
        selectionCount: true,
        targetDate: true,
        settledAt: true,
        resultStatus: true,
        systemCoupon: {
          select: {
            systemSizes: true,
            columnCount: true,
            winningColumns: true,
            totalStake: true,
            totalReturn: true,
            currency: true,
          },
        },
        selections: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            odds: true,
            resultStatus: true,
            // What was actually predicted, and how strongly. A winners page
            // that shows only the price says what was paid but not what was
            // called, which is the part a reader is judging.
            marketCode: true,
            selectionCode: true,
            probability: true,
            match: {
              select: {
                homeScore: true,
                awayScore: true,
                homeTeam: { select: { name: true } },
                awayTeam: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    prisma.coupon.aggregate({
      where: { resultStatus: { in: ['WON', 'PARTIAL_WIN'] } },
      _count: true,
      _max: { totalOdds: true },
    }),
  ]);

  const money = (value: number, currency = stake.currency) =>
    format.number(value, { style: 'currency', currency, maximumFractionDigits: 2 });

  const returnOf = (coupon: (typeof winners)[number]) =>
    coupon.systemCoupon
      ? { amount: Number(coupon.systemCoupon.totalReturn), currency: coupon.systemCoupon.currency }
      : {
          amount: Number(coupon.effectiveOdds ?? coupon.totalOdds) * stake.amount,
          currency: stake.currency,
        };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">{t('subtitle')}</p>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <MetricCard icon="★" label={t('totalWins')} value={totals._count} tone="emerald" />
        <MetricCard
          icon="×"
          label={tw('bestWin')}
          value={totals._max.totalOdds ? format.number(Number(totals._max.totalOdds), 'odds') : '—'}
          tone="gold"
        />
        <MetricCard
          icon="₺"
          label={t('referenceStake')}
          value={money(stake.amount)}
          tone="muted"
          hint={t('referenceStakeHint')}
        />
      </div>

      {winners.length === 0 ? (
        <EmptyState title={tw('noWinsYet')} hint={t('emptyHint')} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {winners.map((coupon) => {
            const paid = returnOf(coupon);
            return (
              <PremiumCard key={coupon.id} accent="emerald" className="overflow-hidden p-0">
                {/* Result bar, as a slip reads: what it was, what it paid. */}
                <div className="flex flex-wrap items-center justify-between gap-2 bg-emerald-primary px-4 py-2.5">
                  <span className="text-sm font-bold text-white">
                    ({coupon.selectionCount} {tw('legs')}){' '}
                    {format.dateTime(coupon.settledAt ?? coupon.targetDate, {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="text-sm font-bold text-gold-light">
                    {money(paid.amount, paid.currency)} {t('won')}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-white/10 px-4 py-2 text-sm">
                  <span>
                    <span className="text-muted">{tCat(`${coupon.category}.short`)}</span>
                  </span>
                  <span>
                    <span className="text-muted">{t('totalOdds')} </span>
                    <span className={`tabular font-bold ${METRIC_TOKENS.odds.text}`}>
                      {format.number(Number(coupon.totalOdds), 'odds')}
                    </span>
                  </span>
                  <span>
                    {/* Mean leg probability, the same figure the coupon card
                        leads with. Not the chance the coupon came in — that is
                        already settled here, and it came in. */}
                    <span className="text-muted">{tm('legStrength')} </span>
                    <span className={`tabular font-bold ${METRIC_TOKENS.confidence.text}`}>
                      {format.number(
                        coupon.selections.length === 0
                          ? 0
                          : coupon.selections.reduce((sum, s) => sum + Number(s.probability), 0) /
                              coupon.selections.length,
                        'percent',
                      )}
                    </span>
                  </span>
                  {coupon.systemCoupon ? (
                    <>
                      <span>
                        <span className="text-muted">{t('system')} </span>
                        <span className="font-bold text-gold-light">
                          {coupon.systemCoupon.systemSizes.join(',')}
                        </span>
                      </span>
                      <span>
                        <span className="text-muted">{t('columns')} </span>
                        <span className="tabular font-semibold">
                          {coupon.systemCoupon.winningColumns}/{coupon.systemCoupon.columnCount}
                        </span>
                      </span>
                    </>
                  ) : null}
                  <span>
                    <span className="text-muted">{t('stake')} </span>
                    <span className="tabular font-semibold">
                      {money(
                        coupon.systemCoupon
                          ? Number(coupon.systemCoupon.totalStake)
                          : stake.amount,
                        paid.currency,
                      )}
                    </span>
                  </span>
                </div>

                <ul className="divide-y divide-white/5">
                  {coupon.selections.map((selection) => {
                    const winning =
                      selection.resultStatus === 'WON' || selection.resultStatus === 'HALF_WON';
                    return (
                      <li key={selection.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <span
                          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-bold ${
                            winning ? 'bg-emerald-primary text-white' : 'bg-rose-500 text-white'
                          }`}
                        >
                          {winning ? '✓' : '✕'}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {selection.match.homeTeam.name} {tc('vs')} {selection.match.awayTeam.name}
                          <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-[0.7rem] font-semibold whitespace-nowrap">
                            {formatSelection(translate, selection.marketCode, selection.selectionCode, {
                              home: selection.match.homeTeam.name,
                              away: selection.match.awayTeam.name,
                            })}
                          </span>
                        </span>
                        {selection.match.homeScore !== null ? (
                          <span className="tabular shrink-0 text-muted">
                            {selection.match.homeScore}-{selection.match.awayScore}
                          </span>
                        ) : null}
                        <span className={`tabular shrink-0 font-semibold ${METRIC_TOKENS.odds.text}`}>
                          {format.number(Number(selection.odds), 'odds')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </PremiumCard>
            );
          })}
        </div>
      )}

      {!viewer.userId ? <p className="text-xs text-muted-dark">{t('publicNote')}</p> : null}
    </div>
  );
}
