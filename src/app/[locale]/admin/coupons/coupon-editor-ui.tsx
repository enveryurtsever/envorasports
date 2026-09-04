'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';
import { PremiumCard } from '@/components/ui/card';
import { EMPTY_STATE, type ActionState } from '@/services/admin/action-state';
import {
  addCouponSelection,
  removeCoupon,
  removeCouponSelection,
} from '@/services/admin/coupon-actions';

export interface EditorCoupon {
  id: string;
  reference: string;
  category: string;
  kind: string;
  resultStatus: string;
  targetDate: string;
  totalOdds: number;
  estimatedProbability: number;
  expectedValue: number;
  selectionCount: number;
  system: { systemType: string; columnCount: number; totalStake: number } | null;
  selections: Array<{
    id: string;
    label: string;
    kickoff: string;
    marketCode: string;
    selectionCode: string;
    odds: number;
    probability: number;
    resultStatus: string;
  }>;
}

/**
 * Coupon editing.
 *
 * Nothing here computes a total: every change posts to the server, which
 * recalculates odds, probability and EV from the surviving selections and sends
 * back the updated page. The number on screen is always the stored number.
 */
export function CouponEditor({
  coupon,
  additions,
}: {
  coupon: EditorCoupon;
  additions: Array<{ predictionId: string; label: string }>;
}) {
  const t = useTranslations('admin');
  const tm = useTranslations('metrics');
  const tCat = useTranslations('categories');

  const [removeState, removeAction, removePending] = useActionState<ActionState, FormData>(
    removeCouponSelection,
    EMPTY_STATE,
  );
  const [addState, addAction, addPending] = useActionState<ActionState, FormData>(
    addCouponSelection,
    EMPTY_STATE,
  );
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(
    removeCoupon,
    EMPTY_STATE,
  );

  const editable = coupon.resultStatus === 'PENDING';
  const issues = [...removeState.issues, ...addState.issues, ...deleteState.issues];

  return (
    <PremiumCard accent={coupon.kind === 'SYSTEM' ? 'gold' : 'emerald'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs tracking-wide text-muted uppercase">
            {coupon.reference} · {coupon.targetDate}
          </p>
          <h3 className="mt-1 font-semibold">{tCat(`${coupon.category}.name`)}</h3>
          {coupon.system ? (
            <p className="text-xs text-gold-light">
              {coupon.system.systemType} · {coupon.system.columnCount} {tm('columns')} ·{' '}
              {coupon.system.totalStake.toFixed(2)} {tm('totalStake')}
            </p>
          ) : null}
        </div>

        <div className="tabular flex items-center gap-4 text-sm">
          <span>
            <span className="text-muted">{tm('odds')} </span>
            <span className="font-semibold">{coupon.totalOdds.toFixed(2)}</span>
          </span>
          <span>
            <span className="text-muted">P </span>
            <span className="font-semibold">{(coupon.estimatedProbability * 100).toFixed(1)}%</span>
          </span>
          <span>
            <span className="text-muted">{tm('ev')} </span>
            <span
              className={coupon.expectedValue >= 0 ? 'font-semibold text-emerald-bright' : 'font-semibold text-rose-300'}
            >
              {(coupon.expectedValue * 100).toFixed(1)}%
            </span>
          </span>
        </div>
      </div>

      <ul className="mt-4 divide-y divide-white/10 rounded-lg border border-white/10">
        {coupon.selections.map((selection) => (
          <li key={selection.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{selection.label}</p>
              <p className="text-xs text-muted">
                {selection.kickoff} · {selection.marketCode} · {selection.selectionCode}
              </p>
            </div>
            <span className="tabular text-sm font-semibold">{selection.odds.toFixed(2)}</span>
            <span className="tabular text-xs text-muted">
              {(selection.probability * 100).toFixed(0)}%
            </span>

            {editable && coupon.selections.length > 1 ? (
              <form action={removeAction}>
                <input type="hidden" name="couponId" value={coupon.id} />
                <input type="hidden" name="selectionId" value={selection.id} />
                <button
                  type="submit"
                  disabled={removePending}
                  aria-label={t('removeSelection')}
                  className="rounded-md border border-white/15 px-2 py-1 text-xs transition-colors hover:border-rose-500/60 hover:text-rose-300 disabled:opacity-50"
                >
                  {t('remove')}
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>

      {editable ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <form action={addAction} className="flex flex-1 items-end gap-2">
            <input type="hidden" name="couponId" value={coupon.id} />
            <label className="min-w-0 flex-1">
              <span className="text-xs text-muted uppercase">{t('addSelection')}</span>
              <select
                name="predictionId"
                required
                className="mt-1 w-full rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {additions.map((option) => (
                  <option key={option.predictionId} value={option.predictionId}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={addPending || additions.length === 0}
              className="rounded-lg bg-emerald-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {t('add')}
            </button>
          </form>

          <form action={deleteAction}>
            <input type="hidden" name="couponId" value={coupon.id} />
            <button
              type="submit"
              disabled={deletePending}
              className="rounded-lg border border-rose-500/40 px-4 py-2 text-sm text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
            >
              {t('deleteCoupon')}
            </button>
          </form>
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-dark">{t('settledNotEditable')}</p>
      )}

      {issues.length > 0 ? (
        <ul className="mt-3 list-inside list-disc text-xs text-rose-300">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
    </PremiumCard>
  );
}
