import { serverEnv } from '@/lib/env';
import { createApiFootballProvider } from './api-football/football-provider';
import { API_FOOTBALL } from './api-football/client';
import { createTheOddsApiProvider, THE_ODDS_API } from './the-odds-api/odds-provider';
import { createFootballDataCsvProvider, type HistoricalDataProvider } from './football-data-csv/historical-provider';
import { createMockFootballProvider, createMockOddsProvider } from './mock/mock-providers';
import type { QuotaPolicy } from './quota';
import type { FootballDataProvider, OddsProvider } from './types';

/**
 * Provider wiring (§39). Everything above this file depends on the interfaces,
 * never on a concrete vendor — swapping either provider is a change here alone.
 *
 * Three sources, chosen for what each is actually good at:
 *   - api-football     : today's fixtures, live status, stats, lineups (100/day)
 *   - the-odds-api     : today's bulletin, i.e. which markets are priced (500/mo)
 *   - football-data-csv: years of history with real closing prices (unmetered)
 */

export function footballQuotaPolicy(): QuotaPolicy {
  return {
    provider: API_FOOTBALL,
    window: 'day',
    budget: serverEnv().FOOTBALL_API_DAILY_BUDGET,
    // Keep a fifth of the day's calls for result sync and settlement.
    reserveRatio: 0.2,
  };
}

export function oddsQuotaPolicy(): QuotaPolicy {
  return {
    provider: THE_ODDS_API,
    window: 'month',
    budget: serverEnv().ODDS_API_MONTHLY_BUDGET,
    reserveRatio: 0.15,
  };
}

let footballProvider: FootballDataProvider | null = null;
let oddsProvider: OddsProvider | null = null;
let historicalProvider: HistoricalDataProvider | null = null;

export function getFootballProvider(): FootballDataProvider {
  if (footballProvider) return footballProvider;
  const env = serverEnv();

  footballProvider =
    env.FOOTBALL_PROVIDER === 'api-football'
      ? createApiFootballProvider({
          apiKey: env.FOOTBALL_API_KEY,
          baseUrl: env.FOOTBALL_API_BASE_URL,
          quota: footballQuotaPolicy(),
        })
      : createMockFootballProvider();

  return footballProvider;
}

export function getOddsProvider(): OddsProvider {
  if (oddsProvider) return oddsProvider;
  const env = serverEnv();

  oddsProvider =
    env.ODDS_PROVIDER === 'the-odds-api'
      ? createTheOddsApiProvider({
          apiKey: env.ODDS_API_KEY,
          baseUrl: env.ODDS_API_BASE_URL,
          quota: oddsQuotaPolicy(),
        })
      : createMockOddsProvider();

  return oddsProvider;
}

export function getHistoricalProvider(): HistoricalDataProvider {
  historicalProvider ??= createFootballDataCsvProvider();
  return historicalProvider;
}

/** Test seam: drop cached singletons so a suite can inject fakes. */
export function resetProviders(): void {
  footballProvider = null;
  oddsProvider = null;
  historicalProvider = null;
}

export * from './types';
export { API_FOOTBALL, THE_ODDS_API };
export { FOOTBALL_DATA_CSV } from './football-data-csv/historical-provider';
export type { HistoricalDataProvider };
