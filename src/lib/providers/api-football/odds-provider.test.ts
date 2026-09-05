import { describe, expect, it } from 'vitest';
import { mapBetValue } from './odds-provider';

/**
 * The value strings here are copied verbatim from a live API-Football response
 * (Bet365, fixture 1576169). Mapping is the whole job of this adapter: a wrong
 * code silently prices the wrong bet, which no downstream check would catch.
 */

describe('mapBetValue', () => {
  it('maps the match result to MS codes', () => {
    expect(mapBetValue(1, 'Home')).toMatchObject({ marketCode: 'MATCH_RESULT', selectionCode: 'MS_1' });
    expect(mapBetValue(1, 'Draw')).toMatchObject({ selectionCode: 'MS_X' });
    expect(mapBetValue(1, 'Away')).toMatchObject({ selectionCode: 'MS_2' });
  });

  it('maps the first half result to HT codes', () => {
    expect(mapBetValue(13, 'Home')).toMatchObject({
      marketCode: 'HALF_TIME_RESULT',
      selectionCode: 'HT_1',
    });
    expect(mapBetValue(13, 'Draw')).toMatchObject({ selectionCode: 'HT_X' });
    expect(mapBetValue(13, 'Away')).toMatchObject({ selectionCode: 'HT_2' });
  });

  it('maps the goal lines we model', () => {
    expect(mapBetValue(5, 'Over 2.5')).toMatchObject({
      marketCode: 'OVER_UNDER',
      selectionCode: 'OVER_2_5',
    });
    expect(mapBetValue(5, 'Under 3.5')).toMatchObject({ selectionCode: 'UNDER_3_5' });
    expect(mapBetValue(5, 'Over 0.5')).toMatchObject({ selectionCode: 'OVER_0_5' });
  });

  it('reads "Over 5.5" as the 6+ goals threshold', () => {
    // Identical events: P(total > 5.5) is P(total >= 6). One event gets one
    // code, so a coupon can never carry it twice under different names.
    expect(mapBetValue(5, 'Over 5.5')).toMatchObject({
      marketCode: 'TOTAL_GOALS_THRESHOLD',
      selectionCode: 'GOALS_6_PLUS',
    });
    expect(mapBetValue(5, 'Over 6.5')).toMatchObject({ selectionCode: 'GOALS_7_PLUS' });
    // The under side has no threshold equivalent and must not be invented.
    expect(mapBetValue(5, 'Under 5.5')).toBeNull();
  });

  it('maps both teams to score', () => {
    expect(mapBetValue(8, 'Yes')).toMatchObject({ marketCode: 'BTTS', selectionCode: 'BTTS_YES' });
    expect(mapBetValue(8, 'No')).toMatchObject({ selectionCode: 'BTTS_NO' });
  });

  it('maps double chance in either order', () => {
    expect(mapBetValue(12, 'Home/Draw')).toMatchObject({ selectionCode: 'DOUBLE_CHANCE_1X' });
    expect(mapBetValue(12, 'Draw/Away')).toMatchObject({ selectionCode: 'DOUBLE_CHANCE_X2' });
    expect(mapBetValue(12, 'Home/Away')).toMatchObject({ selectionCode: 'DOUBLE_CHANCE_12' });
  });

  it('takes only the asian handicap lines the model prices', () => {
    expect(mapBetValue(4, 'Home -1')).toMatchObject({
      marketCode: 'ASIAN_HANDICAP',
      handicap: -1,
    });
    // Quarter lines are not modelled, so a price for one has nothing to be
    // compared against and is dropped rather than rounded to a neighbour.
    expect(mapBetValue(4, 'Home -1.25')).toBeNull();
    expect(mapBetValue(4, 'Away -0.75')).toBeNull();
  });

  it('accepts numeric values without throwing', () => {
    // "Exact Goals Number" reports 0, 1, 2 as JSON numbers. An unmodelled
    // market, but it must be skipped rather than crash the whole fixture.
    expect(mapBetValue(38, 0)).toBeNull();
    expect(mapBetValue(38, 'more 7')).toBeNull();
  });

  it('drops markets we do not model', () => {
    expect(mapBetValue(45, 'Over 10.5')).toBeNull();
    expect(mapBetValue(92, 'Robert Glatzel')).toBeNull();
  });
});
