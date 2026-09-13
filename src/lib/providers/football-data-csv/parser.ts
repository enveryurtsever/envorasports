import { MARKET, asianHandicapCode, overUnderCode } from '@/lib/markets/registry';

/**
 * Parser for football-data.co.uk season CSVs.
 *
 * The files are wide (120+ columns), the column set changes between seasons,
 * and trailing blank rows are normal. Everything here is defensive: an unknown
 * or missing column yields null rather than a wrong number.
 */

export interface HistoricalOddsRecord {
  bookmakerKey: string;
  bookmakerName: string;
  marketCode: string;
  selectionCode: string;
  parameters: Record<string, unknown> | null;
  price: number;
  handicap: number;
  isOpening: boolean;
  isClosing: boolean;
}

export interface HistoricalTeamStats {
  shots: number | null;
  shotsOnTarget: number | null;
  fouls: number | null;
  corners: number | null;
  yellowCards: number | null;
  redCards: number | null;
}

export interface HistoricalMatchRow {
  division: string;
  /** Kickoff in UTC. */
  kickoffUtc: Date;
  /** True when the file had no Time column and 12:00 local was assumed. */
  kickoffTimeAssumed: boolean;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  halfTimeHomeScore: number | null;
  halfTimeAwayScore: number | null;
  referee: string | null;
  homeStats: HistoricalTeamStats;
  awayStats: HistoricalTeamStats;
  odds: HistoricalOddsRecord[];
}

// --- CSV primitives --------------------------------------------------------

/** RFC-4180 style splitter: handles quoted fields containing commas. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function num(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function odds(value: string | undefined): number | null {
  const parsed = num(value);
  // A decimal price of 1.00 or below is a placeholder, not a real quote.
  return parsed !== null && parsed > 1 ? parsed : null;
}

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// --- time ------------------------------------------------------------------

/**
 * The files carry UK local dates/times with no offset. Storing them as UTC
 * directly would shift every summer fixture by an hour, which quietly corrupts
 * "which matches happened before time T" in a backtest.
 */
export function ukLocalToUtc(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Start from the naive UTC interpretation, then subtract the zone offset that
  // Europe/London actually had at that instant.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetMs = londonOffsetMs(new Date(naive));
  return new Date(naive - offsetMs);
}

function londonOffsetMs(at: Date): number {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - at.getTime();
}

/** Accepts dd/mm/yy and dd/mm/yyyy, the two formats the archive uses. */
export function parseCsvDate(date: string, time: string | undefined): { date: Date; assumed: boolean } | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(date.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const rawYear = Number(match[3]);
  // Two-digit years in this archive are all 1993+.
  const year = rawYear < 100 ? (rawYear < 90 ? 2000 + rawYear : 1900 + rawYear) : rawYear;

  const timeMatch = time ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  const hour = timeMatch ? Number(timeMatch[1]) : 12;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;

  return { date: ukLocalToUtc(year, month, day, hour, minute), assumed: !timeMatch };
}

// --- odds columns ----------------------------------------------------------

interface BookSpec {
  key: string;
  name: string;
  /** Column prefixes for [opening, closing]; closing is null when absent. */
  h2h: [string, string | null];
  totals: [string, string | null] | null;
  handicap: [string, string | null] | null;
}

/**
 * Only books that appear consistently across seasons. "C" in a column name
 * means closing (B365CH = Bet365 closing home).
 */
const BOOKS: BookSpec[] = [
  { key: 'B365', name: 'Bet365', h2h: ['B365', 'B365C'], totals: ['B365', 'B365C'], handicap: ['B365AH', 'B365CAH'] },
  { key: 'PS', name: 'Pinnacle', h2h: ['PS', 'PSC'], totals: ['P', 'PC'], handicap: ['PAH', 'PCAH'] },
  { key: 'AVG', name: 'Market Average', h2h: ['Avg', 'AvgC'], totals: ['Avg', 'AvgC'], handicap: ['AvgAH', 'AvgCAH'] },
  { key: 'MAX', name: 'Market Best', h2h: ['Max', 'MaxC'], totals: ['Max', 'MaxC'], handicap: ['MaxAH', 'MaxCAH'] },
];

function pushOdds(
  out: HistoricalOddsRecord[],
  book: BookSpec,
  isClosing: boolean,
  marketCode: string,
  selectionCode: string,
  price: number | null,
  parameters: Record<string, unknown> | null,
  handicap = 0,
): void {
  if (price === null) return;
  out.push({
    bookmakerKey: book.key,
    bookmakerName: book.name,
    marketCode,
    selectionCode,
    parameters,
    price,
    handicap,
    isOpening: !isClosing,
    isClosing,
  });
}

function extractOdds(row: Record<string, string>): HistoricalOddsRecord[] {
  const out: HistoricalOddsRecord[] = [];
  // The over/under column set is fixed at the 2.5 line in these files.
  const TOTAL_LINE = 2.5;

  for (const book of BOOKS) {
    for (const [index, isClosing] of [
      [0, false],
      [1, true],
    ] as const) {
      const h2hPrefix = book.h2h[index];
      if (h2hPrefix) {
        pushOdds(out, book, isClosing, MARKET.MATCH_RESULT, 'MS_1', odds(row[`${h2hPrefix}H`]), { outcome: 'HOME' });
        pushOdds(out, book, isClosing, MARKET.MATCH_RESULT, 'MS_X', odds(row[`${h2hPrefix}D`]), { outcome: 'DRAW' });
        pushOdds(out, book, isClosing, MARKET.MATCH_RESULT, 'MS_2', odds(row[`${h2hPrefix}A`]), { outcome: 'AWAY' });
      }

      const totalsPrefix = book.totals?.[index];
      if (totalsPrefix) {
        pushOdds(
          out, book, isClosing, MARKET.OVER_UNDER,
          overUnderCode('OVER', TOTAL_LINE), odds(row[`${totalsPrefix}>${TOTAL_LINE}`]),
          { line: TOTAL_LINE, side: 'OVER', subject: 'total' },
        );
        pushOdds(
          out, book, isClosing, MARKET.OVER_UNDER,
          overUnderCode('UNDER', TOTAL_LINE), odds(row[`${totalsPrefix}<${TOTAL_LINE}`]),
          { line: TOTAL_LINE, side: 'UNDER', subject: 'total' },
        );
      }

      const ahPrefix = book.handicap?.[index];
      // The line itself lives in its own column (AHh / AHCh), and it moves.
      const line = num(row[isClosing ? 'AHCh' : 'AHh']) ?? num(row.AHh);
      if (ahPrefix && line !== null) {
        pushOdds(
          out, book, isClosing, MARKET.ASIAN_HANDICAP,
          asianHandicapCode('HOME', line), odds(row[`${ahPrefix}H`]),
          { side: 'HOME', handicap: line }, line,
        );
        pushOdds(
          out, book, isClosing, MARKET.ASIAN_HANDICAP,
          asianHandicapCode('AWAY', -line), odds(row[`${ahPrefix}A`]),
          { side: 'AWAY', handicap: -line }, -line,
        );
      }
    }
  }

  return out;
}

// --- entry point -----------------------------------------------------------

/**
 * Reads the archive's country files, which hold every season of a league in
 * one CSV with a different header from the per-season files: Country, League,
 * Season, Date, Time, Home, Away, HG, AG, Res, then closing prices only. No
 * half-time score, no statistics, no opening odds.
 *
 * Rows are renamed onto the per-season vocabulary and handed to the same row
 * builder, so the two shapes produce identical records and the odds columns —
 * PSC, MaxC, AvgC, B365C — are read by the same book table. Filtered to one
 * league and one season, because the file carries all of both.
 */
export function parseCountryCsv(
  csv: string,
  options: { division: string; league: string; season: number },
): HistoricalMatchRow[] {
  const clean = csv.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0] as string).map((h) => h.trim());
  const rows: HistoricalMatchRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i] as string);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });

    // Some rows carry a trailing space on the league name ("Superliga ").
    if (text(row.League)?.trim() !== options.league) continue;
    // A calendar league writes "2026"; an autumn-spring one writes "2026/2027".
    // Either way the first four digits are the season's start year.
    if (Number((row.Season ?? '').trim().slice(0, 4)) !== options.season) continue;

    row.Div = options.division;
    row.HomeTeam = row.Home ?? '';
    row.AwayTeam = row.Away ?? '';
    row.FTHG = row.HG ?? '';
    row.FTAG = row.AG ?? '';

    const built = buildRow(row, options.division);
    if (built) rows.push(built);
  }

  return rows;
}

export function parseSeasonCsv(csv: string, expectedDivision?: string): HistoricalMatchRow[] {
  // Strip a UTF-8 BOM; the first header would otherwise be "﻿Div".
  const clean = csv.replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0] as string).map((h) => h.trim());
  const rows: HistoricalMatchRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i] as string);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? '';
    });

    const built = buildRow(row, expectedDivision);
    if (built) rows.push(built);
  }

  return rows;
}

/** One record from one row, or null for a footer, a blank, or another division. */
function buildRow(row: Record<string, string>, expectedDivision?: string): HistoricalMatchRow | null {
  {
    const division = text(row.Div);
    const homeTeamName = text(row.HomeTeam);
    const awayTeamName = text(row.AwayTeam);
    const homeScore = num(row.FTHG);
    const awayScore = num(row.FTAG);

    // A row without teams or a final score is a footer/blank artefact.
    if (!division || !homeTeamName || !awayTeamName || homeScore === null || awayScore === null) {
      return null;
    }
    if (expectedDivision && division !== expectedDivision) return null;

    const parsedDate = parseCsvDate(row.Date ?? '', row.Time);
    if (!parsedDate) return null;

    return {
      division,
      kickoffUtc: parsedDate.date,
      kickoffTimeAssumed: parsedDate.assumed,
      homeTeamName,
      awayTeamName,
      homeScore,
      awayScore,
      halfTimeHomeScore: num(row.HTHG),
      halfTimeAwayScore: num(row.HTAG),
      referee: text(row.Referee),
      homeStats: {
        shots: num(row.HS),
        shotsOnTarget: num(row.HST),
        fouls: num(row.HF),
        corners: num(row.HC),
        yellowCards: num(row.HY),
        redCards: num(row.HR),
      },
      awayStats: {
        shots: num(row.AS),
        shotsOnTarget: num(row.AST),
        fouls: num(row.AF),
        corners: num(row.AC),
        yellowCards: num(row.AY),
        redCards: num(row.AR),
      },
      odds: extractOdds(row),
    };
  }
}
