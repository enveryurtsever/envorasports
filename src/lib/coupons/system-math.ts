import { Decimal, dec, toMoney, toOdds, type DecimalInput } from '@/lib/math/decimal';
import {
  assertColumnCountWithinLimit,
  combinationCount,
  combinations,
} from '@/lib/math/combinatorics';
import { combinedOdds } from '@/lib/math/probability';

/**
 * System (combination) coupon arithmetic (§18, §34).
 *
 * The rule this module exists to enforce: a system coupon is N independent
 * columns, not one big accumulator. Computing the return as
 * `total_stake * product(all base odds)` is the classic wrong answer and would
 * overstate payouts by orders of magnitude.
 */

export interface SystemSelectionInput {
  /** Stable identifier, used to build reproducible columns. */
  id: string;
  odds: DecimalInput;
  matchId: string;
}

export interface SystemColumn {
  columnIndex: number;
  selectionIds: string[];
  combinedOdds: Decimal;
  stake: Decimal;
}

export interface SystemPlan {
  systemType: string;
  baseSelectionCount: number;
  systemSelectionCount: number;
  columnCount: number;
  stakePerColumn: Decimal;
  totalStake: Decimal;
  columns: SystemColumn[];
}

export interface BuildSystemOptions {
  selections: readonly SystemSelectionInput[];
  /** k — selections per column. */
  systemSelectionCount: number;
  stakePerColumn: DecimalInput;
  maxTotalStake?: DecimalInput;
}

export class SystemPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPlanError';
  }
}

export function buildSystemPlan(options: BuildSystemOptions): SystemPlan {
  const { selections, systemSelectionCount: k } = options;
  const n = selections.length;

  const ids = new Set(selections.map((s) => s.id));
  if (ids.size !== n) {
    throw new SystemPlanError('Duplicate selection ids in the base set');
  }

  const count = combinationCount(n, k); // throws on k > n, negatives, non-integers
  assertColumnCountWithinLimit(count);

  const columnCount = Number(count);
  const stakePerColumn = toMoney(options.stakePerColumn);
  if (stakePerColumn.isNegative()) {
    throw new SystemPlanError('Stake per column cannot be negative');
  }

  // total_stake = column_count * stake_per_column (§18).
  const totalStake = toMoney(stakePerColumn.times(columnCount));

  if (options.maxTotalStake !== undefined && totalStake.greaterThan(dec(options.maxTotalStake))) {
    throw new SystemPlanError(
      `Total stake ${totalStake.toFixed(2)} exceeds the configured maximum ${dec(options.maxTotalStake).toFixed(2)}`,
    );
  }

  const columns: SystemColumn[] = [];
  let columnIndex = 0;
  for (const group of combinations(selections, k)) {
    columns.push({
      columnIndex,
      selectionIds: group.map((s) => s.id),
      combinedOdds: toOdds(combinedOdds(group.map((s) => s.odds))),
      stake: stakePerColumn,
    });
    columnIndex++;
  }

  return {
    systemType: `SYSTEM_${k}`,
    baseSelectionCount: n,
    systemSelectionCount: k,
    columnCount,
    stakePerColumn,
    totalStake,
    columns,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export type ColumnResult = 'PENDING' | 'WON' | 'LOST' | 'VOID';

export interface SettledColumn {
  columnIndex: number;
  result: ColumnResult;
  combinedOdds: Decimal;
  stake: Decimal;
  returnAmount: Decimal;
  netProfit: Decimal;
}

export interface SystemSettlement {
  columns: SettledColumn[];
  winningColumns: number;
  losingColumns: number;
  voidColumns: number;
  pendingColumns: number;
  totalStake: Decimal;
  totalReturn: Decimal;
  netProfit: Decimal;
  roi: Decimal;
  /** PARTIAL_WIN whenever some but not all columns won (§34). */
  status: 'PENDING' | 'WON' | 'LOST' | 'PARTIAL_WIN' | 'VOID';
}

/**
 * Settles every column independently and sums only the columns that actually
 * won. A void column returns its own stake — it is neither profit nor loss.
 */
export function settleSystem(
  columns: readonly { columnIndex: number; combinedOdds: DecimalInput; stake: DecimalInput; result: ColumnResult }[],
): SystemSettlement {
  const settled: SettledColumn[] = [];
  let totalStake = dec(0);
  let totalReturn = dec(0);
  let won = 0;
  let lost = 0;
  let voided = 0;
  let pending = 0;

  for (const column of columns) {
    const stake = toMoney(column.stake);
    const odds = dec(column.combinedOdds);
    totalStake = totalStake.plus(stake);

    let returnAmount = dec(0);
    switch (column.result) {
      case 'WON':
        returnAmount = toMoney(stake.times(odds));
        won++;
        break;
      case 'VOID':
        // Stake returned, no profit.
        returnAmount = stake;
        voided++;
        break;
      case 'LOST':
        lost++;
        break;
      case 'PENDING':
        pending++;
        break;
    }

    totalReturn = totalReturn.plus(returnAmount);
    settled.push({
      columnIndex: column.columnIndex,
      result: column.result,
      combinedOdds: odds,
      stake,
      returnAmount,
      netProfit: toMoney(returnAmount.minus(stake)),
    });
  }

  totalStake = toMoney(totalStake);
  totalReturn = toMoney(totalReturn);
  const netProfit = toMoney(totalReturn.minus(totalStake));
  const roi = totalStake.isZero() ? dec(0) : netProfit.dividedBy(totalStake);

  return {
    columns: settled,
    winningColumns: won,
    losingColumns: lost,
    voidColumns: voided,
    pendingColumns: pending,
    totalStake,
    totalReturn,
    netProfit,
    roi,
    status: aggregateStatus({ won, lost, voided, pending, total: columns.length }),
  };
}

function aggregateStatus(counts: {
  won: number;
  lost: number;
  voided: number;
  pending: number;
  total: number;
}): SystemSettlement['status'] {
  if (counts.total === 0) return 'PENDING';
  // A coupon is only final once every column is final.
  if (counts.pending > 0) return 'PENDING';
  if (counts.voided === counts.total) return 'VOID';
  if (counts.won === 0) return 'LOST';
  if (counts.won + counts.voided === counts.total) return 'WON';
  return 'PARTIAL_WIN';
}
