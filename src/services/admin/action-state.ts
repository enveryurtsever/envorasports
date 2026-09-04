/**
 * Shared shape for admin form actions.
 *
 * Kept out of the 'use server' module on purpose: a server-actions file may only
 * export async functions, so a constant exported from there arrives as
 * `undefined` on the client and every read of it throws.
 */
export interface ActionState {
  ok: boolean;
  message: string | null;
  issues: string[];
}

export const EMPTY_STATE: ActionState = { ok: false, message: null, issues: [] };
