import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { getPipelineStatus } from '@/services/jobs/registry';
import { uncoveredWeekdays, WEEKDAY_KEYS } from '@/lib/schedule/bulletin-schedule';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { JobTriggerPanel } from './job-trigger-panel';

export const dynamic = 'force-dynamic';

export default async function AdminHomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const ts = await getTranslations('schedule');
  const format = await getFormatter();

  const status = await getPipelineStatus();
  const gaps = uncoveredWeekdays(status.schedule);

  return (
    <div className="space-y-8">
      <SectionHeading title={t('pipeline')} description={t('pipelineHint')} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard
          label={ts('publicationDay')}
          value={status.isPublicationDay ? t('yes') : t('no')}
          hint={status.today}
          tone={status.isPublicationDay ? 'emerald' : 'muted'}
        />
        <MetricCard
          label={ts('coverage')}
          value={`${status.window.startDate} → ${status.window.endDate}`}
          hint={ts('nextPublication') + ': ' + status.nextPublication}
        />
        <MetricCard label={t('awaitingResult')} value={status.awaitingResult} />
        <MetricCard label={t('pendingCoupons')} value={status.pendingCoupons} />
      </div>

      {gaps.length > 0 ? (
        <PremiumCard accent="gold" className="p-4">
          <p className="text-sm text-gold-light">
            {ts('uncoveredWarning', {
              weekday: gaps.map((d) => ts(`weekday.${WEEKDAY_KEYS[d]}`)).join(', '),
            })}
          </p>
        </PremiumCard>
      ) : null}

      <section>
        <SectionHeading title={t('providerQuota')} description={t('providerQuotaHint')} />
        <div className="grid gap-3 sm:gap-4 md:grid-cols-2">
          {[status.providers.football, status.providers.odds].map((provider) => {
            const used = provider.quota.used;
            const pct = provider.quota.budget > 0 ? used / provider.quota.budget : 0;
            return (
              <PremiumCard key={provider.name} className="p-4">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">{provider.name}</h3>
                  <span className="tabular text-sm text-muted">
                    {used} / {provider.quota.budget} · {provider.quota.window}
                  </span>
                </div>
                <div
                  role="meter"
                  aria-valuenow={used}
                  aria-valuemin={0}
                  aria-valuemax={provider.quota.budget}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"
                >
                  <div
                    className={pct > 0.85 ? 'h-full bg-rose-500' : 'h-full bg-emerald-primary'}
                    style={{ width: `${Math.min(100, pct * 100)}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-dark">
                  {t('remaining', { count: provider.quota.remaining })}
                </p>
              </PremiumCard>
            );
          })}
        </div>
      </section>

      <JobTriggerPanel />

      <section>
        <SectionHeading title={t('recentRuns')} />
        <PremiumCard className="overflow-x-auto p-0">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="border-b border-white/10 text-left text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2">{t('job')}</th>
                <th className="px-4 py-2">{t('status')}</th>
                <th className="px-4 py-2">{t('processed')}</th>
                <th className="px-4 py-2">{t('when')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {status.recentRuns.map((run) => (
                <tr key={run.id}>
                  <td className="px-4 py-2 font-medium">{run.jobName}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        run.status === 'FAILED'
                          ? 'text-rose-300'
                          : run.status === 'SUCCESS'
                            ? 'text-emerald-bright'
                            : 'text-muted'
                      }
                    >
                      {run.status}
                    </span>
                    {run.error ? (
                      <span className="ml-2 text-xs text-muted-dark">{run.error.slice(0, 80)}</span>
                    ) : null}
                  </td>
                  <td className="tabular px-4 py-2">{run.itemsProcessed}</td>
                  <td className="px-4 py-2 text-muted">
                    {format.dateTime(run.createdAt, 'full')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </PremiumCard>
      </section>
    </div>
  );
}
