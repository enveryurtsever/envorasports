import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { EmptyState, MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function BacktestPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('backtest');
  const tm = await getTranslations('metrics');
  const format = await getFormatter();

  const backtests = await prisma.backtest.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { modelVersion: { select: { name: true, version: true } } },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">{t('subtitle')}</p>
      </header>

      {backtests.length === 0 ? (
        <EmptyState title={t('noRuns')} hint={t('noRunsHint')} />
      ) : (
        backtests.map((run) => (
          <PremiumCard key={run.id}>
            <SectionHeading
              title={run.name}
              description={`${run.modelVersion.name}-${run.modelVersion.version}`}
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricCard label={t('totalBets')} value={run.totalBets} />
              <MetricCard
                label={tm('hitRate')}
                value={run.hitRate ? format.number(Number(run.hitRate), 'percent') : '—'}
              />
              <MetricCard
                label={tm('roi')}
                value={run.roi ? format.number(Number(run.roi), 'signedPercent') : '—'}
                tone={run.roi && Number(run.roi) > 0 ? 'emerald' : 'default'}
              />
              <MetricCard
                label={tm('brierScore')}
                value={run.brierScore ? Number(run.brierScore).toFixed(4) : '—'}
              />
            </div>
          </PremiumCard>
        ))
      )}
    </div>
  );
}
