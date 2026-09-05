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
  /** Model probability, when known. Enables the expected-return figures. */
  probability?: DecimalInput;
}

/**
 * Distribution of "how many of these land", assuming independence.
 *
 * A system's whole point is that it pays without every leg winning, so the
 * meaningful probability is P(at least k win) — not the product of all of them.
 * That needs the full distribution, which this builds in O(n²).
 */
export function winCountDistribution(probabilities: readonly number[]): number[] {
  let distribution = [1];

  for (const p of probabilities) {
    const q = Math.min(1, Math.max(0, p));
    const next = new Array<number>(distribution.length + 1).fill(0);

    for (let wins = 0; wins < distribution.length; wins++) {
      const mass = distribution[wins] as number;
      if (mass === 0) continue;
      next[wins] = (next[wins] as number) + mass * (1 - q);
      next[wins + 1] = (next[wins + 1] as number) + mass * q;
    }
    distribution = next;
  }

  return distribution;
}

/** P(at least `k` of them land). */
export function probabilityOfAtLeast(probabilities: readonly number[], k: number): number {
  const distribution = winCountDistribution(probabilities);
  let total = 0;
  for (let wins = k; wins < distribution.length; wins++) total += distribution[wins] as number;
  return Math.min(1, Math.max(0, total));
}

export interface SystemColumn {
  columnIndex: number;
  /** How many legs this column contains — a Turkish system mixes sizes. */
  size: number;
  selectionIds: string[];
  combinedOdds: Decimal;
  stake: Decimal;
}

export interface SystemPlan {
  /** Storage form, e.g. "SYSTEM_4_5_6". */
  systemType: string;
  /** Display form, e.g. "4,5,6" — how a Turkish slip reads. */
  systemLabel: string;
  baseSelectionCount: number;
  /** Every column size in the system, ascending. */
  systemSizes: number[];
  /** Kept for the common single-size case; the smallest size. */
  systemSelectionCount: number;
  columnCount: number;
  /** Column count per size, so the slip can show the breakdown. */
  columnsBySize: Record<number, number>;
  stakePerColumn: Decimal;
  totalStake: Decimal;
  /**
   * What the coupon pays if every column wins: the sum of each column's own
   * odds times its stake. Not derivable from the accumulator odds, because a
   * system is many independent columns rather than one big multiply.
   */
  maxReturn: Decimal;
  /**
   * Expected return across every column, weighted by how likely each is to
   * land. Null when the caller supplied no probabilities.
   */
  expectedReturn: Decimal | null;
  /**
   * P(the coupon returns anything) — the chance at least the smallest column
   * size lands. This is the figure worth showing for a system; the product of
   * all legs is close to zero and says nothing useful.
   */
  returnProbability: number | null;
  columns: SystemColumn[];
}

export interface BuildSystemOptions {
  selections: readonly SystemSelectionInput[];
  /**
   * Column sizes. A Turkish system routinely combines several — "Sistem 4,5,6"
   * over 8 legs is C(8,4) + C(8,5) + C(8,6) columns on one slip, and the stake
   * and maximum return follow from that total.
   */
  systemSizes: number[];
  stakePerColumn: DecimalInput;
  maxTotalStake?: DecimalInput;
}

/** "SYSTEM_4_5_6" -> [4, 5, 6]; also accepts the legacy single-size form. */
export function parseSystemSizes(systemType: string): number[] {
  const match = /^SYSTEM_([\d_]+)$/.exec(systemType);
  if (!match) return [];
  return (match[1] as string)
    .split('_')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

export function formatSystemType(sizes: number[]): string {
  return `SYSTEM_${[...sizes].sort((a, b) => a - b).join('_')}`;
}

export function formatSystemLabel(sizes: number[]): string {
  return [...sizes].sort((a, b) => a - b).join(',');
}

export class SystemPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SystemPlanError';
  }
}

export function buildSystemPlan(options: BuildSystemOptions): SystemPlan {
  const { selections } = options;
  const n = selections.length;

  const ids = new Set(selections.map((s) => s.id));
  if (ids.size !== n) {
    throw new SystemPlanError('Duplicate selection ids in the base set');
  }

  const sizes = [...new Set(options.systemSizes)].sort((a, b) => a - b);
  if (sizes.length === 0) {
    throw new SystemPlanError('A system needs at least one column size');
  }
  // A single-leg column is a straight bet, not a system, and the product does
  // not offer one-match coupons at all.
  if (sizes.some((k) => k < 2)) {
    throw new SystemPlanError('System column sizes must be at least 2');
  }

  // Validates every size against n, and refuses k > n.
  let total = 0n;
  const columnsBySize: Record<number, number> = {};
  for (const k of sizes) {
    const count = combinationCount(n, k);
    columnsBySize[k] = Number(count);
    total += count;
  }
  assertColumnCountWithinLimit(total);

  const columnCount = Number(total);
  const stakePerColumn = toMoney(options.stakePerColumn);
  if (stakePerColumn.isNegative()) {
    throw new SystemPlanError('Stake per column cannot be negative');
  }

  // total_stake = column_count * stake_per_column, summed across every size.
  const totalStake = toMoney(stakePerColumn.times(columnCount));

  if (options.maxTotalStake !== undefined && totalStake.greaterThan(dec(options.maxTotalStake))) {
    throw new SystemPlanError(
      `Total stake ${totalStake.toFixed(2)} exceeds the configured maximum ${dec(options.maxTotalStake).toFixed(2)}`,
    );
  }

  const columns: SystemColumn[] = [];
  let columnIndex = 0;
  for (const k of sizes) {
    for (const group of combinations(selections, k)) {
      columns.push({
        columnIndex,
        size: k,
        selectionIds: group.map((s) => s.id),
        combinedOdds: toOdds(combinedOdds(group.map((s) => s.odds))),
        stake: stakePerColumn,
      });
      columnIndex++;
    }
  }

  const maxReturn = toMoney(
    columns.reduce<Decimal>((sum, column) => sum.plus(column.combinedOdds.times(column.stake)), dec(0)),
  );

  // Expected value figures need per-leg probabilities; without them the caller
  // gets nulls rather than a number invented from the odds.
  const probabilityById = new Map<string, number>();
  for (const selection of selections) {
    if (selection.probability !== undefined) {
      probabilityById.set(selection.id, Number(dec(selection.probability)));
    }
  }

  let expectedReturn: Decimal | null = null;
  let returnProbability: number | null = null;

  if (probabilityById.size === n) {
    expectedReturn = toMoney(
      columns.reduce<Decimal>((sum, column) => {
        const columnProbability = column.selectionIds.reduce(
          (product, id) => product * (probabilityById.get(id) ?? 0),
          1,
        );
        return sum.plus(column.combinedOdds.times(column.stake).times(columnProbability));
      }, dec(0)),
    );

    returnProbability = probabilityOfAtLeast(
      selections.map((s) => probabilityById.get(s.id) ?? 0),
      sizes[0] as number,
    );
  }

  return {
    systemType: formatSystemType(sizes),
    systemLabel: formatSystemLabel(sizes),
    baseSelectionCount: n,
    systemSizes: sizes,
    systemSelectionCount: sizes[0] as number,
    columnCount,
    columnsBySize,
    stakePerColumn,
    totalStake,
    maxReturn,
    expectedReturn,
    returnProbability,
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
