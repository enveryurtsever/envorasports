import { getFormatter, getTranslations, setRequestLocale } from 'next-intl/server';
import { getViewer } from '@/lib/auth/session';
import { getCurrentSubscription } from '@/lib/entitlements/service';
import { logout } from '@/lib/auth/actions';
import { Link } from '@/i18n/navigation';
import { EmptyState, MetricCard, PremiumCard, SectionHeading } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('account');
  const tn = await getTranslations('nav');
  const te = await getTranslations('errors');
  const format = await getFormatter();

  const viewer = await getViewer();

  if (!viewer.userId) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <EmptyState title={te('unauthorized')} />
        <Link
          href="/login"
          className="block rounded-lg bg-emerald-primary px-4 py-2 text-center text-sm font-semibold text-white"
        >
          {tn('signIn')}
        </Link>
      </div>
    );
  }

  const subscription = await getCurrentSubscription(viewer.userId);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted">{viewer.email}</p>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm transition-colors hover:border-rose-500/60"
          >
            {tn('signOut')}
          </button>
        </form>
      </header>

      <SectionHeading title={t('subscription')} />

      {subscription ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <MetricCard label={t('currentPlan')} value={subscription.plan.name} tone="emerald" />
          <MetricCard label={t('status')} value={t(`subscriptionStatus.${subscription.status}`)} />
          <MetricCard
            label={t('nextBilling')}
            value={
              subscription.currentPeriodEnd
                ? format.dateTime(subscription.currentPeriodEnd, 'short')
                : '—'
            }
          />
          <MetricCard
            label={t('language')}
            value={locale.toUpperCase()}
            tone="muted"
          />
        </div>
      ) : (
        <PremiumCard>
          <p className="text-sm text-muted">{t('noSubscription')}</p>
          <Link
            href="/pricing"
            className="mt-4 inline-block rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white"
          >
            {tn('pricing')}
          </Link>
        </PremiumCard>
      )}

      {viewer.isAdmin ? (
        <PremiumCard accent="gold">
          <SectionHeading title={tn('admin')} />
          <Link href="/admin" className="text-sm font-medium text-gold-light hover:underline">
            {tn('admin')} →
          </Link>
        </PremiumCard>
      ) : null}
    </div>
  );
}
