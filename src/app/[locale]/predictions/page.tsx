import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getViewer } from '@/lib/auth/session';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import {
  bulletinWeek,
  previousBulletinWeek,
  todayInSchedule,
} from '@/lib/schedule/bulletin-schedule';
import { dateKeyToUtcMidnight } from '@/lib/time/zoned';
import { COUPON_CATEGORIES } from '@/lib/config/coupon-settings';
import type { UnlockedCoupon } from '@/services/coupons/coupon-access';
import {
  getCategoryView,
  getFreePreviewPolicy,
  resolveFreePreviewPolicy,
} from '@/services/coupons/coupon-access';
import { EmptyState, SectionHeading } from '@/components/ui/card';
import { LockedPanel } from '@/components/ui/locked-panel';
import { CouponCard } from '@/components/predictions/coupon-card';
import { WeekFilter } from '@/components/predictions/week-filter';

export const dynamic = 'force-dynamic';

/**
 * Splits a category's coupons into its focus slates, in the order they first
 * appear. A category with no focus groups comes back as a single unlabelled
 * group, so the markup is the same either way.
 */
function groupByFocus(
  coupons: UnlockedCoupon[],
): Array<{ key: string; coupons: UnlockedCoupon[] }> {
  const groups = new Map<string, UnlockedCoupon[]>();

  for (const coupon of coupons) {
    const key = coupon.strategy.startsWith('focus_') ? coupon.strategy : 'focus_other';
    const existing = groups.get(key);
    if (existing) existing.push(coupon);
    else groups.set(key, [coupon]);
  }

  // Unlabelled first: the category's own coupons lead, the slates follow.
  return [...groups.entries()]
    .sort(([a], [b]) => (a === 'focus_other' ? -1 : b === 'focus_other' ? 1 : a.localeCompare(b)))
    .map(([key, list]) => ({ key, coupons: list }));
}

export default async function PredictionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ week?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { week: requestedWeek } = await searchParams;

  const t = await getTranslations('predictions');
  const tCat = await getTranslations('categories');
  const tFocus = await getTranslations('focus');

  const viewer = await getViewer();
  const schedule = await getBulletinSchedule();
  // Anything but the explicit "previous" is this week: a stale or hand-edited
  // query string should show the live slate, never an empty page.
  const selectedWeek = requestedWeek === 'previous' ? 'previous' : 'current';
  const thisWeek = bulletinWeek(todayInSchedule(schedule), schedule);
  const week = selectedWeek === 'previous' ? previousBulletinWeek(thisWeek, schedule) : thisWeek;
  const range = {
    from: dateKeyToUtcMidnight(week.startDate),
    to: dateKeyToUtcMidnight(week.endDate),
  };

  // The preview follows the first category that actually has coupons, so a
  // category that produced none does not leave a signed-out reader with a page
  // of locked cards.
  const policy = await resolveFreePreviewPolicy(range, await getFreePreviewPolicy());
  // Systems are shown alongside the straight coupons rather than on their own
  // page: they are part of the same week's slate, not a separate product.
  const views = await Promise.all(
    COUPON_CATEGORIES.map((category) => getCategoryView(viewer, category, range, policy)),
  );

  return (
    <div className="space-y-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">{t('subtitle')}</p>
        <div className="mt-4">
          <WeekFilter
            current={selectedWeek}
            range={{ startDate: week.startDate, endDate: week.endDate }}
          />
        </div>
      </header>

      {views
        .filter((view) => view.coupons.length > 0 || (view.hidden?.count ?? 0) > 0)
        .map((view) => (
        <section key={view.category} className="space-y-4">
          <SectionHeading
            title={tCat(`${view.category}.name`)}
            description={tCat(`${view.category}.description`)}
          />

          {view.coupons.length > 0
            ? groupByFocus(view.coupons).map(({ key, coupons }) => (
                <div key={key} className="space-y-3">
                  {/* Only labelled when a category actually has focus slates;
                      one unlabelled group is just the category itself. */}
                  {key !== 'focus_other' ? (
                    <h3 className="text-sm font-semibold tracking-wide text-gold-light uppercase">
                      {tFocus(key)}
                    </h3>
                  ) : null}
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {coupons.map((coupon) => (
                      <CouponCard
                        key={coupon.id}
                        coupon={coupon}
                        isPreview={view.access === 'preview'}
                      />
                    ))}
                  </div>
                </div>
              ))
            : null}

          {view.hidden && view.hidden.count > 0 ? (
            <LockedPanel
              category={view.category}
              summary={view.hidden}
              variant={view.access === 'preview' ? 'remainder' : 'locked'}
            />
          ) : null}

        </section>
      ))}

      {views.every((view) => view.coupons.length === 0 && (view.hidden?.count ?? 0) === 0) ? (
        <EmptyState
          title={selectedWeek === 'previous' ? t('nonePreviousWeek') : t('noneThisWeek')}
          hint={selectedWeek === 'previous' ? t('nonePreviousWeekHint') : t('noneThisWeekHint')}
        />
      ) : null}
    </div>
  );
}
