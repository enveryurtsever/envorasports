import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getViewer } from '@/lib/auth/session';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { bulletinWeek, todayInSchedule } from '@/lib/schedule/bulletin-schedule';
import { dateKeyToUtcMidnight } from '@/lib/time/zoned';
import { getCategoryView } from '@/services/coupons/coupon-access';
import { EmptyState, PremiumCard, SectionHeading } from '@/components/ui/card';
import { LockedPanel } from '@/components/ui/locked-panel';
import { CouponCard } from '@/components/predictions/coupon-card';

export const dynamic = 'force-dynamic';

export default async function SystemsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('systems');
  const tCat = await getTranslations('categories');
  const tp = await getTranslations('predictions');

  const viewer = await getViewer();
  const schedule = await getBulletinSchedule();
  const week = bulletinWeek(todayInSchedule(schedule), schedule);

  const view = await getCategoryView(viewer, 'COMBINATION_SYSTEM', {
    from: dateKeyToUtcMidnight(week.startDate),
    to: dateKeyToUtcMidnight(week.endDate),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">{tCat('COMBINATION_SYSTEM.description')}</p>
      </header>

      <PremiumCard className="bg-white/[0.03] p-4">
        <p className="text-sm text-muted">{t('explanation', { n: 8, k: 3 })}</p>
      </PremiumCard>

      <SectionHeading title={tCat('COMBINATION_SYSTEM.name')} />

      {view.coupons.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {view.coupons.map((coupon) => (
            <CouponCard key={coupon.id} coupon={coupon} />
          ))}
        </div>
      ) : null}

      {view.hidden && view.hidden.count > 0 ? (
        <LockedPanel category="COMBINATION_SYSTEM" summary={view.hidden} />
      ) : null}

      {view.coupons.length === 0 && (!view.hidden || view.hidden.count === 0) ? (
        <EmptyState title={tp('noneForCategory')} hint={tp('noneForCategoryHint')} />
      ) : null}
    </div>
  );
}
