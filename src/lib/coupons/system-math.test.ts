import { describe, expect, it } from 'vitest';
import { buildSystemPlan, settleSystem, SystemPlanError, type ColumnResult } from './system-math';

function baseSelections(count: number, odds = 2) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    odds,
    matchId: `m${i}`,
  }));
}

describe('buildSystemPlan', () => {
  it('produces the specified column counts', () => {
    expect(buildSystemPlan({ selections: baseSelections(8), systemSelectionCount: 2, stakePerColumn: 1 }).columnCount).toBe(28);
    expect(buildSystemPlan({ selections: baseSelections(8), systemSelectionCount: 3, stakePerColumn: 1 }).columnCount).toBe(56);
    expect(buildSystemPlan({ selections: baseSelections(8), systemSelectionCount: 4, stakePerColumn: 1 }).columnCount).toBe(70);
    expect(buildSystemPlan({ selections: baseSelections(10), systemSelectionCount: 3, stakePerColumn: 1 }).columnCount).toBe(120);
  });

  it('computes total stake as columns x stake per column', () => {
    // The worked example from §18: 8 selections, System 3, 1 per column.
    const plan = buildSystemPlan({
      selections: baseSelections(8),
      systemSelectionCount: 3,
      stakePerColumn: 1,
    });
    expect(plan.columnCount).toBe(56);
    expect(plan.totalStake.toFixed(2)).toBe('56.00');
  });

  it('keeps stake arithmetic exact where floats would drift', () => {
    // 0.1 * 3 === 0.30000000000000004 in IEEE-754 doubles.
    const plan = buildSystemPlan({
      selections: baseSelections(3),
      systemSelectionCount: 2,
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
      systemSelectionCount: 2,
      stakePerColumn: 10,
    });
    expect(plan.columns.map((c) => c.combinedOdds.toFixed(2))).toEqual(['3.00', '4.50', '6.00']);
  });

  it('rejects impossible and unaffordable configurations', () => {
    expect(() =>
      buildSystemPlan({ selections: baseSelections(3), systemSelectionCount: 5, stakePerColumn: 1 }),
    ).toThrow();

    expect(() =>
      buildSystemPlan({
        selections: baseSelections(8),
        systemSelectionCount: 3,
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
        systemSelectionCount: 1,
        stakePerColumn: 1,
      }),
    ).toThrow(SystemPlanError);
  });
});

describe('settleSystem', () => {
  const plan = buildSystemPlan({
    selections: baseSelections(8),
    systemSelectionCount: 3,
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
