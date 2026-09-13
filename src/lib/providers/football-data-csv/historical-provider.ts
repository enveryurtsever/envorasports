import { createLogger } from '@/lib/logging/logger';
import { ProviderError } from '../types';
import { CSV_DIVISION_BY_CODE, FOOTBALL_DATA_BASE_URL, csvUrl } from './divisions';
import { parseCountryCsv, parseSeasonCsv, type HistoricalMatchRow } from './parser';

export const FOOTBALL_DATA_CSV = 'football-data-csv';

const log = createLogger('provider:football-data-csv');

export interface HistoricalDataProvider {
  readonly name: string;
  /** One division for one season, e.g. ("E0", 2024) -> the 2024/25 file. */
  getSeason(division: string, startYear: number): Promise<HistoricalMatchRow[]>;
  listDivisions(): string[];
}

/**
 * Static CSV archive — unmetered, so this is where bulk history comes from.
 * It has no rate limit, but it is still a network dependency: failures are
 * ProviderErrors like everywhere else, never thrown strings.
 */
export function createFootballDataCsvProvider(
  config: { baseUrl?: string; timeoutMs?: number } = {},
): HistoricalDataProvider {
  const baseUrl = config.baseUrl ?? FOOTBALL_DATA_BASE_URL;
  const timeoutMs = config.timeoutMs ?? 30_000;

  return {
    name: FOOTBALL_DATA_CSV,

    listDivisions() {
      return [...CSV_DIVISION_BY_CODE.keys()];
    },

    async getSeason(division: string, startYear: number): Promise<HistoricalMatchRow[]> {
      if (!CSV_DIVISION_BY_CODE.has(division)) {
        throw new ProviderError(`Unknown division "${division}"`, {
          provider: FOOTBALL_DATA_CSV,
          endpoint: division,
          retryable: false,
        });
      }

      const url = csvUrl(baseUrl, startYear, division);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) {
          throw new ProviderError(`football-data.co.uk responded ${response.status}`, {
            provider: FOOTBALL_DATA_CSV,
            endpoint: url,
            statusCode: response.status,
            // A season file that does not exist yet is not worth retrying.
            retryable: response.status >= 500,
          });
        }

        const csv = await response.text();
        const archive = CSV_DIVISION_BY_CODE.get(division)?.archive;
        const rows = archive
          ? parseCountryCsv(csv, { division, league: archive.league, season: startYear })
          : parseSeasonCsv(csv, division);
        log.info('season parsed', { division, startYear, matches: rows.length });
        return rows;
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError(`Failed to download ${url}`, {
          provider: FOOTBALL_DATA_CSV,
          endpoint: url,
          retryable: true,
          cause: error,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
