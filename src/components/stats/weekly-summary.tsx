import { getFormatter, getTranslations } from 'next-intl/server';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { dateKeyToUtcMidnight } from '@/lib/time/zoned';
import type { WeeklyStats } from '@/services/stats/weekly-stats';

/**
 * Weekly bulletin performance (§40).
 *
 * Pending items are excluded from every hit rate, and a week with nothing
 * settled says so rather than showing a misleading 0%.
 */
export async function WeeklySummary({ stats }: { stats: WeeklyStats }) {
  const t = await getTranslations('weekly');
  const tCat = await getTranslations('categories');
  const format = await getFormatter();

  const percent = (value: number | null) =>
    value === null ? t('notSettled') : format.number(value, 'percent');

  const dayLabel = (key: string) =>
    format.dateTime(dateKeyToUtcMidnight(key), { day: '2-digit', month: 'short', timeZone: 'UTC' });

  const { selections } = stats;
  const decided = selections.correct + selections.incorrect;

  return (
    <section>
      <SectionHeading
        title={t('title')}
        description={t('period', {
          start: dayLabel(stats.week.startDate),
          end: dayLabel(stats.week.endDate),
        })}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard
          label={t('matchesFinished')}
          value={`${stats.matchesFinished} / ${stats.matchesTotal}`}
          hint={t('matchesPending', { count: stats.matchesPending })}
        />
        <MetricCard
          label={t('correct')}
          value={selections.correct}
          tone={selections.correct > 0 ? 'emerald' : 'muted'}
          hint={t('ofDecided', { count: decided })}
        />
        <MetricCard
          label={t('incorrect')}
          value={selections.incorrect}
          tone="muted"
          hint={t('ofDecided', { count: decided })}
        />
        <MetricCard
          label={t('hitRate')}
          value={percent(selections.hitRate)}
          tone={selections.hitRate !== null && selections.hitRate >= 0.5 ? 'emerald' : 'default'}
          hint={selections.pending > 0 ? t('stillOpen', { count: selections.pending }) : undefined}
        />
      </div>

      <div className="mt-4 grid gap-3 sm:gap-4 md:grid-cols-2">
        {stats.categories.map((category) => (
          <PremiumCard
            key={category.category}
            accent={category.category === 'HIGH_VALUE' ? 'gold' : 'none'}
            className="p-4"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-semibold">{tCat(`${category.category}.name`)}</h3>
              <span className="tabular text-sm font-semibold text-emerald-bright">
                {percent(category.hitRate)}
              </span>
            </div>

            <dl className="tabular mt-3 grid grid-cols-4 gap-2 text-center">
              {(
                [
                  ['won', category.won],
                  ['lost', category.lost],
                  ['partial', category.partial],
                  ['pending', category.pending],
                ] as const
              ).map(([key, value]) => (
                <div key={key} className="rounded-lg border border-white/10 bg-white/5 py-2">
                  <dt className="text-[0.65rem] tracking-wide text-muted uppercase">{t(key)}</dt>
                  <dd className="mt-0.5 text-base font-semibold">{value}</dd>
                </div>
              ))}
            </dl>

            {category.generated === 0 ? (
              <p className="mt-3 text-xs text-muted-dark">{t('noneGenerated')}</p>
            ) : null}
          </PremiumCard>
        ))}
      </div>
    </section>
  );
}
