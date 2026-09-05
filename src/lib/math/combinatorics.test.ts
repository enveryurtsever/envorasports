import { describe, expect, it } from 'vitest';
import {
  InvalidSystemError,
  assertColumnCountWithinLimit,
  combinationCount,
  combinations,
} from './combinatorics';

describe('combinationCount', () => {
  // The exact cases the specification calls out (§26).
  it('matches the specified system column counts', () => {
    expect(combinationCount(8, 2)).toBe(28n);
    expect(combinationCount(8, 3)).toBe(56n);
    expect(combinationCount(8, 4)).toBe(70n);
    expect(combinationCount(10, 3)).toBe(120n);
  });

  it('handles the degenerate edges', () => {
    expect(combinationCount(5, 0)).toBe(1n);
    expect(combinationCount(5, 5)).toBe(1n);
    expect(combinationCount(0, 0)).toBe(1n);
    expect(combinationCount(1, 1)).toBe(1n);
  });

  it('is symmetric', () => {
    expect(combinationCount(12, 5)).toBe(combinationCount(12, 7));
  });

  it('stays exact far beyond 2^53, where floats silently lose digits', () => {
    // 64!/(32!32!) — a float-based factorial implementation returns Infinity.
    expect(combinationCount(64, 32)).toBe(1832624140942590534n);
  });

  it('rejects impossible combinations', () => {
    expect(() => combinationCount(3, 5)).toThrow(InvalidSystemError);
    expect(() => combinationCount(-1, 0)).toThrow(InvalidSystemError);
    expect(() => combinationCount(5, -2)).toThrow(InvalidSystemError);
    expect(() => combinationCount(5.5, 2)).toThrow(InvalidSystemError);
  });
});

describe('assertColumnCountWithinLimit', () => {
  it('allows a realistic system', () => {
    expect(() => assertColumnCountWithinLimit(combinationCount(10, 3))).not.toThrow();
  });

  it('refuses a system that would explode', () => {
    expect(() => assertColumnCountWithinLimit(combinationCount(40, 20))).toThrow(InvalidSystemError);
  });
});

describe('combinations', () => {
  it('yields exactly C(n,k) distinct columns', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const result = [...combinations(items, 3)];

    expect(result).toHaveLength(56);
    expect(new Set(result.map((c) => c.join('|'))).size).toBe(56);
    expect(result.every((c) => c.length === 3)).toBe(true);
  });

  it('produces lexicographic order so column indexes are reproducible', () => {
    expect([...combinations([1, 2, 3, 4], 2)]).toEqual([
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 3],
      [2, 4],
      [3, 4],
    ]);
  });

  it('never repeats an item inside a column', () => {
    for (const column of combinations(['a', 'b', 'c', 'd', 'e'], 3)) {
      expect(new Set(column).size).toBe(column.length);
    }
  });

  it('treats k=0 as a single empty column', () => {
    expect([...combinations(['a', 'b'], 0)]).toEqual([[]]);
  });
});
