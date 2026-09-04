'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { saveCategorySettings } from '@/services/admin/settings-actions';
import { EMPTY_STATE, type ActionState } from '@/services/admin/action-state';
import { SETTING_RANGES, type CouponCategorySettings } from '@/lib/config/coupon-settings';
import { PremiumCard } from '@/components/ui/card';

/** Numeric fields rendered generically, each with its declared valid range (§19). */
const NUMERIC_FIELDS = [
  'couponCount',
  'minTotalOdds',
  'maxTotalOdds',
  'minSelections',
  'maxSelections',
  'minConfidence',
  'minExpectedValue',
  'minEdge',
  'minProbability',
  'maxRisk',
  'maxCorrelation',
  'minDataQuality',
] as const;

export function CategorySettingsForm({ settings }: { settings: CouponCategorySettings }) {
  const t = useTranslations('admin');
  const tCat = useTranslations('categories');
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    saveCategorySettings,
    EMPTY_STATE,
  );

  return (
    <PremiumCard>
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="category" value={settings.category} />

        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">{tCat(`${settings.category}.name`)}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
            {t('enabled')}
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC_FIELDS.map((field) => {
            const range = SETTING_RANGES[field];
            const value = settings[field];
            return (
              <label key={field} className="block">
                <span className="text-xs text-muted uppercase">{t(`field.${field}`)}</span>
                <input
                  type="number"
                  name={field}
                  defaultValue={value === null ? '' : String(value)}
                  min={range?.min}
                  max={range?.max}
                  step={range?.step}
                  className="tabular mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
                />
                {range ? (
                  <span className="text-[0.65rem] text-muted-dark">
                    {t('validRange', { min: range.min, max: range.max })}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>

        <label className="block">
          <span className="text-xs text-muted uppercase">{t('allowedMarkets')}</span>
          <input
            type="text"
            name="allowedMarkets"
            defaultValue={settings.allowedMarkets.join(', ')}
            placeholder={t('allowedMarketsHint')}
            className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="oneSelectionPerMatch"
            defaultChecked={settings.oneSelectionPerMatch}
          />
          {t('oneSelectionPerMatch')}
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {t('save')}
          </button>
          <button
            type="reset"
            className="rounded-lg border border-white/15 px-4 py-2 text-sm"
          >
            {t('reset')}
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
