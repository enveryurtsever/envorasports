'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { triggerJob } from '@/services/admin/settings-actions';
import { EMPTY_STATE, type ActionState } from '@/services/admin/action-state';
import { PremiumCard, SectionHeading } from '@/components/ui/card';

const JOBS = [
  { name: 'bulletin-publication', force: true },
  { name: 'fixture-topup', force: false },
  { name: 'match-odds', force: false },
  { name: 'rebuild-features', force: false },
  { name: 'narrate-analyses', force: false },
  { name: 'result-sync', force: false },
  { name: 'settlement', force: false },
  { name: 'historical-import', force: false },
] as const;

/** Manual job triggers (§39). Each runs through the same locked, idempotent path. */
export function JobTriggerPanel() {
  const t = useTranslations('admin');
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    triggerJob,
    EMPTY_STATE,
  );

  return (
    <section>
      <SectionHeading title={t('manualTriggers')} description={t('manualTriggersHint')} />
      <PremiumCard>
        <div className="flex flex-wrap gap-2">
          {JOBS.map((job) => (
            <form key={job.name} action={formAction}>
              <input type="hidden" name="job" value={job.name} />
              <input type="hidden" name="force" value={String(job.force)} />
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg border border-white/15 px-3 py-2 text-sm transition-colors hover:border-emerald-bright disabled:opacity-50"
              >
                {job.name}
                {job.force ? ` (${t('forced')})` : ''}
              </button>
            </form>
          ))}
        </div>

        {state.message ? (
          <p className={`mt-3 text-sm ${state.ok ? 'text-emerald-bright' : 'text-rose-300'}`}>
            {state.message}
            {state.issues.length > 0 ? `: ${state.issues.join('; ')}` : ''}
          </p>
        ) : null}
      </PremiumCard>
    </section>
  );
}
