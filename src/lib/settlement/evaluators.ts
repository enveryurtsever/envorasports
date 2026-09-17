import { MARKET } from '@/lib/markets/registry';
import {
  fullTimeOutcome,
  halfTimeOutcome,
  lifecycleOutcome,
  readNumber,
  readString,
  totalGoals,
  type MarketSettlementEvaluator,
  type MatchResultInput,
  type SelectionContext,
  type SettlementOutcome,
} from './types';

const won = (value: boolean): SettlementOutcome => (value ? 'WON' : 'LOST');

/** A market whose inputs have not arrived yet stays PENDING, never LOST. */
const pendingIfMissing = <T>(value: T | null, resolve: (v: T) => SettlementOutcome): SettlementOutcome =>
  value === null ? 'PENDING' : resolve(value);

const matchResult: MarketSettlementEvaluator = {
  marketCode: MARKET.MATCH_RESULT,
  evaluate(selection, result) {
    const expected = readString(selection.parameters, 'outcome');
    return pendingIfMissing(fullTimeOutcome(result), (actual) => won(actual === expected));
  },
};

const doubleChance: MarketSettlementEvaluator = {
  marketCode: MARKET.DOUBLE_CHANCE,
  evaluate(selection, result) {
    const raw = selection.parameters?.outcomes;
    const expected = Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
    return pendingIfMissing(fullTimeOutcome(result), (actual) => won(expected.includes(actual)));
  },
};

const overUnder: MarketSettlementEvaluator = {
  marketCode: MARKET.OVER_UNDER,
  evaluate(selection, result) {
    const line = readNumber(selection.parameters, 'line');
    const side = readString(selection.parameters, 'side');
    if (line === null || (side !== 'OVER' && side !== 'UNDER')) return 'PENDING';

    const subject = readString(selection.parameters, 'subject') ?? 'total';
    const actual =
      subject === 'corners'
        ? result.totalCorners
        : subject === 'cards'
          ? result.totalCards
          : totalGoals(result);

    return pendingIfMissing(actual, (value) => {
      // Whole-number lines can land exactly on the line: that is a push.
      if (value === line) return 'PUSHED';
      return won(side === 'OVER' ? value > line : value < line);
    });
  },
};

/**
 * Goals scored in each half, from the two scores we already store.
 *
 * The second half is the difference between full time and half time, so no
 * extra data is needed — but every one of the four numbers must be present, or
 * the difference is a guess. A missing half-time score is PENDING, never LOST.
 */
function halfGoals(result: MatchResultInput): {
  firstHalf: { home: number; away: number };
  secondHalf: { home: number; away: number };
} | null {
  const { homeScore, awayScore, halfTimeHomeScore, halfTimeAwayScore } = result;
  if (
    homeScore === null ||
    awayScore === null ||
    halfTimeHomeScore === null ||
    halfTimeAwayScore === null
  ) {
    return null;
  }

  return {
    firstHalf: { home: halfTimeHomeScore, away: halfTimeAwayScore },
    secondHalf: { home: homeScore - halfTimeHomeScore, away: awayScore - halfTimeAwayScore },
  };
}

/** Both sides score before the break and again after it — the HAYAL signal. */
const bttsBothHalves: MarketSettlementEvaluator = {
  marketCode: MARKET.BTTS_BOTH_HALVES,
  evaluate(selection, result) {
    const halves = halfGoals(result);
    if (halves === null) return 'PENDING';

    const both =
      halves.firstHalf.home > 0 &&
      halves.firstHalf.away > 0 &&
      halves.secondHalf.home > 0 &&
      halves.secondHalf.away > 0;

    const expected = selection.parameters?.value === true;
    return won(both === expected);
  },
};

const halfTimeCorrectScore: MarketSettlementEvaluator = {
  marketCode: MARKET.HALF_TIME_CORRECT_SCORE,
  evaluate(selection, result) {
    const home = readNumber(selection.parameters, 'home');
    const away = readNumber(selection.parameters, 'away');
    if (home === null || away === null) return 'PENDING';
    if (result.halfTimeHomeScore === null || result.halfTimeAwayScore === null) return 'PENDING';

    return won(result.halfTimeHomeScore === home && result.halfTimeAwayScore === away);
  },
};

const halfTimeOverUnder: MarketSettlementEvaluator = {
  marketCode: MARKET.HALF_TIME_OVER_UNDER,
  evaluate(selection, result) {
    const line = readNumber(selection.parameters, 'line');
    const side = readString(selection.parameters, 'side');
    if (line === null || (side !== 'OVER' && side !== 'UNDER')) return 'PENDING';
    if (result.halfTimeHomeScore === null || result.halfTimeAwayScore === null) return 'PENDING';

    const total = result.halfTimeHomeScore + result.halfTimeAwayScore;
    // Half lines cannot land on the line, but a whole one can: that is a push.
    if (total === line) return 'PUSHED';
    return won(side === 'OVER' ? total > line : total < line);
  },
};

/** Both sides score before the break. Priced separately from the combined bet. */
const bttsFirstHalf: MarketSettlementEvaluator = {
  marketCode: MARKET.BTTS_FIRST_HALF,
  evaluate(selection, result) {
    if (result.halfTimeHomeScore === null || result.halfTimeAwayScore === null) return 'PENDING';
    const both = result.halfTimeHomeScore > 0 && result.halfTimeAwayScore > 0;
    return won(both === (selection.parameters?.value === true));
  },
};

const bttsSecondHalf: MarketSettlementEvaluator = {
  marketCode: MARKET.BTTS_SECOND_HALF,
  evaluate(selection, result) {
    const halves = halfGoals(result);
    if (halves === null) return 'PENDING';
    const both = halves.secondHalf.home > 0 && halves.secondHalf.away > 0;
    return won(both === (selection.parameters?.value === true));
  },
};

const btts: MarketSettlementEvaluator = {
  marketCode: MARKET.BTTS,
  evaluate(selection, result) {
    if (result.homeScore === null || result.awayScore === null) return 'PENDING';
    const bothScored = result.homeScore > 0 && result.awayScore > 0;
    const expected = selection.parameters?.value === true;
    return won(bothScored === expected);
  },
};

const halfTimeResult: MarketSettlementEvaluator = {
  marketCode: MARKET.HALF_TIME_RESULT,
  evaluate(selection, result) {
    const expected = readString(selection.parameters, 'outcome');
    // Deliberately the half-time score, never the full-time score (§32).
    return pendingIfMissing(halfTimeOutcome(result), (actual) => won(actual === expected));
  },
};

const OUTCOME_TO_CODE: Record<string, '1' | 'X' | '2'> = { HOME: '1', DRAW: 'X', AWAY: '2' };

const halfTimeFullTime: MarketSettlementEvaluator = {
  marketCode: MARKET.HALF_TIME_FULL_TIME,
  evaluate(selection, result) {
    const half = halfTimeOutcome(result);
    const full = fullTimeOutcome(result);
    if (half === null || full === null) return 'PENDING';

    const expectedHalf = readString(selection.parameters, 'half');
    const expectedFull = readString(selection.parameters, 'full');
    return won(OUTCOME_TO_CODE[half] === expectedHalf && OUTCOME_TO_CODE[full] === expectedFull);
  },
};

const goalRange: MarketSettlementEvaluator = {
  marketCode: MARKET.GOAL_RANGE,
  evaluate(selection, result) {
    const min = readNumber(selection.parameters, 'min');
    if (min === null) return 'PENDING';
    const max = readNumber(selection.parameters, 'max'); // null = open-ended
    return pendingIfMissing(totalGoals(result), (goals) =>
      won(goals >= min && (max === null || goals <= max)),
    );
  },
};

const totalGoalsThreshold: MarketSettlementEvaluator = {
  marketCode: MARKET.TOTAL_GOALS_THRESHOLD,
  evaluate(selection, result) {
    const threshold = readNumber(selection.parameters, 'goals');
    if (threshold === null) return 'PENDING';
    return pendingIfMissing(totalGoals(result), (goals) => won(goals >= threshold));
  },
};

const correctScore: MarketSettlementEvaluator = {
  marketCode: MARKET.CORRECT_SCORE,
  evaluate(selection, result) {
    const home = readNumber(selection.parameters, 'home');
    const away = readNumber(selection.parameters, 'away');
    if (home === null || away === null) return 'PENDING';
    if (result.homeScore === null || result.awayScore === null) return 'PENDING';
    return won(result.homeScore === home && result.awayScore === away);
  },
};

/**
 * Asian handicap, including quarter lines.
 *
 * A -0.75 bet is half on -0.5 and half on -1.0, so a one-goal win is a
 * half-win, not a win. Collapsing these to WON/LOST misprices real money.
 */
const asianHandicap: MarketSettlementEvaluator = {
  marketCode: MARKET.ASIAN_HANDICAP,
  evaluate(selection, result) {
    const side = readString(selection.parameters, 'side');
    const line = readNumber(selection.parameters, 'handicap') ?? selection.handicap;
    if ((side !== 'HOME' && side !== 'AWAY') || !Number.isFinite(line)) return 'PENDING';
    if (result.homeScore === null || result.awayScore === null) return 'PENDING';

    const rawMargin = result.homeScore - result.awayScore;
    const margin = side === 'HOME' ? rawMargin : -rawMargin;

    // Quarter line: split the stake across the two neighbouring half-lines.
    const isQuarter = Math.abs(line * 4) % 2 === 1;
    if (isQuarter) {
      const lower = line - 0.25;
      const upper = line + 0.25;
      const a = settleWholeOrHalfLine(margin, lower);
      const b = settleWholeOrHalfLine(margin, upper);

      if (a === 'WON' && b === 'WON') return 'WON';
      if (a === 'LOST' && b === 'LOST') return 'LOST';
      if (a === 'WON' && b === 'PUSHED') return 'HALF_WON';
      if (a === 'PUSHED' && b === 'WON') return 'HALF_WON';
      if (a === 'LOST' && b === 'PUSHED') return 'HALF_LOST';
      if (a === 'PUSHED' && b === 'LOST') return 'HALF_LOST';
      return 'PUSHED';
    }

    return settleWholeOrHalfLine(margin, line);
  },
};

function settleWholeOrHalfLine(margin: number, line: number): SettlementOutcome {
  const adjusted = margin + line;
  if (adjusted > 0) return 'WON';
  if (adjusted < 0) return 'LOST';
  return 'PUSHED';
}

const teamTotal: MarketSettlementEvaluator = {
  marketCode: MARKET.TEAM_TOTAL,
  evaluate(selection, result) {
    const side = readString(selection.parameters, 'side');
    const direction = readString(selection.parameters, 'direction');
    const line = readNumber(selection.parameters, 'line');
    if ((side !== 'HOME' && side !== 'AWAY') || line === null) return 'PENDING';
    if (direction !== 'OVER' && direction !== 'UNDER') return 'PENDING';

    const goals = side === 'HOME' ? result.homeScore : result.awayScore;
    return pendingIfMissing(goals, (value) => {
      if (value === line) return 'PUSHED';
      return won(direction === 'OVER' ? value > line : value < line);
    });
  },
};

/** Corners and cards reuse the over/under logic but on their own statistic. */
const corners: MarketSettlementEvaluator = { marketCode: MARKET.CORNERS, evaluate: overUnder.evaluate };
const cards: MarketSettlementEvaluator = { marketCode: MARKET.CARDS, evaluate: overUnder.evaluate };

export const EVALUATORS: MarketSettlementEvaluator[] = [
  matchResult,
  doubleChance,
  overUnder,
  btts,
  halfTimeResult,
  halfTimeFullTime,
  goalRange,
  totalGoalsThreshold,
  correctScore,
  asianHandicap,
  teamTotal,
  corners,
  cards,
  bttsBothHalves,
  bttsFirstHalf,
  bttsSecondHalf,
  halfTimeCorrectScore,
  halfTimeOverUnder,
];

const REGISTRY = new Map(EVALUATORS.map((e) => [e.marketCode, e]));

export function getEvaluator(marketCode: string): MarketSettlementEvaluator | undefined {
  return REGISTRY.get(marketCode);
}

/**
 * Settles one selection. The lifecycle gate runs first, so an abandoned match
 * can never be graded against a partial score.
 */
export function settleSelection(
  selection: SelectionContext,
  result: MatchResultInput,
): SettlementOutcome {
  const lifecycle = lifecycleOutcome(result);
  if (lifecycle !== null) {
    return lifecycle === 'PENDING' && IN_PLAY.has(result.status)
      ? inPlayOutcome(selection, result)
      : lifecycle;
  }

  const evaluator = getEvaluator(selection.marketCode);
  if (!evaluator) {
    // An unknown market is never guessed at; it waits for an evaluator.
    return 'PENDING';
  }

  const corners = selection.marketCode === MARKET.CORNERS;
  const cardsMarket = selection.marketCode === MARKET.CARDS;
  const parameters = corners
    ? { ...(selection.parameters ?? {}), subject: 'corners' }
    : cardsMarket
      ? { ...(selection.parameters ?? {}), subject: 'cards' }
      : selection.parameters;

  return evaluator.evaluate({ ...selection, parameters }, result);
}

const IN_PLAY = new Set<MatchResultInput['status']>(['LIVE', 'HALF_TIME', 'SUSPENDED']);

/**
 * What a running score has already decided.
 *
 * Goals are never taken back, so some markets are settled before the whistle:
 * Under 3.5 with six goals on the board has lost, whatever the final score,
 * and Over 3.5 has won. Barcelona 4-2 Santander sat "LIVE" for six hours
 * after full time because the provider's clock stopped at 65', and three
 * unders that had been dead since the fourth goal held two coupons open. The
 * bookmaker's own rule is the same — a market unconditionally determined
 * stands even if the match is later abandoned — so nothing here can be
 * contradicted by the final result.
 *
 * Only monotone facts are used: total goals, each side's goals, and the
 * half-time score, which the provider reports only once the half is over.
 * Whole-number lines sitting exactly on the total are still open (a push or a
 * winner), and every match-result market waits for the end.
 */
export function inPlayOutcome(selection: SelectionContext, result: MatchResultInput): SettlementOutcome {
  const { homeScore, awayScore } = result;
  if (homeScore === null || awayScore === null) return 'PENDING';
  const goals = homeScore + awayScore;
  const p = selection.parameters;

  switch (selection.marketCode) {
    case MARKET.OVER_UNDER: {
      const line = readNumber(p, 'line');
      const side = readString(p, 'side');
      const subject = readString(p, 'subject') ?? 'total';
      if (line === null || subject !== 'total') return 'PENDING';
      if (goals > line) return won(side === 'OVER');
      return 'PENDING';
    }
    case MARKET.TOTAL_GOALS_THRESHOLD: {
      const threshold = readNumber(p, 'goals');
      return threshold !== null && goals >= threshold ? 'WON' : 'PENDING';
    }
    case MARKET.GOAL_RANGE: {
      const min = readNumber(p, 'min');
      const max = readNumber(p, 'max');
      if (max !== null && goals > max) return 'LOST';
      if (min !== null && max === null && goals >= min) return 'WON';
      return 'PENDING';
    }
    case MARKET.BTTS: {
      if (homeScore > 0 && awayScore > 0) return won(p?.value === true);
      return 'PENDING';
    }
    case MARKET.TEAM_TOTAL: {
      const side = readString(p, 'side');
      const direction = readString(p, 'direction');
      const line = readNumber(p, 'line');
      if ((side !== 'HOME' && side !== 'AWAY') || line === null) return 'PENDING';
      const scored = side === 'HOME' ? homeScore : awayScore;
      if (scored > line) return won(direction === 'OVER');
      return 'PENDING';
    }
    // The half-time score is final the moment it exists.
    case MARKET.HALF_TIME_RESULT:
    case MARKET.HALF_TIME_CORRECT_SCORE:
    case MARKET.HALF_TIME_OVER_UNDER:
    case MARKET.BTTS_FIRST_HALF: {
      if (result.halfTimeHomeScore === null || result.halfTimeAwayScore === null) return 'PENDING';
      return getEvaluator(selection.marketCode)?.evaluate(selection, result) ?? 'PENDING';
    }
    default:
      return 'PENDING';
  }
}

/** Market codes that currently have a settlement implementation. */
export function settleableMarkets(): string[] {
  return [...REGISTRY.keys()];
}
