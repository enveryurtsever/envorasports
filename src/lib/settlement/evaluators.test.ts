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
