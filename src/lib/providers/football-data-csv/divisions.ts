/**
 * football-data.co.uk division codes.
 *
 * These CSVs are the historical backbone: results, match statistics and — the
 * part no free API gives us — real opening AND closing prices. The metered live
 * APIs are reserved for today's bulletin; everything older comes from here.
 */

export interface CsvDivision {
  /** football-data.co.uk code, e.g. "E0". */
  code: string;
  name: string;
  country: string;
  /** The Odds API competition key, when the same league is priced there. */
  oddsApiKey: string | null;
  tier: number;
  /**
   * Explicit API-Football name/country when they differ from ours. Auto-mapping
   * matches on normalised name plus country; these are the cases where that
   * genuinely disagrees ("Süper Lig" is filed under Turkey, not Türkiye).
   */
  apiFootballName?: string;
  apiFootballCountry?: string;
}

export const CSV_DIVISIONS: CsvDivision[] = [
  { code: 'E0', name: 'Premier League', country: 'England', oddsApiKey: 'soccer_epl', tier: 1 },
  { code: 'E1', name: 'Championship', country: 'England', oddsApiKey: 'soccer_efl_champ', tier: 2 },
  // The lower two English divisions carry a full CSV archive, so their history
  // costs nothing to backfill — unlike the leagues the odds provider also
  // carries but this archive does not.
  { code: 'E2', name: 'League One', country: 'England', oddsApiKey: 'soccer_england_league1', tier: 3 },
  { code: 'E3', name: 'League Two', country: 'England', oddsApiKey: 'soccer_england_league2', tier: 4 },
  { code: 'SP1', name: 'La Liga', country: 'Spain', oddsApiKey: 'soccer_spain_la_liga', tier: 1 },
  { code: 'SP2', name: 'La Liga 2', country: 'Spain', oddsApiKey: 'soccer_spain_segunda_division', tier: 2, apiFootballName: 'Segunda División' },
  { code: 'D1', name: 'Bundesliga', country: 'Germany', oddsApiKey: 'soccer_germany_bundesliga', tier: 1 },
  { code: 'D2', name: '2. Bundesliga', country: 'Germany', oddsApiKey: 'soccer_germany_bundesliga2', tier: 2 },
  { code: 'I1', name: 'Serie A', country: 'Italy', oddsApiKey: 'soccer_italy_serie_a', tier: 1 },
  { code: 'I2', name: 'Serie B', country: 'Italy', oddsApiKey: 'soccer_italy_serie_b', tier: 2 },
  { code: 'F1', name: 'Ligue 1', country: 'France', oddsApiKey: 'soccer_france_ligue_one', tier: 1 },
  { code: 'F2', name: 'Ligue 2', country: 'France', oddsApiKey: 'soccer_france_ligue_two', tier: 2 },
  { code: 'N1', name: 'Eredivisie', country: 'Netherlands', oddsApiKey: 'soccer_netherlands_eredivisie', tier: 1 },
  { code: 'P1', name: 'Primeira Liga', country: 'Portugal', oddsApiKey: 'soccer_portugal_primeira_liga', tier: 1 },
  { code: 'T1', name: 'Süper Lig', country: 'Türkiye', oddsApiKey: 'soccer_turkey_super_league', tier: 1, apiFootballCountry: 'Turkey' },
  { code: 'B1', name: 'Jupiler Pro League', country: 'Belgium', oddsApiKey: 'soccer_belgium_first_div', tier: 1 },
  { code: 'SC0', name: 'Premiership', country: 'Scotland', oddsApiKey: 'soccer_spl', tier: 1 },
  { code: 'G1', name: 'Super League', country: 'Greece', oddsApiKey: 'soccer_greece_super_league', tier: 1, apiFootballName: 'Super League 1' },
];

export const CSV_DIVISION_BY_CODE = new Map(CSV_DIVISIONS.map((d) => [d.code, d]));

/**
 * Season folder name: 2024/25 -> "2425". The site keeps one file per division
 * per season under /mmz4281/<season>/<division>.csv.
 */
export function seasonCode(startYear: number): string {
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return `${a}${b}`;
}

export function csvUrl(baseUrl: string, startYear: number, division: string): string {
  return `${baseUrl.replace(/\/$/, '')}/mmz4281/${seasonCode(startYear)}/${division}.csv`;
}

export const FOOTBALL_DATA_BASE_URL = 'https://www.football-data.co.uk';
