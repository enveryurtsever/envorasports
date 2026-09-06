import type { Decimal } from '@/lib/math/decimal';

/**
 * Model contracts (§26).
 *
 * Every model emits the same shape — a probability per selection code — so the
 * ensemble does not need to know how any of them work, and adding a model is
 * additive rather than a rewrite.
 */

export type SelectionProbabilities = Map<string, Decimal>;

export interface ModelOutput {
  name: string;
  /**
   * False when the model had nothing usable to work with (no xG, no history).
   * The ensemble redistributes its weight rather than treating absence as 0.5.
   */
  available: boolean;
  /**
   * Why the model did not run, when it did not. Carried through to the stored
   * breakdown: "xg contributed nothing" and "xg had no data" are different
   * facts, and only one of them is a reason to change the configuration.
   */
  unavailableReason?: string;
  /** 0..1 — how much this model trusts itself given the data it saw. */
  confidence: number;
  probabilities: SelectionProbabilities;
  /** Real feature values, for the "why this pick" panel (§48). Never invented. */
  features: Record<string, number | string | null>;
}

export interface MatchContext {
  matchId: string;
  leagueId: string;
  seasonId: string;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: Date;
  /** The instant the model is allowed to see data up to (§57). */
  asOf: Date;
}

/** Markets grouped so probabilities can be renormalised within each group. */
export const MARKET_GROUPS: Record<string, string[]> = {
  MATCH_RESULT: ['MS_1', 'MS_X', 'MS_2'],
  HALF_TIME_RESULT: ['HT_1', 'HT_X', 'HT_2'],
  BTTS: ['BTTS_YES', 'BTTS_NO'],
  DOUBLE_CHANCE: ['DOUBLE_CHANCE_1X', 'DOUBLE_CHANCE_X2', 'DOUBLE_CHANCE_12'],
};

export function unavailable(name: string, reason: string): ModelOutput {
  return {
    name,
    available: false,
    unavailableReason: reason,
    confidence: 0,
    probabilities: new Map(),
    features: { reason },
  };
}
