import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getCategorySettings } from '@/lib/config/settings-service';
import { COUPON_CATEGORIES } from '@/lib/config/coupon-settings';
import { SectionHeading } from '@/components/ui/card';
import { CategorySettingsForm } from './category-form';

export const dynamic = 'force-dynamic';

export default async function CouponSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const settings = await getCategorySettings();

  return (
    <div className="space-y-8">
      <SectionHeading title={t('couponSettings')} description={t('couponSettingsHint')} />
      {COUPON_CATEGORIES.map((category) => (
        <CategorySettingsForm key={category} settings={settings[category]} />
      ))}
    </div>
  );
}
