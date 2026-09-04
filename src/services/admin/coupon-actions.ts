'use server';

import { revalidatePath } from 'next/cache';
import { getViewer } from '@/lib/auth/session';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import {
  CouponEditError,
  addSelection,
  deleteCoupon,
  removeSelection,
  setMatchExcluded,
} from '@/services/coupons/coupon-editor';
import type { ActionState } from './action-state';

const log = createLogger('admin:coupons');

async function requireAdmin() {
  const viewer = await getViewer();
  if (!viewer.isAdmin) throw new Error('forbidden');
  return viewer;
}

/** Wraps an edit so a validation failure becomes a message, not a stack trace. */
async function run(action: () => Promise<void>, paths: string[]): Promise<ActionState> {
  try {
    await action();
    for (const path of paths) revalidatePath(path);
    return { ok: true, message: 'saved', issues: [] };
  } catch (error) {
    if (error instanceof CouponEditError) {
      return { ok: false, message: 'rejected', issues: [error.message] };
    }
    log.error('admin coupon action failed', { error: String(error) });
    return { ok: false, message: 'failed', issues: [String(error)] };
  }
}

export async function removeCouponSelection(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const couponId = String(formData.get('couponId'));
  const selectionId = String(formData.get('selectionId'));

  return run(async () => {
    // Totals are recomputed inside; they can never drift from the selections.
    await removeSelection(couponId, selectionId);
  }, ['/admin/coupons', '/predictions']);
}

export async function addCouponSelection(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const couponId = String(formData.get('couponId'));
  const predictionId = String(formData.get('predictionId'));

  return run(async () => {
    await addSelection(couponId, predictionId);
  }, ['/admin/coupons', '/predictions']);
}

export async function removeCoupon(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();
  const couponId = String(formData.get('couponId'));

  return run(async () => {
    await deleteCoupon(couponId);
  }, ['/admin/coupons', '/predictions', '/']);
}

export async function toggleMatchExclusion(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin();
  const matchId = String(formData.get('matchId'));
  const excluded = formData.get('excluded') === 'true';
  const reason = String(formData.get('reason') ?? '').trim() || undefined;

  return run(async () => {
    await setMatchExcluded(matchId, excluded, reason);

    // Excluding a match should not leave it sitting on a live coupon.
    if (excluded) {
      const affected = await prisma.couponSelection.findMany({
        where: { matchId, coupon: { resultStatus: 'PENDING' } },
        select: { id: true, couponId: true },
      });

      for (const selection of affected) {
        try {
          await removeSelection(selection.couponId, selection.id);
        } catch (error) {
          // A coupon down to its last leg cannot lose it; leave it for the
          // operator to delete deliberately.
          log.warn('could not auto-remove selection from coupon', {
            couponId: selection.couponId,
            error: String(error),
          });
        }
      }
    }
  }, ['/admin/matches', '/admin/coupons', '/matches', '/predictions']);
}
