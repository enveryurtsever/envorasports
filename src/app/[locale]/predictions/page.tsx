import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getViewer } from '@/lib/auth/session';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { bulletinWeek, todayInSchedule } from '@/lib/schedule/bulletin-schedule';
import { dateKeyToUtcMidnight } from '@/lib/time/zoned';
import { COUPON_CATEGORIES } from '@/lib/config/coupon-settings';
import { getCategoryView, getFreePreviewPolicy } from '@/services/coupons/coupon-access';
import { EmptyState, SectionHeading } from '@/components/ui/card';
import { LockedPanel } from '@/components/ui/locked-panel';
import { CouponCard } from '@/components/predictions/coupon-card';

export const dynamic = 'force-dynamic';

export default async function PredictionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('predictions');
  const tCat = await getTranslations('categories');

  const viewer = await getViewer();
  const schedule = await getBulletinSchedule();
  const week = bulletinWeek(todayInSchedule(schedule), schedule);
  const range = {
    from: dateKeyToUtcMidnight(week.startDate),
    to: dateKeyToUtcMidnight(week.endDate),
  };

  const policy = await getFreePreviewPolicy();
  const categories = COUPON_CATEGORIES.filter((c) => c !== 'COMBINATION_SYSTEM');
  const views = await Promise.all(
    categories.map((category) => getCategoryView(viewer, category, range, policy)),
  );

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">{t('subtitle')}</p>
      </header>

      {views.map((view) => (
        <section key={view.category} className="space-y-4">
          <SectionHeading
            title={tCat(`${view.category}.name`)}
            description={tCat(`${view.category}.description`)}
          />

          {view.coupons.length > 0 ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {view.coupons.map((coupon) => (
                <CouponCard key={coupon.id} coupon={coupon} isPreview={view.access === 'preview'} />
              ))}
            </div>
          ) : null}

          {view.hidden && view.hidden.count > 0 ? (
            <LockedPanel
              category={view.category}
              summary={view.hidden}
              variant={view.access === 'preview' ? 'remainder' : 'locked'}
            />
          ) : null}

          {view.coupons.length === 0 && (!view.hidden || view.hidden.count === 0) ? (
            <EmptyState title={t('noneForCategory')} hint={t('noneForCategoryHint')} />
          ) : null}
        </section>
      ))}
    </div>
  );
}
