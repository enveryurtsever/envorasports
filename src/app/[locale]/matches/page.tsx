import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { bulletinWeek, todayInSchedule } from '@/lib/schedule/bulletin-schedule';
import { getPlayedMatches, type PlayedWeek } from '@/services/matches/played-matches';
import { formatSelection } from '@/lib/markets/labels';
import { METRIC_TOKENS } from '@/lib/format/metric-tokens';
import { Link } from '@/i18n/navigation';
import { EmptyState, PremiumCard } from '@/components/ui/card';
import { cn } from '@/lib/format/cn';

export const dynamic = 'force-dynamic';

/** A settled pick reads at a glance; a pending one stays quiet. */
const PICK_MARK: Record<string, { glyph: string; className: string }> = {
  WON: { glyph: '✓', className: 'bg-emerald-primary text-white' },
  HALF_WON: { glyph: '✓', className: 'bg-emerald-primary/70 text-white' },
  LOST: { glyph: '✕', className: 'bg-rose-500 text-white' },
  HALF_LOST: { glyph: '✕', className: 'bg-rose-500/70 text-white' },
  VOID: { glyph: '—', className: 'bg-white/20 text-paper' },
  PUSHED: { glyph: '=', className: 'bg-sky-500/70 text-white' },
  CANCELED: { glyph: '—', className: 'bg-white/20 text-paper' },
};

export default async function MatchesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('matches');
  const tms = await getTranslations('matchStatus');
  const ts = await getTranslations('status');
  const tc = await getTranslations('common');
  const translate = await getTranslations();
  const format = await getFormatter();

  const schedule = await getBulletinSchedule();
  const week = bulletinWeek(todayInSchedule(schedule), schedule);

  // A month back: long enough to show a record, short enough to stay readable.
  const to = new Date(week.endUtc.getTime() + 7 * 864e5);
  const from = new Date(to.getTime() - 31 * 864e5);

  const summary = await getPlayedMatches(from, to, schedule.timezone);
  const currentWeekKey = summary.weeks.find((w) =>
    w.matches.some((m) => m.kickoffUtc >= week.startUtc && m.kickoffUtc < week.endUtc),
  )?.key;

  const percent = (value: number) => format.number(value, 'percent');

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('playedTitle')}</h1>
        <p className="mt-2 text-sm text-muted">{t('playedSubtitle')}</p>
      </header>

      {/* The record, in the four numbers that answer "is this any good". */}
      <dl className="tabular grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t('metricMatches'), value: String(summary.matchesPlayed), tone: '' },
          { label: t('metricWon'), value: String(summary.won), tone: 'text-emerald-bright' },
          { label: t('metricLost'), value: String(summary.lost), tone: 'text-rose-300' },
          {
            label: t('metricHitRate'),
            value: summary.hitRate === null ? '—' : percent(summary.hitRate),
            tone: METRIC_TOKENS.modelProbability.text,
          },
        ].map((metric) => (
          <PremiumCard key={metric.label} className="px-4 py-3">
            <dt className="text-[0.65rem] tracking-wide text-muted uppercase">{metric.label}</dt>
            <dd className={cn('mt-1 text-2xl leading-none font-bold', metric.tone)}>
              {metric.value}
            </dd>
          </PremiumCard>
        ))}
      </dl>

      {summary.pending > 0 ? (
        <p className="text-xs text-muted-dark">{t('pendingNote', { count: summary.pending })}</p>
      ) : null}

      {summary.weeks.length === 0 ? (
        <EmptyState title={tc('empty')} hint={tc('emptyHint')} />
      ) : (
        <div className="space-y-3">
          {summary.weeks.map((playedWeek) => (
            <WeekBlock
              key={playedWeek.key}
              week={playedWeek}
              open={playedWeek.key === currentWeekKey}
              labels={{
                pendingShort: t('pendingShort'),
                analysis: t('analysisReport'),
                summary: t('weekSummary', {
                  matches: playedWeek.matches.length,
                  won: playedWeek.won,
                  lost: playedWeek.lost,
                }),
              }}
              format={format}
              translate={translate}
              statusLabel={tms}
              resultLabel={ts}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One week, collapsed unless it is the current one.
 *
 * A native `<details>` rather than a client component: the whole page is server
 * rendered and an accordion needs no state beyond what the browser already
 * keeps.
 */
function WeekBlock({
  week,
  open,
  labels,
  format,
  translate,
  statusLabel,
  resultLabel,
}: {
  week: PlayedWeek;
  open: boolean;
  labels: { summary: string; pendingShort: string; analysis: string };
  format: Awaited<ReturnType<typeof getFormatter>>;
  translate: Awaited<ReturnType<typeof getTranslations>>;
  statusLabel: (key: string) => string;
  resultLabel: (key: string) => string;
}) {
  const range = `${format.dateTime(week.startDate, 'short')} – ${format.dateTime(week.endDate, 'short')}`;

  return (
    <details open={open} className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-white/20">
        <span className="flex items-center gap-2">
          <span aria-hidden className="text-muted transition-transform group-open:rotate-90">
            ▸
          </span>
          <span className="text-sm font-semibold">{range}</span>
        </span>
        <span className="flex items-center gap-3 text-xs">
          <span className="text-muted">{labels.summary}</span>
          {week.won > 0 ? (
            <span className="font-semibold text-emerald-bright">{week.won} ✓</span>
          ) : null}
          {week.lost > 0 ? (
            <span className="font-semibold text-rose-300">{week.lost} ✕</span>
          ) : null}
        </span>
      </summary>

      <PremiumCard className="mt-2 p-0">
        <ul className="divide-y divide-white/10">
          {week.matches.map((match) => (
            <li key={match.id} className="flex flex-wrap items-start gap-3 p-4">
              <span className="tabular w-24 shrink-0 text-xs text-muted">
                {format.dateTime(match.kickoffUtc, 'short')}
                <br />
                {format.dateTime(match.kickoffUtc, 'kickoff')}
              </span>

              <div className="min-w-0 flex-1">
                <Link
                  href={`/matches/${match.id}`}
                  className="text-sm font-medium hover:text-emerald-bright"
                >
                  {match.homeTeam} – {match.awayTeam}
                </Link>
                <p className="text-xs text-muted">{match.league}</p>

                <ul className="mt-2 flex flex-wrap gap-2">
                  {match.picks.map((pick) => {
                    const mark = PICK_MARK[pick.resultStatus];
                    return (
                      <li
                        key={`${pick.marketCode}:${pick.selectionCode}`}
                        className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.04] py-0.5 pr-2 pl-1"
                      >
                        <span
                          aria-label={mark ? resultLabel(pick.resultStatus) : undefined}
                          className={cn(
                            'inline-flex h-4 w-4 items-center justify-center rounded text-[0.6rem] font-bold',
                            mark?.className ?? 'bg-white/10 text-muted',
                          )}
                        >
                          {mark?.glyph ?? '·'}
                        </span>
                        <span className="text-[0.7rem] font-semibold">
                          {formatSelection(translate, pick.marketCode, pick.selectionCode, {
                            home: match.homeTeam,
                            away: match.awayTeam,
                          })}
                        </span>
                        <span className={cn('tabular text-[0.7rem]', METRIC_TOKENS.odds.text)}>
                          {format.number(pick.odds, 'odds')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {match.analysis.length > 0 ? (
                <div className="w-full shrink-0 sm:w-56">
                  <p className="text-[0.65rem] tracking-wide text-muted uppercase">{labels.analysis}</p>
                  <ul className="mt-1 space-y-0.5">
                    {match.analysis.map((call) => {
                      const mark = PICK_MARK[call.status];
                      return (
                        <li
                          key={`${call.marketCode}:${call.selectionCode}`}
                          className="flex items-center gap-1.5 text-[0.75rem]"
                        >
                          <span
                            aria-label={mark ? resultLabel(call.status) : undefined}
                            className={cn(
                              'inline-flex h-3.5 w-3.5 items-center justify-center rounded text-[0.55rem] font-bold',
                              mark?.className ?? 'bg-white/10 text-muted',
                            )}
                          >
                            {mark?.glyph ?? '·'}
                          </span>
                          <span className="font-semibold">
                            {formatSelection(translate, call.marketCode, call.selectionCode, {
                              home: match.homeTeam,
                              away: match.awayTeam,
                            })}
                          </span>
                          <span className="tabular text-muted">
                            {format.number(call.probability, 'percent')}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              <span className="flex shrink-0 flex-col items-end gap-1">
                {match.homeScore !== null && match.awayScore !== null ? (
                  <span className="tabular rounded-md border border-white/15 px-2 py-0.5 text-sm font-semibold">
                    {match.homeScore} – {match.awayScore}
                  </span>
                ) : (
                  <span className="text-[0.7rem] text-muted-dark">{labels.pendingShort}</span>
                )}
                <span className="text-[0.65rem] text-muted">{statusLabel(match.status)}</span>
              </span>
            </li>
          ))}
        </ul>
      </PremiumCard>
    </details>
  );
}
