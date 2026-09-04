import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { Link } from '@/i18n/navigation';
import { getViewer } from '@/lib/auth/session';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import {
  bulletinWeek,
  coverageWindow,
  isPublicationDay,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
  WEEKDAY_KEYS,
} from '@/lib/schedule/bulletin-schedule';
import { dateKeyToUtcMidnight, weekdayOfDateKey } from '@/lib/time/zoned';
import { getWeeklyStats } from '@/services/stats/weekly-stats';
import { getLeagueStandings, getLeaguesWithResults, getMostPricedMatches } from '@/services/stats/standings';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { WeeklySummary } from '@/components/stats/weekly-summary';
import { StandingsTable } from '@/components/stats/standings-table';
import { PopularMatches } from '@/components/stats/popular-matches';

/**
 * Dashboard (§46).
 *
 * Built from what the system actually holds: the publication window, the week's
 * settled results, the fixtures the market has priced, and league tables
 * computed from stored results. No placeholder numbers.
 */

export const dynamic = 'force-dynamic';

async function loadDashboard() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);

  const activePublication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(activePublication, schedule);
  const week = bulletinWeek(today, schedule);

  const [stats, leagues, popular, upcoming, marketCount, activeModel] = await Promise.all([
    getWeeklyStats(),
    getLeaguesWithResults(4),
    getMostPricedMatches({ from: week.startUtc, to: week.endUtc }, 6),
    prisma.match.findMany({
      where: { scheduledKickoffUtc: { gte: new Date() } },
      orderBy: { scheduledKickoffUtc: 'asc' },
      take: 6,
      select: {
        id: true,
        scheduledKickoffUtc: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
        league: { select: { name: true } },
      },
    }),
    prisma.bettingMarket.count({ where: { active: true } }),
    prisma.modelVersion.findFirst({ where: { active: true } }),
  ]);

  const featured = leagues[0] ? await getLeagueStandings(leagues[0].id) : null;
  const secondary = leagues[1] ? await getLeagueStandings(leagues[1].id) : null;

  return {
    schedule,
    today,
    window,
    week,
    isPublicationToday: isPublicationDay(today, schedule),
    nextPublication: nextPublicationDate(today, schedule),
    stats,
    featured,
    secondary,
    popular,
    upcoming,
    marketCount,
    activeModel,
  };
}

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('home');
  const tc = await getTranslations('common');
  const tSched = await getTranslations('schedule');
  const tw = await getTranslations('weekly');
  const tn = await getTranslations('nav');
  const tDisc = await getTranslations('disclaimer');
  const format = await getFormatter();

  const viewer = await getViewer();
  const data = await loadDashboard();

  const dayLabel = (key: string) =>
    format.dateTime(dateKeyToUtcMidnight(key), { day: '2-digit', month: 'short', timeZone: 'UTC' });

  return (
    <div className="space-y-10">
      {/* Hero: what is prepared and when the next publication lands. */}
      <section>
        <p className="text-xs font-medium tracking-[0.18em] text-emerald-bright uppercase">
          {tSched('coverage')} · {dayLabel(data.window.startDate)} – {dayLabel(data.window.endDate)}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{t('heroTitle')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted sm:text-base">{t('heroSubtitle')}</p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {data.window.days.map((day) => (
            <span
              key={day}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted"
            >
              {tSched(`weekday.${WEEKDAY_KEYS[weekdayOfDateKey(day)]}`)} · {dayLabel(day)}
            </span>
          ))}
          <span className="rounded-full border border-emerald-primary/30 bg-emerald-primary/10 px-3 py-1 text-xs text-emerald-bright">
            {tSched('nextPublication')}: {dayLabel(data.nextPublication)}
          </span>
        </div>

        {!viewer.userId ? (
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/predictions"
              className="rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white"
            >
              {tn('predictions')}
            </Link>
            <Link
              href="/pricing"
              className="rounded-lg border border-gold/40 px-4 py-2 text-sm font-semibold text-gold-light"
            >
              {tn('pricing')}
            </Link>
          </div>
        ) : null}
      </section>

      {/* Weekly bulletin performance. */}
      <WeeklySummary stats={data.stats} />

      {/* What the market cares about this week, and what is coming up. */}
      <section className="grid gap-4 lg:grid-cols-2">
        <PopularMatches matches={data.popular} />

        <PremiumCard className="p-0">
          <h3 className="px-4 pt-4 text-sm font-semibold">{t('nextKickoffs')}</h3>
          {data.upcoming.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">{tc('emptyHint')}</p>
          ) : (
            <ul className="mt-3 divide-y divide-white/10">
              {data.upcoming.map((match) => (
                <li key={match.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="tabular w-24 shrink-0 text-xs font-semibold text-emerald-bright">
                    {format.dateTime(match.scheduledKickoffUtc, {
                      day: '2-digit',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {match.homeTeam.name} <span className="text-muted">{tc('vs')}</span>{' '}
                      {match.awayTeam.name}
                    </p>
                    <p className="text-xs text-muted">{match.league.name}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="px-4 pt-2 pb-4">
            <Link href="/matches" className="text-sm font-medium text-emerald-bright hover:underline">
              {tn('matches')} →
            </Link>
          </div>
        </PremiumCard>
      </section>

      {/* League tables, computed from stored results. */}
      {data.featured || data.secondary ? (
        <section>
          <SectionHeading title={tw('standings')} />
          <div className="grid gap-4 lg:grid-cols-2">
            {data.featured ? <StandingsTable standings={data.featured} /> : null}
            {data.secondary ? <StandingsTable standings={data.secondary} /> : null}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeading title={tSched('systemReadiness')} />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <MetricCard label={t('marketsAnalysed')} value={data.marketCount} tone="muted" />
          <MetricCard
            label={t('modelStatus')}
            value={
              data.activeModel
                ? `${data.activeModel.name}-${data.activeModel.version}`
                : tc('notAvailable')
            }
            tone={data.activeModel ? 'emerald' : 'muted'}
          />
          <MetricCard label={tSched('timezone')} value={data.schedule.timezone} tone="muted" />
          <MetricCard
            label={tSched('publicationDay')}
            value={data.isPublicationToday ? tw('won') : dayLabel(data.nextPublication)}
            tone={data.isPublicationToday ? 'emerald' : 'muted'}
          />
        </div>
      </section>

      <p className="text-xs text-muted-dark">{tDisc('risk')}</p>
    </div>
  );
}
