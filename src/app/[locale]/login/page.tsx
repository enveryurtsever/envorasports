import { getTranslations, setRequestLocale } from 'next-intl/server';
import { redirect } from '@/i18n/navigation';
import { getViewer } from '@/lib/auth/session';
import { LoginForm } from './login-form';
import { PremiumCard } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const viewer = await getViewer();
  if (viewer.userId) redirect({ href: '/account', locale });

  const t = await getTranslations('auth');

  return (
    <div className="mx-auto max-w-sm">
      <PremiumCard>
        <h1 className="text-xl font-semibold">{t('signInTitle')}</h1>
        <p className="mt-1 text-sm text-muted">{t('signInHint')}</p>
        <LoginForm />
      </PremiumCard>
    </div>
  );
}
