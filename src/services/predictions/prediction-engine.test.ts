import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { leagueTravelFactor, median, rejectOutlierQuotes } from './prediction-engine';

const quote = (price: string) => ({ price: new Prisma.Decimal(price) });

describe('median', () => {
  it('takes the middle of an odd list', () => {
    expect(median([1.3, 1.28, 1.32])).toBeCloseTo(1.3, 5);
  });

  it('averages the two middles of an even list', () => {
    expect(median([1.2, 1.3, 1.4, 1.5])).toBeCloseTo(1.35, 5);
  });

  it('is zero for nothing', () => {
    expect(median([])).toBe(0);
  });
});

describe('rejectOutlierQuotes', () => {
  it('drops the broken row that used to win', () => {
    // Over 1.5 across a dozen books, with one stored at 15.00. Taking the best
    // price meant that row was always chosen, and it produced the biggest edge
    // on the slate.
    const quotes = [
      quote('1.28'), quote('1.30'), quote('1.31'), quote('1.29'),
      quote('1.33'), quote('15.00'),
    ];
    const result = rejectOutlierQuotes(quotes);

    expect(result.rejected).toBe(1);
    expect(result.rows).toHaveLength(5);
    expect(Math.max(...result.rows.map((r) => Number(r.price)))).toBeCloseTo(1.33, 2);
  });

  it('still returns the best surviving price, not the median', () => {
    // A reader can only bet what someone is offering; the median is nobody's
    // price. Only the field it is chosen from changes.
    const quotes = [quote('2.00'), quote('2.10'), quote('2.20'), quote('2.05')];
    const result = rejectOutlierQuotes(quotes);
    expect(result.rejected).toBe(0);
    expect(Math.max(...result.rows.map((r) => Number(r.price)))).toBeCloseTo(2.2, 2);
  });

  it('keeps everything when there is no consensus to measure against', () => {
    // Two books is not a market. A thin field is a reason for less confidence,
    // not a licence to invent a consensus from two numbers.
    const quotes = [quote('1.30'), quote('15.00')];
    const result = rejectOutlierQuotes(quotes);
    expect(result.rejected).toBe(0);
    expect(result.rows).toHaveLength(2);
  });

  it('collapses a wild field onto the consensus quote', () => {
    // 1.10 / 4.00 / 40.00 has a median of 4.00, and both extremes sit outside
    // the ratio. What survives is the one price the field agrees on.
    const quotes = [quote('1.10'), quote('4.00'), quote('40.00')];
    const result = rejectOutlierQuotes(quotes);
    expect(result.rows).toHaveLength(1);
    expect(Number(result.rows[0]!.price)).toBeCloseTo(4, 2);
    expect(result.rejected).toBe(2);
  });

  it('never strips a selection down to nothing', () => {
    // A field split into two camps has a median between them that nothing is
    // near. The market itself is the anomaly there, and dispersion is what
    // should carry that — not an empty selection.
    const quotes = [quote('1.00'), quote('1.00'), quote('100.00'), quote('100.00')];
    const result = rejectOutlierQuotes(quotes);
    expect(result.rows).toHaveLength(4);
    expect(result.rejected).toBe(0);
  });

  it('drops a quote that is far too short as well as far too long', () => {
    const quotes = [quote('5.00'), quote('5.20'), quote('4.90'), quote('1.05')];
    const result = rejectOutlierQuotes(quotes);
    expect(result.rejected).toBe(1);
    expect(Math.min(...result.rows.map((r) => Number(r.price)))).toBeCloseTo(4.9, 2);
  });
});

describe('leagueTravelFactor', () => {
  it('changes nothing between equal leagues', () => {
    // A domestic tie must be untouched, or every existing number moves.
    expect(leagueTravelFactor(40, 40)).toBeCloseTo(1, 6);
    expect(leagueTravelFactor(0, 0)).toBeCloseTo(1, 6);
  });

  it('discounts a side moving up a hundred rating points', () => {
    // Club Brugge (40) against Aston Villa (140): scores about three quarters
    // of what it does at home, and concedes proportionally more.
    expect(leagueTravelFactor(40, 140)).toBeCloseTo(0.72, 2);
  });

  it('rewards a side moving down by the mirror amount', () => {
    const up = leagueTravelFactor(40, 140);
    const down = leagueTravelFactor(140, 40);
    // The two sides of one tie: what one loses the other gains.
    expect(up + down).toBeCloseTo(2, 6);
    expect(down).toBeGreaterThan(1);
  });

  it('is derived from the Elo scale, not a separate constant', () => {
    // 400 points is a factor-of-ten difference in Elo, which is where these
    // numbers come from — nothing new was invented to scale the goals.
    expect(leagueTravelFactor(0, 400)).toBeCloseTo(2 / 11, 3);
  });
});
