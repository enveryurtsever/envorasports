'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { EMPTY_STATE, type ActionState } from '@/services/admin/action-state';
import { toggleMatchExclusion } from '@/services/admin/coupon-actions';

/**
 * Excluding a match also pulls it off any pending coupon, and those coupons are
 * recalculated server-side — so a removed match cannot leave a stale total
 * behind.
 */
export function MatchExclusionRow({
  match,
}: {
  match: {
    id: string;
    kickoff: string;
    label: string;
    league: string;
    excluded: boolean;
    reason: string | null;
    prices: number;
    predictions: number;
    onCoupons: number;
  };
}) {
  const t = useTranslations('admin');
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    toggleMatchExclusion,
    EMPTY_STATE,
  );

  return (
    <tr className={match.excluded ? 'opacity-60' : undefined}>
      <td className="px-4 py-2 text-xs whitespace-nowrap text-muted">{match.kickoff}</td>
      <td className="px-4 py-2">
        <p className="font-medium">{match.label}</p>
        <p className="text-xs text-muted">{match.league}</p>
        {match.excluded && match.reason ? (
          <p className="text-xs text-gold-light">{match.reason}</p>
        ) : null}
        {state.issues.length > 0 ? (
          <p className="text-xs text-rose-300">{state.issues.join('; ')}</p>
        ) : null}
      </td>
      <td className="tabular px-4 py-2 text-right">{match.prices}</td>
      <td className="tabular px-4 py-2 text-right">{match.predictions}</td>
      <td className="tabular px-4 py-2 text-right">{match.onCoupons}</td>
      <td className="px-4 py-2">
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="matchId" value={match.id} />
          <input type="hidden" name="excluded" value={String(!match.excluded)} />
          {!match.excluded ? (
            <input
              type="text"
              name="reason"
              placeholder={t('exclusionReason')}
              className="w-32 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs"
            />
          ) : null}
          <button
            type="submit"
            disabled={pending}
            className={
              match.excluded
                ? 'rounded-md border border-emerald-primary/50 px-2 py-1 text-xs text-emerald-bright disabled:opacity-50'
                : 'rounded-md border border-white/15 px-2 py-1 text-xs transition-colors hover:border-rose-500/60 hover:text-rose-300 disabled:opacity-50'
            }
          >
            {match.excluded ? t('include') : t('exclude')}
          </button>
        </form>
      </td>
    </tr>
  );
}
