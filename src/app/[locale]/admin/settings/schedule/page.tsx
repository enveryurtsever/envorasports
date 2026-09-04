import { getTranslations, setRequestLocale } from 'next-intl/server';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import { SectionHeading } from '@/components/ui/card';
import { ScheduleForm } from './schedule-form';

export const dynamic = 'force-dynamic';

export default async function ScheduleSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin');
  const schedule = await getBulletinSchedule();

  return (
    <div className="space-y-6">
      <SectionHeading title={t('scheduleSettings')} description={t('scheduleSettingsHint')} />
      <ScheduleForm schedule={schedule} />
    </div>
  );
}
