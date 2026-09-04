import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCsvDate, parseCsvLine, parseSeasonCsv, ukLocalToUtc } from './parser';

const sample = readFileSync(
  fileURLToPath(new URL('./__fixtures__/E0-sample.csv', import.meta.url)),
  'utf8',
);

describe('parseCsvLine', () => {
  it('splits plain rows', () => {
    expect(parseCsvLine('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('respects quoted fields containing commas', () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsvLine('a,"say ""hi""",c')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('keeps empty trailing fields, which the archive is full of', () => {
    expect(parseCsvLine('a,,')).toEqual(['a', '', '']);
  });
});

describe('date handling', () => {
  it('parses both two- and four-digit years', () => {
    expect(parseCsvDate('16/08/2024', '20:00')?.date.toISOString()).toBe('2024-08-16T19:00:00.000Z');
    expect(parseCsvDate('16/08/24', '20:00')?.date.toISOString()).toBe('2024-08-16T19:00:00.000Z');
  });

  it('converts UK local time to UTC across the DST boundary', () => {
    // August: BST (UTC+1). December: GMT (UTC+0). Treating both as UTC would
    // put summer fixtures an hour late and break "known before T" filters.
    expect(ukLocalToUtc(2024, 8, 16, 20, 0).toISOString()).toBe('2024-08-16T19:00:00.000Z');
    expect(ukLocalToUtc(2024, 12, 16, 20, 0).toISOString()).toBe('2024-12-16T20:00:00.000Z');
  });

  it('flags rows where the time column was missing', () => {
    const parsed = parseCsvDate('16/08/2024', undefined);
    expect(parsed?.assumed).toBe(true);
    expect(parsed?.date.toISOString()).toBe('2024-08-16T11:00:00.000Z');
  });

  it('returns null for an unparseable date instead of Invalid Date', () => {
    expect(parseCsvDate('not-a-date', '20:00')).toBeNull();
  });
});

describe('parseSeasonCsv', () => {
  const rows = parseSeasonCsv(sample, 'E0');

  it('parses every real match row and drops blank filler', () => {
    expect(rows).toHaveLength(3);
  });

  it('reads results, half-time scores and statistics', () => {
    const match = rows[0]!;
    expect(match.homeTeamName).toBe('Man United');
    expect(match.awayTeamName).toBe('Fulham');
    expect(match.homeScore).toBe(1);
    expect(match.awayScore).toBe(0);
    expect(match.halfTimeHomeScore).toBe(0);
    expect(match.halfTimeAwayScore).toBe(0);
    expect(match.referee).toBe('R Jones');
    expect(match.homeStats.shots).toBe(14);
    expect(match.homeStats.shotsOnTarget).toBe(5);
    expect(match.homeStats.corners).toBe(7);
    expect(match.awayStats.yellowCards).toBe(3);
    expect(match.kickoffTimeAssumed).toBe(false);
  });

  it('extracts both opening and closing prices', () => {
    const match = rows[0]!;
    const b365Home = match.odds.filter(
      (o) => o.bookmakerKey === 'B365' && o.selectionCode === 'MS_1',
    );
    expect(b365Home).toHaveLength(2);
    expect(b365Home.some((o) => o.isOpening)).toBe(true);
    expect(b365Home.some((o) => o.isClosing)).toBe(true);
    // Closing prices are what a model is graded against (§22).
    expect(b365Home.find((o) => o.isClosing)!.price).toBeGreaterThan(1);
  });

  it('normalises markets into the internal vocabulary', () => {
    const codes = new Set(rows[0]!.odds.map((o) => o.marketCode));
    expect(codes.has('MATCH_RESULT')).toBe(true);
    expect(codes.has('OVER_UNDER')).toBe(true);
    expect(codes.has('ASIAN_HANDICAP')).toBe(true);

    const over = rows[0]!.odds.find((o) => o.selectionCode === 'OVER_2_5');
    expect(over?.parameters).toMatchObject({ line: 2.5, side: 'OVER' });
  });

  it('gives the two Asian handicap sides opposite lines', () => {
    const ah = rows[0]!.odds.filter((o) => o.marketCode === 'ASIAN_HANDICAP' && o.isClosing === false);
    const home = ah.find((o) => o.selectionCode.startsWith('AH_HOME'));
    const away = ah.find((o) => o.selectionCode.startsWith('AH_AWAY'));
    expect(home).toBeDefined();
    expect(away).toBeDefined();
    expect(home!.handicap).toBeCloseTo(-away!.handicap);
  });

  it('never emits a price at or below 1.00', () => {
    for (const row of rows) {
      for (const price of row.odds) {
        expect(price.price).toBeGreaterThan(1);
      }
    }
  });

  it('filters out rows from another division', () => {
    expect(parseSeasonCsv(sample, 'D1')).toHaveLength(0);
  });

  it('survives an empty or header-only file', () => {
    expect(parseSeasonCsv('')).toEqual([]);
    expect(parseSeasonCsv('Div,Date,HomeTeam\n')).toEqual([]);
  });
});
