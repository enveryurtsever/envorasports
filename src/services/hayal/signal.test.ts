import { describe, expect, it } from 'vitest';
import { judge, type HayalThresholds } from './signal';

/**
 * The rule as stated, pinned. If any of these change, the thing being measured
 * has changed, and the record before and after is no longer one series.
 */
const STATED: HayalThresholds = {
  bttsThreshold: 8,
  ht22Threshold: 38,
  allowProxySignal: false,
};

function verdict(
  input: Partial<Parameters<typeof judge>[0]> = {},
  thresholds: HayalThresholds = STATED,
) {
  return judge(
    {
      matchId: 'm1',
      bttsBothHalvesOdds: null,
      halfTime22Odds: null,
      bttsFirstHalfOdds: null,
      bttsSecondHalfOdds: null,
      oddsCapturedAt: null,
      ...input,
    },
    thresholds,
  );
}

describe('HAYAL rule', () => {
  it('makes a candidate of a short both-halves price', () => {
    const result = verdict({ bttsBothHalvesOdds: 7.5 });
    expect(result.qualifies).toBe(true);
    expect(result.signalSource).toBe('MARKET');
    expect(result.premium).toBe(false);
  });

  it('treats the threshold as strict', () => {
    expect(verdict({ bttsBothHalvesOdds: 8 }).qualifies).toBe(false);
    expect(verdict({ bttsBothHalvesOdds: 7.99 }).qualifies).toBe(true);
  });

  it('never reads a missing price as passing', () => {
    // The single easiest way to manufacture a signal that is not there.
    const result = verdict({ bttsBothHalvesOdds: null, halfTime22Odds: 20 });
    expect(result.qualifies).toBe(false);
    expect(result.signalSource).toBe('NONE');
    expect(result.premium).toBe(false);
  });

  it('marks premium only when both conditions hold', () => {
    expect(verdict({ bttsBothHalvesOdds: 7.5, halfTime22Odds: 34.9 }).premium).toBe(true);
    expect(verdict({ bttsBothHalvesOdds: 7.5, halfTime22Odds: 43.7 }).premium).toBe(false);
    // Rule 2 on its own is not a candidate: rule 1 is the entry condition.
    expect(verdict({ halfTime22Odds: 20 }).qualifies).toBe(false);
  });

  it('records the proxy but does not act on it by default', () => {
    // Frankfurt v Augsburg, as actually quoted: 3.02 and 2.34.
    const result = verdict({ bttsFirstHalfOdds: 3.02, bttsSecondHalfOdds: 2.34 });
    expect(result.proxyBothHalvesOdds).toBeCloseTo(7.0668, 4);
    expect(result.qualifies).toBe(false);
    expect(result.signalSource).toBe('NONE');
  });

  it('uses the proxy only when explicitly enabled, and says so', () => {
    const result = verdict(
      { bttsFirstHalfOdds: 3.02, bttsSecondHalfOdds: 2.34 },
      { ...STATED, allowProxySignal: true },
    );
    expect(result.qualifies).toBe(true);
    expect(result.signalSource).toBe('PROXY');
  });

  it('prefers the real market over the proxy when both exist', () => {
    // The proxy would qualify; the real price does not. The real one decides.
    const result = verdict(
      { bttsBothHalvesOdds: 9.5, bttsFirstHalfOdds: 3.02, bttsSecondHalfOdds: 2.34 },
      { ...STATED, allowProxySignal: true },
    );
    expect(result.qualifies).toBe(false);
    expect(result.signalSource).toBe('MARKET');
    expect(result.proxyBothHalvesOdds).toBeCloseTo(7.0668, 4);
  });
});
