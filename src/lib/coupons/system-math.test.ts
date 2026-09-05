import { describe, expect, it } from 'vitest';
import {
  buildSystemPlan,
  formatSystemLabel,
  parseSystemSizes,
  probabilityOfAtLeast,
  settleSystem,
  SystemPlanError,
  winCountDistribution,
  type ColumnResult,
} from './system-math';

function baseSelections(count: number, odds = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    odds,
    matchId: `m${i}`,
  }));
}

describe('buildSystemPlan', () => {
  it('produces the specified column counts', () => {
    expect(buildSystemPlan({ selections: baseSelections(8), systemSizes: [2], stakePerColumn: 1 }).columnCount).toBe(28);
    expect(buildSystemPlan({ selections: baseSelections(8), systemSizes: [3], stakePerColumn: 1 }).columnCount).toBe(56);
    expect(buildSystemPlan({ selections: baseSelections(8), systemSizes: [4], stakePerColumn: 1 }).columnCount).toBe(70);
    expect(buildSystemPlan({ selections: baseSelections(10), systemSizes: [3], stakePerColumn: 1 }).columnCount).toBe(120);
  });

  it('computes total stake as columns x stake per column', () => {
    // The worked example from §18: 8 selections, System 3, 1 per column.
    const plan = buildSystemPlan({
      selections: baseSelections(8),
      systemSizes: [3],
      stakePerColumn: 1,
    });
    expect(plan.columnCount).toBe(56);
    expect(plan.totalStake.toFixed(2)).toBe('56.00');
  });

  it('keeps stake arithmetic exact where floats would drift', () => {
    // 0.1 * 3 === 0.30000000000000004 in IEEE-754 doubles.
    const plan = buildSystemPlan({
      selections: baseSelections(3),
      systemSizes: [2],
      stakePerColumn: '0.1',
    });
    expect(plan.columnCount).toBe(3);
    expect(plan.totalStake.toFixed(2)).toBe('0.30');
  });

  it('multiplies column odds rather than summing them', () => {
    const plan = buildSystemPlan({
      selections: [
        { id: 'a', odds: '1.5', matchId: 'm1' },
        { id: 'b', odds: '2.0', matchId: 'm2' },
        { id: 'c', odds: '3.0', matchId: 'm3' },
      ],
      systemSizes: [2],
      stakePerColumn: 10,
    });
    expect(plan.columns.map((c) => c.combinedOdds.toFixed(2))).toEqual(['3.00', '4.50', '6.00']);
  });

  it('rejects impossible and unaffordable configurations', () => {
    expect(() =>
      buildSystemPlan({ selections: baseSelections(3), systemSizes: [5], stakePerColumn: 1 }),
    ).toThrow();

    expect(() =>
      buildSystemPlan({
        selections: baseSelections(8),
        systemSizes: [3],
        stakePerColumn: 10,
        maxTotalStake: 100,
      }),
    ).toThrow(SystemPlanError);

    expect(() =>
      buildSystemPlan({
        selections: [
          { id: 'dup', odds: 2, matchId: 'm1' },
          { id: 'dup', odds: 2, matchId: 'm2' },
        ],
        systemSizes: [2],
        stakePerColumn: 1,
      }),
    ).toThrow(SystemPlanError);
  });
});

describe('settleSystem', () => {
  const plan = buildSystemPlan({
    selections: baseSelections(8),
    systemSizes: [3],
    stakePerColumn: 1,
  });

  function settleWith(results: (index: number) => ColumnResult) {
    return settleSystem(
      plan.columns.map((c) => ({
        columnIndex: c.columnIndex,
        combinedOdds: c.combinedOdds,
        stake: c.stake,
        result: results(c.columnIndex),
      })),
    );
  }

  it('sums only the winning columns, not the whole accumulator', () => {
    // §18's example: 4 of 56 columns win. Every base selection is 2.00, so a
    // 3-pick column pays 8.00 and returns 8.00 on a 1.00 stake.
    const settlement = settleWith((i) => (i < 4 ? 'WON' : 'LOST'));

    expect(settlement.winningColumns).toBe(4);
    expect(settlement.losingColumns).toBe(52);
    expect(settlement.totalStake.toFixed(2)).toBe('56.00');
    expect(settlement.totalReturn.toFixed(2)).toBe('32.00');
    expect(settlement.netProfit.toFixed(2)).toBe('-24.00');
    expect(settlement.status).toBe('PARTIAL_WIN');
  });

  it('derives ROI from total stake', () => {
    const settlement = settleWith(() => 'WON');
    // Every column returns 8.00 on 1.00 staked: 448 back on 56 staked.
    expect(settlement.totalReturn.toFixed(2)).toBe('448.00');
    expect(settlement.netProfit.toFixed(2)).toBe('392.00');
    expect(settlement.roi.toFixed(4)).toBe('7.0000');
    expect(settlement.status).toBe('WON');
  });

  it('marks a total miss as LOST with the full stake lost', () => {
    const settlement = settleWith(() => 'LOST');
    expect(settlement.status).toBe('LOST');
    expect(settlement.totalReturn.toFixed(2)).toBe('0.00');
    expect(settlement.netProfit.toFixed(2)).toBe('-56.00');
    expect(settlement.roi.toFixed(4)).toBe('-1.0000');
  });

  it('returns the stake for void columns without booking profit', () => {
    const settlement = settleWith(() => 'VOID');
    expect(settlement.status).toBe('VOID');
    expect(settlement.totalReturn.toFixed(2)).toBe('56.00');
    expect(settlement.netProfit.toFixed(2)).toBe('0.00');
  });

  it('stays PENDING while any column is unresolved', () => {
    const settlement = settleWith((i) => (i === 0 ? 'PENDING' : 'WON'));
    expect(settlement.status).toBe('PENDING');
  });

  it('preserves decimal precision on awkward odds', () => {
    const settlement = settleSystem([
      { columnIndex: 0, combinedOdds: '1.01', stake: '0.05', result: 'WON' },
      { columnIndex: 1, combinedOdds: '3.33', stake: '0.05', result: 'WON' },
    ]);
    // 0.05 * 1.01 = 0.0505 -> 0.05 ; 0.05 * 3.33 = 0.1665 -> 0.17 (half-up)
    expect(settlement.totalReturn.toFixed(2)).toBe('0.22');
    expect(settlement.totalStake.toFixed(2)).toBe('0.10');
    expect(settlement.netProfit.toFixed(2)).toBe('0.12');
  });
});

describe('Turkish multi-size systems', () => {
  const base = baseSelections(8);

  it('sums the columns across every size, as a slip does', () => {
    // "Sistem 4,5,6" over 8 legs: C(8,4)=70, C(8,5)=56, C(8,6)=28.
    const plan = buildSystemPlan({
      selections: base,
      systemSizes: [4, 5, 6],
      stakePerColumn: 1,
      maxTotalStake: 1000,
    });

    expect(plan.columnsBySize).toEqual({ 4: 70, 5: 56, 6: 28 });
    expect(plan.columnCount).toBe(154);
    expect(plan.totalStake.toFixed(2)).toBe('154.00');
    expect(plan.systemLabel).toBe('4,5,6');
    expect(plan.systemType).toBe('SYSTEM_4_5_6');
  });

  it('actually emits a column of each size', () => {
    const plan = buildSystemPlan({
      selections: base,
      systemSizes: [4, 6],
      stakePerColumn: 1,
      maxTotalStake: 1000,
    });

    const sizes = new Set(plan.columns.map((c) => c.size));
    expect([...sizes].sort()).toEqual([4, 6]);
    expect(plan.columns.filter((c) => c.size === 4)).toHaveLength(70);
    expect(plan.columns.filter((c) => c.size === 6)).toHaveLength(28);
    expect(plan.columns.every((c) => c.selectionIds.length === c.size)).toBe(true);
  });

  it('computes the maximum return from the columns, not the accumulator', () => {
    // Two legs at 2.00, system 2: one column paying 4.00 on a 10 stake.
    const plan = buildSystemPlan({
      selections: baseSelections(2),
      systemSizes: [2],
      stakePerColumn: 10,
      maxTotalStake: 1000,
    });

    expect(plan.columnCount).toBe(1);
    expect(plan.maxReturn.toFixed(2)).toBe('40.00');

    // Three legs at 2.00, system 2: three columns of 4.00 on 10 each = 120.
    const wider = buildSystemPlan({
      selections: baseSelections(3),
      systemSizes: [2],
      stakePerColumn: 10,
      maxTotalStake: 1000,
    });
    expect(wider.columnCount).toBe(3);
    expect(wider.maxReturn.toFixed(2)).toBe('120.00');
    // The accumulator would be 8.00 x 30 = 240; a system is not that.
    expect(Number(wider.maxReturn)).toBeLessThan(240);
  });

  it('refuses a single-leg column', () => {
    expect(() =>
      buildSystemPlan({ selections: base, systemSizes: [1], stakePerColumn: 1 }),
    ).toThrow(SystemPlanError);
  });

  it('refuses an empty size list', () => {
    expect(() =>
      buildSystemPlan({ selections: base, systemSizes: [], stakePerColumn: 1 }),
    ).toThrow(SystemPlanError);
  });

  it('deduplicates and orders the sizes', () => {
    const plan = buildSystemPlan({
      selections: base,
      systemSizes: [6, 4, 4],
      stakePerColumn: 1,
      maxTotalStake: 1000,
    });
    expect(plan.systemSizes).toEqual([4, 6]);
  });

  it('round-trips the stored form', () => {
    expect(parseSystemSizes('SYSTEM_4_5_6')).toEqual([4, 5, 6]);
    expect(parseSystemSizes('SYSTEM_3')).toEqual([3]);
    expect(parseSystemSizes('nonsense')).toEqual([]);
    expect(formatSystemLabel([6, 4, 5])).toBe('4,5,6');
  });
});

describe('what a system is actually worth', () => {
  const legs = [0.6, 0.55, 0.5, 0.65, 0.7, 0.45];

  it('reports the chance of returning anything, not of every leg landing', () => {
    const all = legs.reduce((product, p) => product * p, 1);
    const atLeastThree = probabilityOfAtLeast(legs, 3);

    // All six landing is about 3.4%; at least three is better than even money.
    expect(all).toBeLessThan(0.05);
    expect(atLeastThree).toBeGreaterThan(0.5);
    expect(atLeastThree).toBeGreaterThan(all);
  });

  it('gives a win-count distribution that sums to one', () => {
    const distribution = winCountDistribution(legs);
    expect(distribution).toHaveLength(legs.length + 1);
    expect(distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('falls as the required number of wins rises', () => {
    expect(probabilityOfAtLeast(legs, 2)).toBeGreaterThan(probabilityOfAtLeast(legs, 4));
    expect(probabilityOfAtLeast(legs, 6)).toBeCloseTo(legs.reduce((a, b) => a * b, 1), 10);
    expect(probabilityOfAtLeast(legs, 0)).toBeCloseTo(1, 10);
  });

  it('computes expected return from the columns when probabilities are supplied', () => {
    const plan = buildSystemPlan({
      selections: [
        { id: 'a', odds: 2, matchId: 'm1', probability: 0.5 },
        { id: 'b', odds: 2, matchId: 'm2', probability: 0.5 },
        { id: 'c', odds: 2, matchId: 'm3', probability: 0.5 },
      ],
      systemSizes: [2],
      stakePerColumn: 10,
      maxTotalStake: 1000,
    });

    // Three columns, each 4.00 odds on a 10 stake with probability 0.25:
    // expected return 3 x 10 x 4 x 0.25 = 30 against a 30 stake, so EV is 0.
    expect(plan.columnCount).toBe(3);
    expect(plan.totalStake.toFixed(2)).toBe('30.00');
    expect(plan.expectedReturn?.toFixed(2)).toBe('30.00');
    expect(plan.returnProbability).toBeCloseTo(probabilityOfAtLeast([0.5, 0.5, 0.5], 2), 10);
  });

  it('reports nulls rather than guessing when probabilities are absent', () => {
    const plan = buildSystemPlan({
      selections: baseSelections(4),
      systemSizes: [2],
      stakePerColumn: 1,
      maxTotalStake: 1000,
    });
    expect(plan.expectedReturn).toBeNull();
    expect(plan.returnProbability).toBeNull();
  });
});
