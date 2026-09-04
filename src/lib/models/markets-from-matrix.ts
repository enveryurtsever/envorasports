import { Decimal, dec } from '@/lib/math/decimal';
import { marginalise, poissonPmf, scoreMatrix } from '@/lib/math/probability';
import {
  GOAL_LINES,
  GOALS_PLUS_THRESHOLDS,
  TEAM_GOAL_LINES,
  asianHandicapCode,
  correctScoreCode,
  goalRangeCode,
  goalsPlusCode,
  htftCode,
  overUnderCode,
  teamTotalCode,
  ASIAN_HANDICAP_LINES,
} from '@/lib/markets/registry';
import type { SelectionProbabilities } from './types';

/**
 * Derives every goals-based market from one joint score distribution.
 *
 * Deriving them all from a single matrix is what keeps them coherent: Over 2.5
 * can never come out below Over 3.5, and the 1X2 probabilities always sum to 1,
 * because they are marginals of the same object rather than separate guesses.
 */

const CORRECT_SCORE_MAX = 4;
/** Share of goals scored before half time, from the long-run football average. */
const FIRST_HALF_SHARE = 0.45;
const HALF_MAX_GOALS = 6;

export interface MatrixMarkets {
  probabilities: SelectionProbabilities;
  matrix: Decimal[][];
}

export function deriveMarkets(
  lambdaHome: number,
  lambdaAway: number,
  options: { maxGoals?: number; includeHalfTime?: boolean } = {},
): MatrixMarkets {
  const maxGoals = options.maxGoals ?? 10;
  const matrix = scoreMatrix(lambdaHome, lambdaAway, maxGoals);
  const p: SelectionProbabilities = new Map();

  // --- 1X2 ---------------------------------------------------------------
  const home = marginalise(matrix, (h, a) => h > a);
  const draw = marginalise(matrix, (h, a) => h === a);
  const away = marginalise(matrix, (h, a) => h < a);
  p.set('MS_1', home);
  p.set('MS_X', draw);
  p.set('MS_2', away);

  // Double chance is a union of the above, not an independent estimate.
  p.set('DOUBLE_CHANCE_1X', home.plus(draw));
  p.set('DOUBLE_CHANCE_X2', draw.plus(away));
  p.set('DOUBLE_CHANCE_12', home.plus(away));

  // --- totals ------------------------------------------------------------
  for (const line of GOAL_LINES) {
    p.set(overUnderCode('OVER', line), marginalise(matrix, (h, a) => h + a > line));
    p.set(overUnderCode('UNDER', line), marginalise(matrix, (h, a) => h + a < line));
  }

  for (const goals of GOALS_PLUS_THRESHOLDS) {
    p.set(goalsPlusCode(goals), marginalise(matrix, (h, a) => h + a >= goals));
  }

  for (const band of [
    { min: 0, max: 1 },
    { min: 2, max: 3 },
    { min: 4, max: 6 },
    { min: 7, max: null as number | null },
  ]) {
    p.set(
      goalRangeCode(band.min, band.max),
      marginalise(matrix, (h, a) => {
        const total = h + a;
        return total >= band.min && (band.max === null || total <= band.max);
      }),
    );
  }

  // --- both teams to score ----------------------------------------------
  const bttsYes = marginalise(matrix, (h, a) => h > 0 && a > 0);
  p.set('BTTS_YES', bttsYes);
  p.set('BTTS_NO', dec(1).minus(bttsYes));

  // --- correct score -----------------------------------------------------
  for (let h = 0; h <= CORRECT_SCORE_MAX; h++) {
    for (let a = 0; a <= CORRECT_SCORE_MAX; a++) {
      p.set(correctScoreCode(h, a), matrix[h]?.[a] ?? dec(0));
    }
  }

  // --- team totals -------------------------------------------------------
  for (const line of TEAM_GOAL_LINES) {
    p.set(teamTotalCode('HOME', 'OVER', line), marginalise(matrix, (h) => h > line));
    p.set(teamTotalCode('HOME', 'UNDER', line), marginalise(matrix, (h) => h < line));
    p.set(teamTotalCode('AWAY', 'OVER', line), marginalise(matrix, (_h, a) => a > line));
    p.set(teamTotalCode('AWAY', 'UNDER', line), marginalise(matrix, (_h, a) => a < line));
  }

  // --- asian handicap ----------------------------------------------------
  // Whole-line pushes are excluded from both sides rather than counted as wins.
  for (const handicap of ASIAN_HANDICAP_LINES) {
    p.set(
      asianHandicapCode('HOME', handicap),
      marginalise(matrix, (h, a) => h - a + handicap > 0),
    );
    p.set(
      asianHandicapCode('AWAY', -handicap),
      marginalise(matrix, (h, a) => a - h - handicap > 0),
    );
  }

  // --- halves ------------------------------------------------------------
  if (options.includeHalfTime !== false) {
    applyHalfTimeMarkets(p, lambdaHome, lambdaAway);
  }

  return { probabilities: p, matrix };
}

/**
 * Half-time and HT/FT from two independent half distributions.
 *
 * This is a real joint calculation over (first half, second half), not a
 * heuristic: HT/FT 1/2 comes out as the actual probability of leading at the
 * break and losing, which is exactly the sort of market §27 wants priced
 * honestly rather than guessed at.
 */
function applyHalfTimeMarkets(
  p: SelectionProbabilities,
  lambdaHome: number,
  lambdaAway: number,
): void {
  const firstHalf = halfMatrix(lambdaHome * FIRST_HALF_SHARE, lambdaAway * FIRST_HALF_SHARE);
  const secondHalf = halfMatrix(
    lambdaHome * (1 - FIRST_HALF_SHARE),
    lambdaAway * (1 - FIRST_HALF_SHARE),
  );

  const outcome = (h: number, a: number): '1' | 'X' | '2' => (h > a ? '1' : h === a ? 'X' : '2');

  let ht1 = dec(0);
  let htX = dec(0);
  let ht2 = dec(0);
  const htft = new Map<string, Decimal>();

  for (let h1 = 0; h1 <= HALF_MAX_GOALS; h1++) {
    for (let a1 = 0; a1 <= HALF_MAX_GOALS; a1++) {
      const pHalf = firstHalf[h1]?.[a1];
      if (!pHalf || pHalf.isZero()) continue;

      const half = outcome(h1, a1);
      if (half === '1') ht1 = ht1.plus(pHalf);
      else if (half === 'X') htX = htX.plus(pHalf);
      else ht2 = ht2.plus(pHalf);

      for (let h2 = 0; h2 <= HALF_MAX_GOALS; h2++) {
        for (let a2 = 0; a2 <= HALF_MAX_GOALS; a2++) {
          const pSecond = secondHalf[h2]?.[a2];
          if (!pSecond || pSecond.isZero()) continue;

          const full = outcome(h1 + h2, a1 + a2);
          const code = htftCode(half, full);
          htft.set(code, (htft.get(code) ?? dec(0)).plus(pHalf.times(pSecond)));
        }
      }
    }
  }

  p.set('HT_1', ht1);
  p.set('HT_X', htX);
  p.set('HT_2', ht2);
  for (const [code, probability] of htft) p.set(code, probability);
}

function halfMatrix(lambdaHome: number, lambdaAway: number): Decimal[][] {
  const homePmf = Array.from({ length: HALF_MAX_GOALS + 1 }, (_, i) => poissonPmf(i, lambdaHome));
  const awayPmf = Array.from({ length: HALF_MAX_GOALS + 1 }, (_, i) => poissonPmf(i, lambdaAway));

  return homePmf.map((ph) => awayPmf.map((pa) => ph.times(pa)));
}

/**
 * Spreads a 1X2 opinion across the goals markets by finding the Poisson pair
 * that best reproduces it.
 *
 * Used by models that only have a view on the result (Elo). Rather than leaving
 * the goals markets blank, it searches a small grid for the scoring rates most
 * consistent with the stated 1X2 — an honest translation, not a new opinion.
 */
export function lambdasFromOutcome(
  homeProbability: number,
  drawProbability: number,
  awayProbability: number,
  totalGoalsHint = 2.6,
): { lambdaHome: number; lambdaAway: number } {
  let best = { lambdaHome: totalGoalsHint / 2, lambdaAway: totalGoalsHint / 2 };
  let bestError = Number.POSITIVE_INFINITY;

  // Plain floats here on purpose. This is a search for a starting point, not a
  // priced number, and the Decimal version cost ~500ms per call — which the
  // prediction engine pays once per model per match.
  for (let step = 0; step <= 50; step++) {
    const share = 0.25 + step * 0.01;
    const lambdaHome = totalGoalsHint * share;
    const lambdaAway = totalGoalsHint * (1 - share);
    const { home, draw, away } = fastOutcomes(lambdaHome, lambdaAway);

    const error =
      (home - homeProbability) ** 2 +
      (draw - drawProbability) ** 2 +
      (away - awayProbability) ** 2;

    if (error < bestError) {
      bestError = error;
      best = { lambdaHome, lambdaAway };
    }
  }

  return best;
}

/** Float 1X2 marginals from two Poisson rates. Search-only; never persisted. */
function fastOutcomes(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 8,
): { home: number; draw: number; away: number } {
  const pmf = (lambda: number) => {
    const out = new Array<number>(maxGoals + 1);
    let term = Math.exp(-lambda);
    out[0] = term;
    for (let k = 1; k <= maxGoals; k++) {
      term = (term * lambda) / k;
      out[k] = term;
    }
    return out;
  };

  const homePmf = pmf(lambdaHome);
  const awayPmf = pmf(lambdaAway);

  let home = 0;
  let draw = 0;
  let away = 0;
  let total = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = (homePmf[h] as number) * (awayPmf[a] as number);
      total += p;
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }

  // Renormalise the truncated tail so the three shares still sum to 1.
  return total > 0 ? { home: home / total, draw: draw / total, away: away / total } : { home: 0, draw: 1, away: 0 };
}
