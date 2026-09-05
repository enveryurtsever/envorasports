/**
 * The canonical betting vocabulary (§20, §21).
 *
 * One source of truth for: the database seed, every provider adapter's
 * normalisation step, the settlement evaluators and the UI labels. A new market
 * is added here and nowhere else — no migration, no schema change.
 */

export type MarketCategory =
  | 'RESULT'
  | 'GOALS'
  | 'BOTH_TEAMS'
  | 'HALVES'
  | 'SCORE'
  | 'HANDICAP'
  | 'TEAM_TOTALS'
  | 'CORNERS'
  | 'CARDS'
  | 'SPECIALS';

export const MARKET = {
  MATCH_RESULT: 'MATCH_RESULT',
  DOUBLE_CHANCE: 'DOUBLE_CHANCE',
  OVER_UNDER: 'OVER_UNDER',
  BTTS: 'BTTS',
  HALF_TIME_RESULT: 'HALF_TIME_RESULT',
  HALF_TIME_FULL_TIME: 'HALF_TIME_FULL_TIME',
  GOAL_RANGE: 'GOAL_RANGE',
  TOTAL_GOALS_THRESHOLD: 'TOTAL_GOALS_THRESHOLD',
  CORRECT_SCORE: 'CORRECT_SCORE',
  ASIAN_HANDICAP: 'ASIAN_HANDICAP',
  TEAM_TOTAL: 'TEAM_TOTAL',
  CORNERS: 'CORNERS',
  CARDS: 'CARDS',
} as const;

export type MarketCode = (typeof MARKET)[keyof typeof MARKET];

export interface SelectionDefinition {
  code: string;
  /** English name; the UI resolves the localized label from `selections.*`. */
  name: string;
  /** i18n key + values, so TR/EN labels stay data-driven. */
  labelKey: string;
  labelValues?: Record<string, string | number>;
  parameters: Record<string, unknown> | null;
}

export interface MarketDefinition {
  code: MarketCode;
  name: string;
  category: MarketCategory;
  description: string;
  /** Lines this market is seeded with; providers may price a subset. */
  selections: SelectionDefinition[];
}

// --- helpers ---------------------------------------------------------------

/** 2.5 -> "2_5" so codes stay filename- and URL-safe. */
export function lineToCode(line: number): string {
  return String(line).replace('.', '_').replace('-', 'M');
}

export function overUnderCode(side: 'OVER' | 'UNDER', line: number): string {
  return `${side}_${lineToCode(line)}`;
}

export function goalsPlusCode(goals: number): string {
  return `GOALS_${goals}_PLUS`;
}

export function goalRangeCode(min: number, max: number | null): string {
  return max === null ? `GOAL_RANGE_${min}_PLUS` : `GOAL_RANGE_${min}_${max}`;
}

export function correctScoreCode(home: number, away: number): string {
  return `CS_${home}_${away}`;
}

export function htftCode(half: '1' | 'X' | '2', full: '1' | 'X' | '2'): string {
  return `HTFT_${half}_${full}`;
}

export function asianHandicapCode(side: 'HOME' | 'AWAY', handicap: number): string {
  const sign = handicap < 0 ? 'M' : 'P';
  return `AH_${side}_${sign}${lineToCode(Math.abs(handicap))}`;
}

export function teamTotalCode(side: 'HOME' | 'AWAY', direction: 'OVER' | 'UNDER', line: number): string {
  return `TEAM_${side}_${direction}_${lineToCode(line)}`;
}

// --- lines we seed ---------------------------------------------------------

export const GOAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5] as const;
export const TEAM_GOAL_LINES = [0.5, 1.5, 2.5] as const;
export const GOALS_PLUS_THRESHOLDS = [6, 7] as const;
export const ASIAN_HANDICAP_LINES = [-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2] as const;

/** A whole-line handicap refunds the stake when the margin lands exactly on it. */
export function handicapPushes(handicap: number): boolean {
  return Number.isInteger(handicap);
}

/**
 * True when a handicap is just the match result wearing a handicap's name.
 *
 * A -0.5 handicap wins exactly when the team wins by one or more, which is the
 * plain 1X2 result. Carrying it as a second code means the same event can be
 * described two ways, and "Fulham Kazanir" competes with "MS 1" for the same
 * bet. MS is the one a reader knows, so the handicap form is not offered.
 */
export function handicapDuplicatesMatchResult(handicap: number): boolean {
  return Math.abs(handicap) === 0.5;
}

/**
 * Says what a handicap actually asks for.
 *
 * "Rodez -1" tells a reader nothing; "Rodez wins by 2+" tells them exactly what
 * has to happen. Half-lines can be stated exactly in a few words. Whole lines
 * cannot — they hand the stake back when the margin lands on the line — so they
 * keep the number and are not offered on a coupon, where a one-line chip has no
 * room to explain a refund.
 */
function handicapLabel(handicap: number): { labelKey: string } {
  if (handicapPushes(handicap)) return { labelKey: 'selections.AH' };
  if (handicap === -0.5) return { labelKey: 'selections.AH_WIN' };
  if (handicap === 0.5) return { labelKey: 'selections.AH_NOT_LOSE' };
  return handicap < 0
    ? { labelKey: 'selections.AH_WIN_BY' }
    : { labelKey: 'selections.AH_NOT_LOSE_BY' };
}
export const CORNER_LINES = [8.5, 9.5, 10.5, 11.5] as const;
export const CARD_LINES = [2.5, 3.5, 4.5, 5.5] as const;
const HTFT_OUTCOMES = ['1', 'X', '2'] as const;
/** Correct-score grid; anything outside is priced as "any other score". */
const CORRECT_SCORE_MAX = 4;

// --- definitions -----------------------------------------------------------

function overUnderSelections(
  market: 'total' | 'corners' | 'cards',
  lines: readonly number[],
): SelectionDefinition[] {
  return lines.flatMap((line) =>
    (['OVER', 'UNDER'] as const).map((side) => ({
      code: overUnderCode(side, line),
      name: `${side === 'OVER' ? 'Over' : 'Under'} ${line.toFixed(1)}`,
      labelKey: side === 'OVER' ? 'selections.OVER' : 'selections.UNDER',
      labelValues: { line },
      parameters: { line, side, subject: market },
    })),
  );
}

export const MARKET_DEFINITIONS: MarketDefinition[] = [
  {
    code: MARKET.MATCH_RESULT,
    name: 'Match Result',
    category: 'RESULT',
    description: 'Full-time 1X2 result.',
    selections: [
      { code: 'MS_1', name: 'Home win', labelKey: 'selections.MS_1', parameters: { outcome: 'HOME' } },
      { code: 'MS_X', name: 'Draw', labelKey: 'selections.MS_X', parameters: { outcome: 'DRAW' } },
      { code: 'MS_2', name: 'Away win', labelKey: 'selections.MS_2', parameters: { outcome: 'AWAY' } },
    ],
  },
  {
    code: MARKET.DOUBLE_CHANCE,
    name: 'Double Chance',
    category: 'RESULT',
    description: 'Two of the three full-time outcomes.',
    selections: [
      {
        code: 'DOUBLE_CHANCE_1X',
        name: 'Home or Draw',
        labelKey: 'selections.DOUBLE_CHANCE_1X',
        parameters: { outcomes: ['HOME', 'DRAW'] },
      },
      {
        code: 'DOUBLE_CHANCE_X2',
        name: 'Draw or Away',
        labelKey: 'selections.DOUBLE_CHANCE_X2',
        parameters: { outcomes: ['DRAW', 'AWAY'] },
      },
      {
        code: 'DOUBLE_CHANCE_12',
        name: 'Home or Away',
        labelKey: 'selections.DOUBLE_CHANCE_12',
        parameters: { outcomes: ['HOME', 'AWAY'] },
      },
    ],
  },
  {
    code: MARKET.OVER_UNDER,
    name: 'Over / Under',
    category: 'GOALS',
    description: 'Total match goals against a line.',
    selections: overUnderSelections('total', GOAL_LINES),
  },
  {
    code: MARKET.BTTS,
    name: 'Both Teams to Score',
    category: 'BOTH_TEAMS',
    description: 'Whether both teams score at least once.',
    selections: [
      { code: 'BTTS_YES', name: 'Yes', labelKey: 'selections.BTTS_YES', parameters: { value: true } },
      { code: 'BTTS_NO', name: 'No', labelKey: 'selections.BTTS_NO', parameters: { value: false } },
    ],
  },
  {
    code: MARKET.HALF_TIME_RESULT,
    name: 'Half-Time Result',
    category: 'HALVES',
    description: '1X2 at half time. Settled on the half-time score only.',
    selections: [
      { code: 'HT_1', name: 'Home leads', labelKey: 'selections.HT_1', parameters: { outcome: 'HOME' } },
      { code: 'HT_X', name: 'Level', labelKey: 'selections.HT_X', parameters: { outcome: 'DRAW' } },
      { code: 'HT_2', name: 'Away leads', labelKey: 'selections.HT_2', parameters: { outcome: 'AWAY' } },
    ],
  },
  {
    code: MARKET.HALF_TIME_FULL_TIME,
    name: 'Half-Time / Full-Time',
    category: 'HALVES',
    description: 'Combination of the half-time and full-time results.',
    selections: HTFT_OUTCOMES.flatMap((half) =>
      HTFT_OUTCOMES.map((full) => ({
        code: htftCode(half, full),
        name: `${half}/${full}`,
        labelKey: 'selections.HTFT',
        labelValues: { half, full },
        parameters: { half, full },
      })),
    ),
  },
  {
    code: MARKET.GOAL_RANGE,
    name: 'Goal Range',
    category: 'GOALS',
    description: 'Total goals falling inside a band.',
    selections: (
      [
        { min: 0, max: 1 },
        { min: 2, max: 3 },
        { min: 4, max: 6 },
        { min: 7, max: null },
      ] as Array<{ min: number; max: number | null }>
    ).map(({ min, max }): SelectionDefinition => ({
      code: goalRangeCode(min, max),
      name: max === null ? `${min}+ goals` : `${min}-${max} goals`,
      labelKey: max === null ? 'selections.GOALS_PLUS' : 'selections.GOAL_RANGE',
      labelValues: max === null ? { goals: min } : { min, max },
      parameters: { min, max },
    })),
  },
  {
    code: MARKET.TOTAL_GOALS_THRESHOLD,
    name: 'Total Goals Threshold',
    category: 'GOALS',
    description: 'High-goal specials such as 6+ and 7+ goals.',
    selections: GOALS_PLUS_THRESHOLDS.map((goals) => ({
      code: goalsPlusCode(goals),
      name: `${goals}+ goals`,
      labelKey: 'selections.GOALS_PLUS',
      labelValues: { goals },
      parameters: { goals },
    })),
  },
  {
    code: MARKET.CORRECT_SCORE,
    name: 'Correct Score',
    category: 'SCORE',
    description: 'Exact final score.',
    selections: Array.from({ length: CORRECT_SCORE_MAX + 1 }, (_, home) =>
      Array.from({ length: CORRECT_SCORE_MAX + 1 }, (_, away) => ({
        code: correctScoreCode(home, away),
        name: `${home}-${away}`,
        labelKey: 'selections.CORRECT_SCORE',
        labelValues: { home, away },
        parameters: { home, away },
      })),
    ).flat(),
  },
  {
    code: MARKET.ASIAN_HANDICAP,
    name: 'Asian Handicap',
    category: 'HANDICAP',
    description: 'Goal handicap applied to one side; supports push and half-win.',
    selections: ASIAN_HANDICAP_LINES.flatMap((handicap) =>
      (['HOME', 'AWAY'] as const).map((side) => ({
        code: asianHandicapCode(side, handicap),
        name: `${side === 'HOME' ? 'Home' : 'Away'} ${handicap > 0 ? '+' : ''}${handicap}`,
        ...handicapLabel(handicap),
        labelValues: {
          team: side === 'HOME' ? 'home' : 'away',
          handicap: `${handicap > 0 ? '+' : ''}${handicap}`,
          margin: Math.ceil(Math.abs(handicap)),
        },
        parameters: { side, handicap },
      })),
    ),
  },
  {
    code: MARKET.TEAM_TOTAL,
    name: 'Team Goals',
    category: 'TEAM_TOTALS',
    description: 'Goals scored by one team against a line.',
    selections: TEAM_GOAL_LINES.flatMap((line) =>
      (['HOME', 'AWAY'] as const).flatMap((side) =>
        (['OVER', 'UNDER'] as const).map((direction) => ({
          code: teamTotalCode(side, direction, line),
          name: `${side === 'HOME' ? 'Home' : 'Away'} ${direction === 'OVER' ? 'over' : 'under'} ${line.toFixed(1)}`,
          labelKey: direction === 'OVER' ? 'selections.TEAM_OVER' : 'selections.TEAM_UNDER',
          labelValues: { team: side === 'HOME' ? 'home' : 'away', line },
          parameters: { side, direction, line },
        })),
      ),
    ),
  },
  {
    code: MARKET.CORNERS,
    name: 'Corners',
    category: 'CORNERS',
    description: 'Total match corners. Settled from official corner statistics.',
    selections: overUnderSelections('corners', CORNER_LINES),
  },
  {
    code: MARKET.CARDS,
    name: 'Cards',
    category: 'CARDS',
    description: 'Total cards using the configured counting convention.',
    selections: overUnderSelections('cards', CARD_LINES),
  },
];

export const MARKET_BY_CODE = new Map<string, MarketDefinition>(
  MARKET_DEFINITIONS.map((m) => [m.code, m]),
);

export function findSelection(
  marketCode: string,
  selectionCode: string,
): SelectionDefinition | undefined {
  return MARKET_BY_CODE.get(marketCode)?.selections.find((s) => s.code === selectionCode);
}

export function totalSelectionCount(): number {
  return MARKET_DEFINITIONS.reduce((sum, m) => sum + m.selections.length, 0);
}
