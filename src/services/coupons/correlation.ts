import { prisma } from '@/lib/db/prisma';

/**
 * Correlation between selections (§33).
 *
 * Treating a coupon's legs as independent overstates its true probability, and
 * the worst offenders are legs from the same match: "Home win" and "Home -1"
 * are close to the same bet at different prices.
 *
 * This starts as a rule-based matrix loaded from the database. Replacing it
 * with a fitted statistical model later means changing this file and nothing
 * else.
 */

const WILDCARD = '*';

export interface CorrelationRule {
  marketCodeA: string;
  selectionCodeA: string;
  marketCodeB: string;
  selectionCodeB: string;
  coefficient: number;
  sameMatchOnly: boolean;
}

export interface CorrelationMatrix {
  /** 0..1 for a pair; 0 when nothing links them. */
  between(a: SelectionRef, b: SelectionRef): number;
  rules: number;
}

export interface SelectionRef {
  matchId: string;
  marketCode: string;
  selectionCode: string;
}

function keysFor(marketCode: string, selectionCode: string): string[] {
  return [
    `${marketCode}:${selectionCode}`,
    `${marketCode}:${WILDCARD}`,
  ];
}

export async function loadCorrelationMatrix(): Promise<CorrelationMatrix> {
  const rows = await prisma.marketCorrelation.findMany({
    select: {
      marketCodeA: true,
      selectionCodeA: true,
      marketCodeB: true,
      selectionCodeB: true,
      coefficient: true,
      sameMatchOnly: true,
    },
  });

  // Indexed both ways: correlation is symmetric, the stored rule is not.
  const index = new Map<string, { coefficient: number; sameMatchOnly: boolean }>();
  for (const row of rows) {
    const a = `${row.marketCodeA}:${row.selectionCodeA}`;
    const b = `${row.marketCodeB}:${row.selectionCodeB}`;
    const value = { coefficient: Number(row.coefficient), sameMatchOnly: row.sameMatchOnly };
    index.set(`${a}|${b}`, value);
    index.set(`${b}|${a}`, value);
  }

  return {
    rules: rows.length,
    between(a: SelectionRef, b: SelectionRef): number {
      // Two legs on the same match are correlated even without an explicit
      // rule — they share the same 90 minutes.
      const sameMatch = a.matchId === b.matchId;

      let best = 0;
      for (const keyA of keysFor(a.marketCode, a.selectionCode)) {
        for (const keyB of keysFor(b.marketCode, b.selectionCode)) {
          const rule = index.get(`${keyA}|${keyB}`);
          if (!rule) continue;
          if (rule.sameMatchOnly && !sameMatch) continue;
          best = Math.max(best, Math.abs(rule.coefficient));
        }
      }

      // Baseline for any same-match pair with no specific rule.
      if (sameMatch) best = Math.max(best, 0.35);
      return Math.min(1, best);
    },
  };
}

/** The strongest correlation between a candidate and everything already picked. */
export function maxCorrelationWith(
  matrix: CorrelationMatrix,
  candidate: SelectionRef,
  chosen: readonly SelectionRef[],
): number {
  let max = 0;
  for (const existing of chosen) {
    max = Math.max(max, matrix.between(candidate, existing));
  }
  return max;
}

/**
 * Average pairwise correlation across a whole coupon — the figure stored on the
 * coupon and penalised in its score (§34).
 */
export function couponCorrelation(
  matrix: CorrelationMatrix,
  selections: readonly SelectionRef[],
): number {
  if (selections.length < 2) return 0;

  let total = 0;
  let pairs = 0;
  for (let i = 0; i < selections.length; i++) {
    for (let j = i + 1; j < selections.length; j++) {
      total += matrix.between(selections[i] as SelectionRef, selections[j] as SelectionRef);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}
