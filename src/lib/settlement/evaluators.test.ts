import { describe, expect, it } from 'vitest';
import { MARKET } from '@/lib/markets/registry';
import { settleSelection, settleableMarkets } from './evaluators';
import type { MatchResultInput, SelectionContext, SettlementOutcome } from './types';

function result(overrides: Partial<MatchResultInput> = {}): MatchResultInput {
  return {
    status: 'FINISHED',
    homeScore: 2,
    awayScore: 1,
    halfTimeHomeScore: 0,
    halfTimeAwayScore: 1,
    totalCorners: 9,
    totalCards: 4,
    ...overrides,
  };
}

function sel(
  marketCode: string,
  selectionCode: string,
  parameters: Record<string, unknown> | null = null,
  handicap = 0,
): SelectionContext {
  return { marketCode, selectionCode, parameters, handicap };
}

const settle = (s: SelectionContext, r = result()): SettlementOutcome => settleSelection(s, r);

describe('lifecycle gate', () => {
  it('never books a loss for a postponed match', () => {
    const outcome = settle(sel(MARKET.MATCH_RESULT, 'MS_1', { outcome: 'HOME' }), result({ status: 'POSTPONED', homeScore: null, awayScore: null }));
    expect(outcome).toBe('PENDING');
  });

  it('voids abandoned and canceled matches', () => {
    for (const status of ['CANCELED', 'ABANDONED'] as const) {
      expect(settle(sel(MARKET.MATCH_RESULT, 'MS_1', { outcome: 'HOME' }), result({ status }))).toBe('VOID');
    }
  });

  it('keeps a live match pending even when a score exists', () => {
    expect(settle(sel(MARKET.MATCH_RESULT, 'MS_1', { outcome: 'HOME' }), result({ status: 'LIVE' }))).toBe('PENDING');
  });
});

describe('in-play settlement of decided markets', () => {
  const live = result({ status: 'LIVE', homeScore: 4, awayScore: 2, halfTimeHomeScore: 4, halfTimeAwayScore: 1 });

  it('settles goal lines the running score has already crossed', () => {
    expect(settle(sel(MARKET.OVER_UNDER, 'OVER_3_5', { line: 3.5, side: 'OVER' }), live)).toBe('WON');
    expect(settle(sel(MARKET.OVER_UNDER, 'UNDER_3_5', { line: 3.5, side: 'UNDER' }), live)).toBe('LOST');
    expect(settle(sel(MARKET.OVER_UNDER, 'UNDER_4_5', { line: 4.5, side: 'UNDER' }), live)).toBe('LOST');
    expect(settle(sel(MARKET.TOTAL_GOALS_THRESHOLD, 'GOALS_6_PLUS', { goals: 6 }), live)).toBe('WON');
  });

  it('leaves lines the score has not crossed open, including a whole line sitting on the total', () => {
    expect(settle(sel(MARKET.OVER_UNDER, 'OVER_6_5', { line: 6.5, side: 'OVER' }), live)).toBe('PENDING');
    expect(settle(sel(MARKET.OVER_UNDER, 'UNDER_6_5', { line: 6.5, side: 'UNDER' }), live)).toBe('PENDING');
    expect(settle(sel(MARKET.OVER_UNDER, 'UNDER_6', { line: 6, side: 'UNDER' }), live)).toBe('PENDING');
  });

  it('settles both teams to score once both have', () => {
    expect(settle(sel(MARKET.BTTS, 'BTTS_YES', { value: true }), live)).toBe('WON');
    expect(settle(sel(MARKET.BTTS, 'BTTS_NO', { value: false }), live)).toBe('LOST');
    expect(settle(sel(MARKET.BTTS, 'BTTS_NO', { value: false }), result({ status: 'LIVE', homeScore: 3, awayScore: 0 }))).toBe('PENDING');
  });

  it('settles half-time markets once the half-time score exists, and not before', () => {
    expect(settle(sel(MARKET.HALF_TIME_OVER_UNDER, 'HT_OVER_1_5', { line: 1.5, side: 'OVER' }), live)).toBe('WON');
    const firstHalf = result({ status: 'LIVE', homeScore: 1, awayScore: 0, halfTimeHomeScore: null, halfTimeAwayScore: null });
    expect(settle(sel(MARKET.HALF_TIME_RESULT, 'HT_1', { outcome: 'HOME' }), firstHalf)).toBe('PENDING');
  });

  it('never settles a match-result market in play', () => {
    expect(settle(sel(MARKET.MATCH_RESULT, 'MS_1', { outcome: 'HOME' }), live)).toBe('PENDING');
    expect(settle(sel(MARKET.HALF_TIME_FULL_TIME, 'HT_FT_1_1', { half: '1', full: '1' }), live)).toBe('PENDING');
    expect(settle(sel(MARKET.CORRECT_SCORE, 'CS_4_2', { home: 4, away: 2 }), live)).toBe('PENDING');
  });

  it('does not touch a scheduled match', () => {
    expect(settle(sel(MARKET.OVER_UNDER, 'OVER_0_5', { line: 0.5, side: 'OVER' }), result({ status: 'SCHEDULED', homeScore: 0, awayScore: 0 }))).toBe('PENDING');
  });
});

describe('match result and double chance', () => {
  it('settles 1X2 from the full-time score', () => {
    expect(settle(sel(MARKET.MATCH_RESULT, 'MS_1', { outcome: 'HOME' }))).toBe('WON');
    expect(settle(sel(MARKET.MATCH_RESULT, 'MS_X', { outcome: 'DRAW' }))).toBe('LOST');
    expect(settle(sel(MARKET.MATCH_RESULT, 'MS_2', { outcome: 'AWAY' }))).toBe('LOST');
  });

  it('settles double chance against the set of outcomes', () => {
    expect(settle(sel(MARKET.DOUBLE_CHANCE, 'DOUBLE_CHANCE_1X', { outcomes: ['HOME', 'DRAW'] }))).toBe('WON');
    expect(settle(sel(MARKET.DOUBLE_CHANCE, 'DOUBLE_CHANCE_X2', { outcomes: ['DRAW', 'AWAY'] }))).toBe('LOST');
  });
});

describe('goals markets', () => {
  it('settles over/under and pushes on a whole-number line', () => {
    expect(settle(sel(MARKET.OVER_UNDER, 'OVER_2_5', { line: 2.5, side: 'OVER', subject: 'total' }))).toBe('WON');
    expect(settle(sel(MARKET.OVER_UNDER, 'UNDER_2_5', { line: 2.5, side: 'UNDER', subject: 'total' }))).toBe('LOST');
    expect(settle(sel(MARKET.OVER_UNDER, 'OVER_3', { line: 3, side: 'OVER', subject: 'total' }))).toBe('PUSHED');
  });

  it('settles BTTS on both teams scoring', () => {
    expect(settle(sel(MARKET.BTTS, 'BTTS_YES', { value: true }))).toBe('WON');
    expect(settle(sel(MARKET.BTTS, 'BTTS_YES', { value: true }), result({ awayScore: 0 }))).toBe('LOST');
    expect(settle(sel(MARKET.BTTS, 'BTTS_NO', { value: false }), result({ awayScore: 0 }))).toBe('WON');
  });

  it('settles goal ranges including the open-ended band', () => {
    expect(settle(sel(MARKET.GOAL_RANGE, 'GOAL_RANGE_2_3', { min: 2, max: 3 }))).toBe('WON');
    expect(settle(sel(MARKET.GOAL_RANGE, 'GOAL_RANGE_7_PLUS', { min: 7, max: null }))).toBe('LOST');
    expect(
      settle(sel(MARKET.GOAL_RANGE, 'GOAL_RANGE_7_PLUS', { min: 7, max: null }), result({ homeScore: 5, awayScore: 3 })),
    ).toBe('WON');
  });

  it('settles 6+ goals specials', () => {
    const six = sel(MARKET.TOTAL_GOALS_THRESHOLD, 'GOALS_6_PLUS', { goals: 6 });
    expect(settle(six)).toBe('LOST');
    expect(settle(six, result({ homeScore: 4, awayScore: 2 }))).toBe('WON');
  });
});

describe('halves', () => {
  it('settles half-time result on the half-time score, not the final one', () => {
    // Half time 0-1 (away ahead), full time 2-1 (home wins).
    expect(settle(sel(MARKET.HALF_TIME_RESULT, 'HT_2', { outcome: 'AWAY' }))).toBe('WON');
    expect(settle(sel(MARKET.HALF_TIME_RESULT, 'HT_1', { outcome: 'HOME' }))).toBe('LOST');
  });

  it('settles HT/FT on both results', () => {
    expect(settle(sel(MARKET.HALF_TIME_FULL_TIME, 'HTFT_2_1', { half: '2', full: '1' }))).toBe('WON');
    expect(settle(sel(MARKET.HALF_TIME_FULL_TIME, 'HTFT_1_1', { half: '1', full: '1' }))).toBe('LOST');
  });

  it('stays pending when the half-time score was never supplied', () => {
    expect(
      settle(sel(MARKET.HALF_TIME_RESULT, 'HT_1', { outcome: 'HOME' }), result({ halfTimeHomeScore: null, halfTimeAwayScore: null })),
    ).toBe('PENDING');
  });
});

describe('correct score and team totals', () => {
  it('compares the exact score', () => {
    expect(settle(sel(MARKET.CORRECT_SCORE, 'CS_2_1', { home: 2, away: 1 }))).toBe('WON');
    expect(settle(sel(MARKET.CORRECT_SCORE, 'CS_1_1', { home: 1, away: 1 }))).toBe('LOST');
  });

  it('settles a single team’s goals', () => {
    expect(settle(sel(MARKET.TEAM_TOTAL, 'TEAM_HOME_OVER_1_5', { side: 'HOME', direction: 'OVER', line: 1.5 }))).toBe('WON');
    expect(settle(sel(MARKET.TEAM_TOTAL, 'TEAM_AWAY_OVER_1_5', { side: 'AWAY', direction: 'OVER', line: 1.5 }))).toBe('LOST');
    expect(settle(sel(MARKET.TEAM_TOTAL, 'TEAM_AWAY_UNDER_2', { side: 'AWAY', direction: 'UNDER', line: 1 }))).toBe('PUSHED');
  });
});

describe('asian handicap', () => {
  // Home wins 2-1, so the raw margin is +1.
  it('settles whole and half lines', () => {
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M0_5', { side: 'HOME', handicap: -0.5 }))).toBe('WON');
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M1', { side: 'HOME', handicap: -1 }))).toBe('PUSHED');
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M1_5', { side: 'HOME', handicap: -1.5 }))).toBe('LOST');
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_AWAY_P1_5', { side: 'AWAY', handicap: 1.5 }))).toBe('WON');
  });

  it('splits quarter lines into half-win and half-loss', () => {
    // -0.75 = half of -0.5 (won) + half of -1.0 (push) -> half win.
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M0_75', { side: 'HOME', handicap: -0.75 }))).toBe('HALF_WON');
    // -1.25 = half of -1.0 (push) + half of -1.5 (lost) -> half loss.
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M1_25', { side: 'HOME', handicap: -1.25 }))).toBe('HALF_LOST');
  });

  it('falls back to the handicap column when parameters omit it', () => {
    expect(settle(sel(MARKET.ASIAN_HANDICAP, 'AH_HOME_M0_5', { side: 'HOME' }, -0.5))).toBe('WON');
  });
});

describe('corners and cards', () => {
  it('uses the official corner statistic, not goals', () => {
    expect(settle(sel(MARKET.CORNERS, 'OVER_8_5', { line: 8.5, side: 'OVER' }))).toBe('WON');
    expect(settle(sel(MARKET.CORNERS, 'OVER_10_5', { line: 10.5, side: 'OVER' }))).toBe('LOST');
  });

  it('stays pending until the statistic has been ingested', () => {
    expect(
      settle(sel(MARKET.CARDS, 'OVER_3_5', { line: 3.5, side: 'OVER' }), result({ totalCards: null })),
    ).toBe('PENDING');
  });
});

describe('registry coverage', () => {
  it('has an evaluator for every seeded market', () => {
    expect(new Set(settleableMarkets())).toEqual(new Set(Object.values(MARKET)));
  });

  it('leaves an unknown market pending rather than guessing', () => {
    expect(settle(sel('SOME_FUTURE_MARKET', 'X', {}))).toBe('PENDING');
  });
});

describe('HAYAL markets', () => {
  const finished = (
    homeScore: number,
    awayScore: number,
    halfTimeHomeScore: number,
    halfTimeAwayScore: number,
  ): MatchResultInput => ({
    status: 'FINISHED',
    homeScore,
    awayScore,
    halfTimeHomeScore,
    halfTimeAwayScore,
    totalCorners: null,
    totalCards: null,
  });

  const settle = (marketCode: string, selectionCode: string, parameters: Record<string, unknown>, result: MatchResultInput) =>
    settleSelection({ marketCode, selectionCode, parameters, handicap: 0 }, result);

  it('settles both-halves BTTS only when all four sides scored', () => {
    // 2-2 at the break, 3-3 at the end: both teams scored in both halves.
    expect(
      settle('BTTS_BOTH_HALVES', 'BTTS_BOTH_HALVES_YES', { value: true }, finished(3, 3, 2, 2)),
    ).toBe('WON');
    // Four goals in the first half, none in the second — not both halves.
    expect(
      settle('BTTS_BOTH_HALVES', 'BTTS_BOTH_HALVES_YES', { value: true }, finished(2, 2, 2, 2)),
    ).toBe('LOST');
    // The away side never scored after the break.
    expect(
      settle('BTTS_BOTH_HALVES', 'BTTS_BOTH_HALVES_YES', { value: true }, finished(3, 2, 1, 2)),
    ).toBe('LOST');
    expect(
      settle('BTTS_BOTH_HALVES', 'BTTS_BOTH_HALVES_NO', { value: false }, finished(2, 2, 2, 2)),
    ).toBe('WON');
  });

  it('never guesses a second half from a missing half-time score', () => {
    const noHalfTime: MatchResultInput = {
      status: 'FINISHED',
      homeScore: 3,
      awayScore: 3,
      halfTimeHomeScore: null,
      halfTimeAwayScore: null,
      totalCorners: null,
      totalCards: null,
    };
    expect(
      settle('BTTS_BOTH_HALVES', 'BTTS_BOTH_HALVES_YES', { value: true }, noHalfTime),
    ).toBe('PENDING');
    expect(settle('HALF_TIME_CORRECT_SCORE', 'HT_CS_2_2', { home: 2, away: 2 }, noHalfTime)).toBe('PENDING');
    expect(settle('HALF_TIME_OVER_UNDER', 'HT_OVER_1_5', { line: 1.5, side: 'OVER' }, noHalfTime)).toBe('PENDING');
  });

  it('settles the half-time score and the half-time goal lines', () => {
    expect(settle('HALF_TIME_CORRECT_SCORE', 'HT_CS_2_2', { home: 2, away: 2 }, finished(4, 3, 2, 2))).toBe('WON');
    expect(settle('HALF_TIME_CORRECT_SCORE', 'HT_CS_2_2', { home: 2, away: 2 }, finished(4, 3, 2, 1))).toBe('LOST');

    expect(settle('HALF_TIME_OVER_UNDER', 'HT_OVER_1_5', { line: 1.5, side: 'OVER' }, finished(3, 1, 2, 0))).toBe('WON');
    expect(settle('HALF_TIME_OVER_UNDER', 'HT_OVER_2_5', { line: 2.5, side: 'OVER' }, finished(3, 1, 2, 0))).toBe('LOST');
    expect(settle('HALF_TIME_OVER_UNDER', 'HT_UNDER_1_5', { line: 1.5, side: 'UNDER' }, finished(3, 1, 1, 0))).toBe('WON');
    // Second-half goals must not leak into a first-half line.
    expect(settle('HALF_TIME_OVER_UNDER', 'HT_OVER_2_5', { line: 2.5, side: 'OVER' }, finished(6, 0, 1, 0))).toBe('LOST');
  });
});
