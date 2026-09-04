/**
 * Market settlement contracts (§32).
 *
 * Each market gets its own evaluator behind a registry. A single score-based
 * `if/else` would settle Half-Time Result against the full-time score, which is
 * exactly the class of bug this structure exists to prevent.
 */

export type SettlementOutcome =
  | 'PENDING'
  | 'WON'
  | 'LOST'
  | 'PUSHED'
  | 'HALF_WON'
  | 'HALF_LOST'
  | 'VOID'
  | 'CANCELED';

export type MatchLifecycle =
  | 'SCHEDULED'
  | 'LIVE'
  | 'HALF_TIME'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELED'
  | 'SUSPENDED'
  | 'ABANDONED'
  | 'AWARDED';

/** Everything an evaluator is allowed to see. Nothing else. */
export interface MatchResultInput {
  status: MatchLifecycle;
  homeScore: number | null;
  awayScore: number | null;
  halfTimeHomeScore: number | null;
  halfTimeAwayScore: number | null;
  /** Official totals, only present once statistics have been ingested. */
  totalCorners: number | null;
  totalCards: number | null;
}

export interface SelectionContext {
  marketCode: string;
  selectionCode: string;
  parameters: Record<string, unknown> | null;
  /** Line for handicap/total markets, when it lives outside `parameters`. */
  handicap: number;
}

export interface MarketSettlementEvaluator {
  readonly marketCode: string;
  evaluate(selection: SelectionContext, result: MatchResultInput): SettlementOutcome;
}

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettlementError';
  }
}

// --- shared helpers --------------------------------------------------------

export function fullTimeOutcome(result: MatchResultInput): 'HOME' | 'DRAW' | 'AWAY' | null {
  if (result.homeScore === null || result.awayScore === null) return null;
  if (result.homeScore > result.awayScore) return 'HOME';
  if (result.homeScore < result.awayScore) return 'AWAY';
  return 'DRAW';
}

export function halfTimeOutcome(result: MatchResultInput): 'HOME' | 'DRAW' | 'AWAY' | null {
  if (result.halfTimeHomeScore === null || result.halfTimeAwayScore === null) return null;
  if (result.halfTimeHomeScore > result.halfTimeAwayScore) return 'HOME';
  if (result.halfTimeHomeScore < result.halfTimeAwayScore) return 'AWAY';
  return 'DRAW';
}

export function totalGoals(result: MatchResultInput): number | null {
  if (result.homeScore === null || result.awayScore === null) return null;
  return result.homeScore + result.awayScore;
}

export function readNumber(
  parameters: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = parameters?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readString(
  parameters: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = parameters?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Lifecycle gate applied before any market logic.
 *
 * A postponed match is NOT a loss (§31) — it is void or still pending, and
 * getting this wrong silently books losses against users.
 */
export function lifecycleOutcome(result: MatchResultInput): SettlementOutcome | null {
  switch (result.status) {
    case 'FINISHED':
    case 'AWARDED':
      return null; // proceed to market logic
    case 'SCHEDULED':
    case 'LIVE':
    case 'HALF_TIME':
    case 'SUSPENDED':
      return 'PENDING';
    case 'POSTPONED':
      // Rescheduled, not decided. Settlement stays paused.
      return 'PENDING';
    case 'CANCELED':
    case 'ABANDONED':
      return 'VOID';
  }
}
