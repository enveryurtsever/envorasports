import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { PremiumCard } from '@/components/ui/card';

export default function NotFound() {
  const t = useTranslations('errors');
  const tc = useTranslations('common');

  return (
    <PremiumCard className="mx-auto max-w-lg py-12 text-center">
      <h1 className="text-xl font-semibold">{t('notFound')}</h1>
      <p className="mt-2 text-sm text-muted">{t('notFoundHint')}</p>
      <Link href="/" className="mt-6 inline-block text-sm font-medium text-emerald-bright hover:underline">
        ← {tc('back')}
      </Link>
    </PremiumCard>
  );
}
