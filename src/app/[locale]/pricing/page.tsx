import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { prisma } from '@/lib/db/prisma';
import { getViewer } from '@/lib/auth/session';
import { Link } from '@/i18n/navigation';
import { PLAN_FEATURES, type PlanCode } from '@/lib/entitlements/features';
import { PremiumCard } from '@/components/ui/card';
import { cn } from '@/lib/format/cn';

export const dynamic = 'force-dynamic';

/** Prices come from the database, never hard-coded in the UI (§16). */
export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('pricing');
  const tc = await getTranslations('common');
  const tCat = await getTranslations('categories');
  const td = await getTranslations('disclaimer');
  const format = await getFormatter();

  const viewer = await getViewer();
  const plans = await prisma.subscriptionPlan.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: { features: { where: { enabled: true } } },
  });

  const currentPlan = viewer.entitlements.planCode;

  const CATEGORY_BY_FEATURE: Record<string, string> = {
    COUPON_HIGH_CONFIDENCE: 'HIGH_CONFIDENCE',
    COUPON_BALANCED_PICKS: 'BALANCED_PICKS',
    COUPON_HIGH_VALUE: 'HIGH_VALUE',
    COUPON_COMBINATION_SYSTEM: 'COMBINATION_SYSTEM',
  };

  return (
    <div className="space-y-8">
      <header className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t('title')}</h1>
        <p className="mt-2 text-sm text-muted">{t('subtitle')}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        {plans.map((plan, index) => {
          const isElite = plan.code === 'ELITE';
          const isCurrent = currentPlan === plan.code;
          const features = PLAN_FEATURES[plan.code as PlanCode] ?? [];

          return (
            <PremiumCard
              key={plan.id}
              accent={isElite ? 'gold' : index === 1 ? 'emerald' : 'none'}
              className="flex flex-col"
            >
              {index === 1 ? (
                <span className="mb-3 self-start rounded-full border border-emerald-primary/40 bg-emerald-primary/10 px-2.5 py-0.5 text-xs text-emerald-bright">
                  {t('mostPopular')}
                </span>
              ) : null}

              <h2 className={cn('text-lg font-semibold', isElite && 'text-gold-light')}>
                {t(`plans.${plan.code}.name`)}
              </h2>

              <p className="tabular mt-2 text-3xl font-semibold">
                {format.number(Number(plan.monthlyPrice), {
                  style: 'currency',
                  currency: plan.currency,
                  maximumFractionDigits: 2,
                })}
                <span className="text-sm font-normal text-muted">{tc('perMonth')}</span>
              </p>

              <p className="mt-3 text-sm text-muted">{t(`plans.${plan.code}.description`)}</p>

              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <span aria-hidden className="mt-0.5 text-emerald-bright">
                      ✓
                    </span>
                    <span>{tCat(`${CATEGORY_BY_FEATURE[feature]}.name`)}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <span className="block rounded-lg border border-emerald-primary/40 bg-emerald-primary/10 px-4 py-2 text-center text-sm font-medium text-emerald-bright">
                    {t('currentPlan')}
                  </span>
                ) : (
                  <Link
                    href="/account"
                    className={cn(
                      'block rounded-lg px-4 py-2 text-center text-sm font-semibold transition-opacity hover:opacity-90',
                      isElite ? 'bg-gold text-ink' : 'bg-emerald-primary text-white',
                    )}
                  >
                    {t('choosePlan', { plan: t(`plans.${plan.code}.name`) })}
                  </Link>
                )}
              </div>
            </PremiumCard>
          );
        })}
      </div>

      <p className="text-center text-xs text-muted-dark">{td('long')}</p>
    </div>
  );
}
