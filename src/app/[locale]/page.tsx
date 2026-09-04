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
import { getNotableWins, getWeeklyStats } from '@/services/stats/weekly-stats';
import { getFeaturedStandings, getMostPricedMatches } from '@/services/stats/standings';
import { referenceStakeFor } from '@/lib/format/currency';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';
import { WeeklySummary } from '@/components/stats/weekly-summary';
import { StandingsTable } from '@/components/stats/standings-table';
import { StandingsTabs } from '@/components/stats/standings-tabs';
import { PopularMatches } from '@/components/stats/popular-matches';

/**
 * Dashboard (§46).
 *
 * Built from what the system actually holds: the publication window, the week's
 * settled results, real league tables, and the coupons that genuinely won —
 * with their dates, so a reader can check them against the history.
 */

export const dynamic = 'force-dynamic';

async function loadDashboard() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);

  const activePublication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(activePublication, schedule);
  const week = bulletinWeek(today, schedule);

  const [stats, standings, popular, upcoming, wins, marketCount, activeModel, openCoupons] =
    await Promise.all([
      getWeeklyStats(),
      getFeaturedStandings(),
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
      getNotableWins(),
      prisma.bettingMarket.count({ where: { active: true } }),
      prisma.modelVersion.findFirst({ where: { active: true } }),
      prisma.coupon.count({ where: { resultStatus: 'PENDING' } }),
    ]);

  return {
    schedule,
    today,
    window,
    week,
    isPublicationToday: isPublicationDay(today, schedule),
    nextPublication: nextPublicationDate(today, schedule),
    stats,
    standings,
    popular,
    upcoming,
    wins,
    marketCount,
    activeModel,
    openCoupons,
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
  const tCat = await getTranslations('categories');
  const tDisc = await getTranslations('disclaimer');
  const format = await getFormatter();

  const viewer = await getViewer();
  const data = await loadDashboard();
  const stake = referenceStakeFor(locale);

  const dayLabel = (key: string) =>
    format.dateTime(dateKeyToUtcMidnight(key), { day: '2-digit', month: 'short', timeZone: 'UTC' });

  const money = (value: number) =>
    format.number(value, { style: 'currency', currency: stake.currency, maximumFractionDigits: 0 });

  const { selections } = data.stats;

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

      {/* Headline numbers, colour-coded by what they mean. */}
      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard
          icon="✓"
          label={tw('correct')}
          value={selections.correct}
          tone="emerald"
          hint={tw('ofDecided', { count: selections.correct + selections.incorrect })}
        />
        <MetricCard
          icon="✕"
          label={tw('incorrect')}
          value={selections.incorrect}
          tone="rose"
          hint={tw('ofDecided', { count: selections.correct + selections.incorrect })}
        />
        <MetricCard
          icon="◎"
          label={tw('hitRate')}
          value={
            selections.hitRate === null
              ? tw('notSettled')
              : format.number(selections.hitRate, 'percent')
          }
          tone={selections.hitRate !== null && selections.hitRate >= 0.5 ? 'emerald' : 'gold'}
        />
        <MetricCard
          icon="◷"
          label={tw('pending')}
          value={data.openCoupons}
          tone="sky"
          hint={tw('matchesPending', { count: data.stats.matchesPending })}
        />
      </section>

      {/* Real settled wins, with the dates that make them checkable. */}
      <section className="grid gap-4 md:grid-cols-2">
        {(
          [
            { key: 'bestWin', win: data.wins.biggest, tone: 'gold' as const, icon: '★' },
            { key: 'latestWin', win: data.wins.latest, tone: 'emerald' as const, icon: '◆' },
          ] satisfies Array<{ key: string; win: typeof data.wins.biggest; tone: 'gold' | 'emerald'; icon: string }>
        ).map(({ key, win, tone, icon }) => (
          <PremiumCard key={key} accent={tone === 'gold' ? 'gold' : 'emerald'} className="p-4">
            <p className="flex items-center gap-1.5 text-xs tracking-wide text-muted uppercase">
              <span aria-hidden>{icon}</span>
              {tw(key)}
            </p>

            {win ? (
              <>
                <p
                  className={`tabular mt-2 text-3xl font-semibold ${
                    tone === 'gold' ? 'text-gold-light' : 'text-emerald-bright'
                  }`}
                >
                  {format.number(win.totalOdds, 'odds')}
                </p>
                <p className="mt-1 text-sm">
                  {tCat(`${win.category}.name`)} ·{' '}
                  {format.number(win.selectionCount, {})}{' '}
                  <span className="text-muted">{tw('legs')}</span>
                </p>
                <p className="mt-2 text-xs text-muted">
                  {win.reference} ·{' '}
                  {tw('onDate', {
                    date: format.dateTime(win.settledAt ?? win.targetDate, {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })}
                </p>
                <p className="tabular mt-2 text-sm text-muted-dark">
                  {money(win.totalOdds * stake.amount)} / {money(stake.amount)}
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-muted">{tw('noWinsYet')}</p>
            )}
          </PremiumCard>
        ))}
      </section>

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
                  <Link href={`/matches/${match.id}`} className="min-w-0 flex-1 hover:text-emerald-bright">
                    <p className="truncate text-sm font-medium">
                      {match.homeTeam.name} <span className="text-muted">{tc('vs')}</span>{' '}
                      {match.awayTeam.name}
                    </p>
                    <p className="text-xs text-muted">{match.league.name}</p>
                  </Link>
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

      {/* League tables, computed from stored results, one tab per league. */}
      {data.standings.length > 0 ? (
        <section>
          <SectionHeading title={tw('standings')} />
          <StandingsTabs
            labels={data.standings.map((table) => table.leagueName)}
            panels={data.standings.map((table) => (
              <StandingsTable key={table.leagueId} standings={table} limit={10} />
            ))}
          />
        </section>
      ) : null}

      <section>
        <SectionHeading title={tSched('systemReadiness')} />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <MetricCard label={t('marketsAnalysed')} value={data.marketCount} tone="violet" />
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
            value={dayLabel(data.nextPublication)}
            tone={data.isPublicationToday ? 'emerald' : 'sky'}
          />
        </div>
      </section>

      <p className="text-xs text-muted-dark">{tDisc('risk')}</p>
    </div>
  );
}
