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
  /**
   * Where the archive keeps this league.
   *
   * The main European divisions have one file per season under
   * /mmz4281/<season>/<code>.csv, with a Div column, half-time scores, match
   * statistics and opening as well as closing prices. The "extra" leagues —
   * Scandinavia, the Americas, Asia — live in one file per country under
   * /new/<file>.csv, every season together, a League column instead of Div,
   * full-time goals only and closing prices only. Same archive, different
   * shape; the parser needs to know which it is holding.
   */
  archive?: { file: string; league: string };
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
  /**
   * The goal leagues, chosen by measurement rather than by reputation.
   *
   * Over the last five seasons of the archive, six or more goals land in 8.2%
   * of Eliteserien and MLS matches, 7.1% of the Superliga's and 6.6% of the
   * Allsvenskan's, against 5.8% across everything already held — comparable
   * to the Eredivisie and 2. Bundesliga, the best of the existing set. The
   * same measurement kept Brazil (3.7%), Argentina (2.4%) and Japan (5.0%)
   * out, whatever a screenshot of one 3-3 might suggest. All four are
   * calendar-year leagues in play through the European autumn.
   */
  { code: 'NOR1', name: 'Eliteserien', country: 'Norway', oddsApiKey: 'soccer_norway_eliteserien', tier: 1, archive: { file: 'NOR', league: 'Eliteserien' } },
  { code: 'USA1', name: 'MLS', country: 'USA', oddsApiKey: 'soccer_usa_mls', tier: 1, archive: { file: 'USA', league: 'MLS' }, apiFootballName: 'Major League Soccer' },
  { code: 'DNK1', name: 'Superliga', country: 'Denmark', oddsApiKey: 'soccer_denmark_superliga', tier: 1, archive: { file: 'DNK', league: 'Superliga' } },
  { code: 'SWE1', name: 'Allsvenskan', country: 'Sweden', oddsApiKey: 'soccer_sweden_allsvenskan', tier: 1, archive: { file: 'SWE', league: 'Allsvenskan' } },
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
  const root = baseUrl.replace(/\/$/, '');
  const archive = CSV_DIVISION_BY_CODE.get(division)?.archive;
  // One file per country carries every season; the season is filtered after.
  if (archive) return `${root}/new/${archive.file}.csv`;
  return `${root}/mmz4281/${seasonCode(startYear)}/${division}.csv`;
}

/**
 * The bare domain, not `www.`.
 *
 * The `www.` host answers 503 to everything — the CSVs, the index pages, all
 * of it — while the apex serves normally. That is why the archive refresh had
 * been failing silently: League One and League Two were added but never
 * imported, leaving them with 3 matches and 0 against 2,288 for the
 * Championship, and the ~38 clubs in those divisions had no row at all, so
 * every one of their fixtures was discarded as an unresolvable team.
 */
export const FOOTBALL_DATA_BASE_URL = 'https://football-data.co.uk';
