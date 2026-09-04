import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { getViewer } from '@/lib/auth/session';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { bulletinWeek, todayInSchedule } from '@/lib/schedule/bulletin-schedule';
import { localDateKey } from '@/lib/time/zoned';
import { Link } from '@/i18n/navigation';
import { EmptyState, PremiumCard, SectionHeading } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function MatchesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('matches');
  const tms = await getTranslations('matchStatus');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const viewer = await getViewer();
  const schedule = await getBulletinSchedule();
  const week = bulletinWeek(todayInSchedule(schedule), schedule);

  const matches = await prisma.match.findMany({
    where: { scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc } },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      status: true,
      homeScore: true,
      awayScore: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true, country: true } },
      _count: { select: { odds: true } },
    },
  });

  // Group by local match day so the week reads as days, not one long list.
  const byDay = new Map<string, typeof matches>();
  for (const match of matches) {
    const key = localDateKey(match.scheduledKickoffUtc, schedule.timezone);
    byDay.set(key, [...(byDay.get(key) ?? []), match]);
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 text-sm text-muted">
          {format.dateTime(week.startUtc, 'short')} – {format.dateTime(week.endUtc, 'short')}
        </p>
      </header>

      {matches.length === 0 ? (
        <EmptyState title={tc('empty')} hint={tc('emptyHint')} />
      ) : (
        [...byDay.entries()].map(([day, dayMatches]) => (
          <section key={day}>
            <SectionHeading
              title={format.dateTime(new Date(`${day}T12:00:00Z`), {
                weekday: 'long',
                day: '2-digit',
                month: 'long',
                timeZone: 'UTC',
              })}
              description={t('count', { count: dayMatches.length })}
            />
            <PremiumCard className="p-0">
              <ul className="divide-y divide-white/10">
                {dayMatches.map((match) => (
                  <li key={match.id} className="flex flex-wrap items-center gap-3 p-4">
                    <span className="tabular w-14 text-sm font-semibold text-emerald-bright">
                      {format.dateTime(match.scheduledKickoffUtc, 'kickoff')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/matches/${match.id}`}
                        className="truncate text-sm font-medium hover:text-emerald-bright"
                      >
                        {match.homeTeam.name} <span className="text-muted">{tc('vs')}</span>{' '}
                        {match.awayTeam.name}
                      </Link>
                      <p className="text-xs text-muted">
                        {match.league.name}
                        {match.league.country ? ` · ${match.league.country}` : ''}
                      </p>
                    </div>

                    {match.homeScore !== null && match.awayScore !== null ? (
                      <span className="tabular rounded-md border border-white/15 px-2 py-0.5 text-sm font-semibold">
                        {match.homeScore} – {match.awayScore}
                      </span>
                    ) : null}

                    <span className="text-xs text-muted">{tms(match.status)}</span>

                    {/* Price availability is public; the analysis behind it is not. */}
                    <span className="text-[0.7rem] text-muted-dark">
                      {match._count.odds > 0 ? t('pricesAvailable') : t('noOdds')}
                    </span>
                  </li>
                ))}
              </ul>
            </PremiumCard>
          </section>
        ))
      )}

      {!viewer.userId ? (
        <p className="text-xs text-muted-dark">{t('signInForAnalysis')}</p>
      ) : null}
    </div>
  );
}
