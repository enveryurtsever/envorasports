import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

/** Result & settlement monitor (§39). */
export default async function AdminResultsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const tms = await getTranslations('matchStatus');
  const format = await getFormatter();

  const now = new Date();
  const [awaiting, recentlyFinished, failures, pendingCoupons] = await Promise.all([
    prisma.match.findMany({
      where: {
        status: { in: ['SCHEDULED', 'LIVE', 'HALF_TIME', 'SUSPENDED'] },
        scheduledKickoffUtc: { lte: now },
      },
      orderBy: { scheduledKickoffUtc: 'asc' },
      take: 25,
      select: {
        id: true,
        scheduledKickoffUtc: true,
        status: true,
        resultSyncAttempts: true,
        resultLastSyncedAt: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
      },
    }),
    prisma.match.count({
      where: {
        status: 'FINISHED',
        finishedAtUtc: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.providerRequestLog.count({
      where: { success: false, createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
    }),
    prisma.coupon.count({ where: { resultStatus: 'PENDING' } }),
  ]);

  return (
    <div className="space-y-6">
      <SectionHeading title={t('results')} description={t('resultsHint')} />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard label={t('awaitingResult')} value={awaiting.length} />
        <MetricCard label={t('recentlyFinished')} value={recentlyFinished} tone="emerald" />
        <MetricCard label={t('syncFailures')} value={failures} tone={failures > 0 ? 'gold' : 'muted'} />
        <MetricCard label={t('awaitingSettlement')} value={pendingCoupons} />
      </div>

      <PremiumCard className="overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead className="border-b border-white/10 text-left text-xs text-muted uppercase">
            <tr>
              <th className="px-4 py-2">{t('match')}</th>
              <th className="px-4 py-2">{t('kickoff')}</th>
              <th className="px-4 py-2">{t('status')}</th>
              <th className="px-4 py-2">{t('attempts')}</th>
              <th className="px-4 py-2">{t('lastSync')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {awaiting.map((match) => (
              <tr key={match.id}>
                <td className="px-4 py-2">
                  {match.homeTeam.name} – {match.awayTeam.name}
                </td>
                <td className="px-4 py-2 text-muted">
                  {format.dateTime(match.scheduledKickoffUtc, 'full')}
                </td>
                <td className="px-4 py-2">{tms(match.status)}</td>
                <td className="tabular px-4 py-2">{match.resultSyncAttempts}</td>
                <td className="px-4 py-2 text-muted">
                  {match.resultLastSyncedAt
                    ? format.dateTime(match.resultLastSyncedAt, 'full')
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PremiumCard>
    </div>
  );
}
