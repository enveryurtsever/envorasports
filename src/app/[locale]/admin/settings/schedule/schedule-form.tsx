'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveSchedule } from '@/services/admin/settings-actions';
import { EMPTY_STATE, type ActionState } from '@/services/admin/action-state';
import { WEEKDAY_KEYS, type BulletinSchedule } from '@/lib/schedule/bulletin-schedule';
import { PremiumCard } from '@/components/ui/card';

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function ScheduleForm({ schedule }: { schedule: BulletinSchedule }) {
  const t = useTranslations('admin');
  const ts = useTranslations('schedule');
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveSchedule,
    EMPTY_STATE,
  );

  return (
    <PremiumCard>
      <form action={formAction} className="space-y-5">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="enabled" defaultChecked={schedule.enabled} />
          {t('enabled')}
        </label>

        <fieldset>
          <legend className="text-xs text-muted uppercase">{ts('publicationDay')}</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <label
                key={day}
                className="flex items-center gap-2 rounded-lg border border-white/15 px-3 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  name="publicationWeekdays"
                  value={day}
                  defaultChecked={schedule.publicationWeekdays.includes(day)}
                />
                {ts(`weekday.${WEEKDAY_KEYS[day]}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <span className="text-xs text-muted uppercase">{t('field.coverageOffsetDays')}</span>
            <input
              type="number"
              name="coverageOffsetDays"
              min={0}
              max={14}
              defaultValue={schedule.coverageOffsetDays}
              className="tabular mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted uppercase">{t('field.coverageDays')}</span>
            <input
              type="number"
              name="coverageDays"
              min={1}
              max={14}
              defaultValue={schedule.coverageDays}
              className="tabular mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted uppercase">{t('field.publishTimeLocal')}</span>
            <input
              type="time"
              name="publishTimeLocal"
              defaultValue={schedule.publishTimeLocal}
              className="tabular mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted uppercase">{ts('timezone')}</span>
            <input
              type="text"
              name="timezone"
              defaultValue={schedule.timezone}
              className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
            />
          </label>
        </div>

        <label className="block max-w-xs">
          <span className="text-xs text-muted uppercase">{t('field.grouping')}</span>
          <select
            name="grouping"
            defaultValue={schedule.grouping}
            className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
          >
            <option value="PER_DAY">PER_DAY</option>
            <option value="WINDOW">WINDOW</option>
          </select>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {t('save')}
          </button>
          {state.message ? (
            <span className={`text-sm ${state.ok ? 'text-emerald-bright' : 'text-rose-300'}`}>
              {state.ok ? t('saved') : t('invalid')}
            </span>
          ) : null}
        </div>

        {state.issues.length > 0 ? (
          <ul className="list-inside list-disc text-xs text-rose-300">
            {state.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        ) : null}
      </form>
    </PremiumCard>
  );
}
