import { dec } from '@/lib/math/decimal';
import type { BuiltCoupon, Candidate } from './coupon-generator';

/**
 * One match, several goal markets, one opinion.
 *
 * A surprise coupon built the ordinary way — five legs from five matches at
 * 30% each — has a stated chance of about a quarter of one percent, and the
 * five that settled all lost with 0.011 expected winners between them. That
 * is not a surprise, it is a lottery ticket.
 *
 * The goal markets on a single match are not independent bets; they are faces
 * of the same event. Measured over 33,912 finished matches, when a match goes
 * over 3.5 both teams have scored 86.7% of the time, and when it reaches six
 * goals, 93.4%. So a stack of over lines plus BTTS on one match is, near
 * enough, one bet — the hardest over line — with the rest riding on it. The
 * price multiplies as if they were independent; the chance does not divide.
 *
 * The stated chance is therefore the model's probability for the hardest goal
 * line, times the measured rate at which BTTS accompanies it. Never the naive
 * product, which would put a 35% event at 8% and call the coupon honest.
 */

/** P(BTTS | the match cleared this over line), from the archive. */
const BTTS_GIVEN_LINE: Record<string, number> = {
  OVER_2_5: 0.801,
  OVER_3_5: 0.867,
  OVER_4_5: 0.902,
  OVER_5_5: 0.934,
  GOALS_6_PLUS: 0.934,
};

/**
 * Most to least demanding. Over lines nest — clearing 4.5 clears 3.5 and 2.5
 * — so the hardest one present carries the whole stack's chance exactly, and
 * the lower lines add price without subtracting probability.
 */
const LINES_BY_DEMAND = ['GOALS_6_PLUS', 'OVER_5_5', 'OVER_4_5', 'OVER_3_5', 'OVER_2_5'] as const;

/**
 * What makes a stack a surprise: its hardest leg. Over 4.5 or beyond is a
 * demanding event on its own; Over 3.5 qualifies only with BTTS on top. Two
 * over lines at 2.5 and 3.5 multiply to about 2.7, which is a Balanced coupon
 * wearing the label, and a day that offers nothing harder leaves the slate
 * empty rather than mislabelled.
 */
const DEMANDING = new Set(['GOALS_6_PLUS', 'OVER_5_5', 'OVER_4_5']);
/** Added when priced; the football provider is its only source, so often absent. */
const BTTS = 'BTTS_YES';

export interface SingleMatchOptions {
  /** Archive codes the slate may draw from. */
  leagues: readonly string[];
  count: number;
  /** The anchor line must clear this on the model's own view. */
  minAnchorProbability: number;
  asOf: Date;
}

export function buildSingleMatchStacks(
  candidates: Candidate[],
  options: SingleMatchOptions,
): BuiltCoupon[] {
  const byMatch = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.leagueCode || !options.leagues.includes(c.leagueCode)) continue;
    if (c.kickoffUtc.getTime() <= options.asOf.getTime()) continue;
    const list = byMatch.get(c.matchId) ?? [];
    list.push(c);
    byMatch.set(c.matchId, list);
  }

  const stacks: BuiltCoupon[] = [];

  const ranked = [...byMatch.entries()]
    .map(([matchId, legs]) => {
      const lines = LINES_BY_DEMAND.map((code) => legs.find((l) => l.selectionCode === code)).filter(
        (l): l is Candidate => l !== undefined,
      );
      const btts = legs.find((l) => l.selectionCode === BTTS);
      const hardest = lines[0];
      const demanding =
        hardest !== undefined &&
        (DEMANDING.has(hardest.selectionCode) || (hardest.selectionCode === 'OVER_3_5' && btts !== undefined));
      return { matchId, lines, btts, hardest, demanding };
    })
    // The lines nest, so the hardest one is the whole stack's chance; it has
    // to be a genuinely hard event, and the model has to give it a real chance.
    .filter((m) => m.demanding && Number(m.hardest!.probability) >= options.minAnchorProbability)
    .sort((a, b) => Number(b.hardest!.probability) - Number(a.hardest!.probability));

  for (const match of ranked.slice(0, options.count)) {
    // Easiest line first on the slip, hardest last, BTTS after.
    const chosen: Candidate[] = [...match.lines].reverse();
    if (match.btts) chosen.push(match.btts);
    if (chosen.length < 2) continue;

    const hardestLeg = match.hardest!;
    const hardest = hardestLeg.selectionCode;
    const chance = Number(hardestLeg.probability) * (match.btts ? (BTTS_GIVEN_LINE[hardest] ?? 1) : 1);

    const totalOdds = chosen.reduce((acc, l) => acc.times(l.odds), dec(1));

    stacks.push({
      category: 'HIGH_VALUE',
      targetDate: hardestLeg.targetDate,
      strategy: 'focus_single_match',
      selections: chosen,
      totalOdds,
      estimatedProbability: dec(chance),
      // Price times honest chance, minus the stake: what the stack is worth.
      expectedValue: totalOdds.times(chance).minus(1),
      confidence: hardestLeg.confidence,
      risk: hardestLeg.risk,
      // Deliberately fully correlated; that is the design, not a defect.
      correlation: 1,
      diversification: 0,
      score: chance,
    });
  }

  return stacks;
}
