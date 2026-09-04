import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { bulletinWeek, todayInSchedule } from '@/lib/schedule/bulletin-schedule';
import { EmptyState, PremiumCard, SectionHeading } from '@/components/ui/card';
import { MatchExclusionRow } from './match-row';

export const dynamic = 'force-dynamic';

/** Lets the operator keep a match out of generation without deleting it. */
export default async function AdminMatchesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const tc = await getTranslations('common');
  const format = await getFormatter();

  const schedule = await getBulletinSchedule();
  const week = bulletinWeek(todayInSchedule(schedule), schedule);

  const matches = await prisma.match.findMany({
    where: { scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc } },
    orderBy: { scheduledKickoffUtc: 'asc' },
    take: 200,
    select: {
      id: true,
      scheduledKickoffUtc: true,
      status: true,
      excludedFromGeneration: true,
      exclusionReason: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      _count: { select: { odds: true, predictions: true, couponSelections: true } },
    },
  });

  return (
    <div className="space-y-6">
      <SectionHeading title={t('matchControl')} description={t('matchControlHint')} />

      {matches.length === 0 ? (
        <EmptyState title={tc('empty')} hint={tc('emptyHint')} />
      ) : (
        <PremiumCard className="overflow-x-auto p-0">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="border-b border-white/10 text-left text-xs text-muted uppercase">
              <tr>
                <th className="px-4 py-2">{t('kickoff')}</th>
                <th className="px-4 py-2">{t('match')}</th>
                <th className="px-4 py-2 text-right">{t('prices')}</th>
                <th className="px-4 py-2 text-right">{t('predictions')}</th>
                <th className="px-4 py-2 text-right">{t('onCoupons')}</th>
                <th className="px-4 py-2">{t('inGeneration')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {matches.map((match) => (
                <MatchExclusionRow
                  key={match.id}
                  match={{
                    id: match.id,
                    kickoff: format.dateTime(match.scheduledKickoffUtc, 'full'),
                    label: `${match.homeTeam.name} – ${match.awayTeam.name}`,
                    league: match.league.name,
                    excluded: match.excludedFromGeneration,
                    reason: match.exclusionReason,
                    prices: match._count.odds,
                    predictions: match._count.predictions,
                    onCoupons: match._count.couponSelections,
                  }}
                />
              ))}
            </tbody>
          </table>
        </PremiumCard>
      )}
    </div>
  );
}
