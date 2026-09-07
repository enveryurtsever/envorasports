import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/format/cn';

/**
 * Switches the page between this week's slate and the one before it.
 *
 * Two options rather than an archive on purpose: the week that just finished is
 * the one a reader checks the record against, and everything older is what the
 * winners page is for. Plain links, so the choice survives a reload and can be
 * shared — no client state to lose.
 */
export async function WeekFilter({
  current,
  range,
}: {
  current: 'current' | 'previous';
  range: { startDate: string; endDate: string };
}) {
  const t = await getTranslations('predictions');

  const options = [
    { key: 'current' as const, href: '/predictions', label: t('weekCurrent') },
    { key: 'previous' as const, href: '/predictions?week=previous', label: t('weekPrevious') },
  ];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        role="group"
        aria-label={t('weekFilterLabel')}
        className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-1"
      >
        {options.map((option) => {
          const active = option.key === current;
          return (
            <Link
              key={option.key}
              href={option.href}
              aria-current={active ? 'true' : undefined}
              className={cn(
                'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                active
                  ? 'bg-emerald-primary text-white'
                  : 'text-muted hover:text-paper',
              )}
            >
              {option.label}
            </Link>
          );
        })}
      </div>

      {/* Which seven days are actually on screen — without it, "previous" is
          only a word and a reader cannot tell what they are looking at. */}
      <span className="tabular text-xs text-muted">
        {range.startDate} – {range.endDate}
      </span>
    </div>
  );
}
