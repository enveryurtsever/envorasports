import { prisma } from '@/lib/db/prisma';
import { MARKET } from '@/lib/markets/registry';
import { getTeamForm } from '@/services/features/form';
import { getEloForTeams } from '@/services/features/elo';
import type { Viewer } from '@/lib/auth/session';

/**
 * Match analysis (§47, §48).
 *
 * Every number here is read back from what the engine actually stored. Nothing
 * is recomputed for display and nothing is invented: if a market was never
 * predicted, it is absent rather than filled in.
 */

export interface MarketProbability {
  selectionCode: string;
  probability: number;
  impliedProbability: number | null;
  odds: number | null;
  edge: number | null;
  expectedValue: number | null;
  confidence: number;
  risk: number;
  recommended: boolean;
}

export interface FactorBar {
  key: string;
  /** 0..1 */
  value: number;
  /** Where the number came from, so the bar is auditable. */
  source: string;
}

export interface MatchAnalysis {
  match: {
    id: string;
    kickoffUtc: Date;
    status: string;
    venue: string | null;
    referee: string | null;
    homeTeam: string;
    awayTeam: string;
    league: string;
    country: string | null;
    homeScore: number | null;
    awayScore: number | null;
    halfTimeHomeScore: number | null;
    halfTimeAwayScore: number | null;
  };
  hasPredictions: boolean;
  predictionTimestamp: Date | null;
  modelVersion: string | null;
  byMarket: Record<string, MarketProbability[]>;
  /** Best value selections, highest edge first. */
  valueSelections: MarketProbability[];
  factors: FactorBar[];
  modelAgreement: number | null;
  /** Per-model 1X2 views, straight from the stored breakdown. */
  perModel: Record<string, Record<string, number>>;
  features: Record<string, Record<string, number | string | null>>;
  form: {
    home: { results: string[]; goalsFor: number; goalsAgainst: number; sample: number };
    away: { results: string[]; goalsFor: number; goalsAgainst: number; sample: number };
  } | null;
  elo: { home: number; away: number } | null;
  headToHead: Array<{
    date: Date;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
  }>;
}

/** Markets worth showing on the analysis page, in display order. */
const DISPLAY_MARKETS = [
  MARKET.MATCH_RESULT,
  MARKET.DOUBLE_CHANCE,
  MARKET.OVER_UNDER,
  MARKET.BTTS,
  MARKET.HALF_TIME_RESULT,
  MARKET.HALF_TIME_FULL_TIME,
  MARKET.ASIAN_HANDICAP,
] as string[];

export async function getMatchAnalysis(
  matchId: string,
  viewer: Viewer,
): Promise<MatchAnalysis | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      status: true,
      venue: true,
      referee: true,
      homeScore: true,
      awayScore: true,
      halfTimeHomeScore: true,
      halfTimeAwayScore: true,
      homeTeamId: true,
      awayTeamId: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true, country: true } },
    },
  });

  if (!match) return null;

  // The newest generation of predictions for this match.
  const predictions = await prisma.prediction.findMany({
    where: { matchId },
    orderBy: { predictionTimestamp: 'desc' },
    select: {
      selectionId: true,
      probability: true,
      impliedProbability: true,
      oddsUsed: true,
      edge: true,
      expectedValue: true,
      confidenceScore: true,
      riskScore: true,
      dataQualityScore: true,
      recommended: true,
      predictionTimestamp: true,
      breakdown: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      modelVersion: { select: { name: true, version: true } },
    },
  });

  const latestTimestamp = predictions[0]?.predictionTimestamp ?? null;
  const current = predictions.filter(
    (p) => latestTimestamp && p.predictionTimestamp.getTime() === latestTimestamp.getTime(),
  );

  const byMarket: Record<string, MarketProbability[]> = {};
  for (const prediction of current) {
    const code = prediction.market.code;
    if (!DISPLAY_MARKETS.includes(code)) continue;

    const row: MarketProbability = {
      selectionCode: prediction.selection.code,
      probability: Number(prediction.probability),
      impliedProbability:
        prediction.impliedProbability === null ? null : Number(prediction.impliedProbability),
      odds: prediction.oddsUsed === null ? null : Number(prediction.oddsUsed),
      edge: prediction.edge === null ? null : Number(prediction.edge),
      expectedValue: prediction.expectedValue === null ? null : Number(prediction.expectedValue),
      confidence: Number(prediction.confidenceScore),
      risk: Number(prediction.riskScore),
      recommended: prediction.recommended,
    };

    byMarket[code] = [...(byMarket[code] ?? []), row];
  }

  for (const rows of Object.values(byMarket)) {
    rows.sort((a, b) => b.probability - a.probability);
  }

  // Value selections are gated: they are the actionable part of the analysis.
  const canSeeValue = viewer.isAdmin || viewer.entitlements.active;
  const valueSelections = canSeeValue
    ? current
        .filter((p) => p.recommended && p.edge !== null)
        .sort((a, b) => Number(b.edge) - Number(a.edge))
        .slice(0, 6)
        .map((p) => ({
          selectionCode: p.selection.code,
          probability: Number(p.probability),
          impliedProbability: p.impliedProbability === null ? null : Number(p.impliedProbability),
          odds: p.oddsUsed === null ? null : Number(p.oddsUsed),
          edge: p.edge === null ? null : Number(p.edge),
          expectedValue: p.expectedValue === null ? null : Number(p.expectedValue),
          confidence: Number(p.confidenceScore),
          risk: Number(p.riskScore),
          recommended: true,
        }))
    : [];

  const breakdown = (current[0]?.breakdown ?? null) as {
    models?: Record<string, Record<string, number | string | null>>;
    modelAgreement?: number;
    perModelResult?: Record<string, Record<string, number>>;
  } | null;

  const asOf = latestTimestamp ?? new Date();
  const [homeForm, awayForm, elo, h2h] = await Promise.all([
    getTeamForm(match.homeTeamId, asOf),
    getTeamForm(match.awayTeamId, asOf),
    getEloForTeams([match.homeTeamId, match.awayTeamId], asOf),
    prisma.match.findMany({
      where: {
        status: { in: ['FINISHED', 'AWARDED'] },
        scheduledKickoffUtc: { lt: asOf },
        OR: [
          { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId },
          { homeTeamId: match.awayTeamId, awayTeamId: match.homeTeamId },
        ],
      },
      orderBy: { scheduledKickoffUtc: 'desc' },
      take: 5,
      select: {
        scheduledKickoffUtc: true,
        homeScore: true,
        awayScore: true,
        homeTeam: { select: { name: true } },
        awayTeam: { select: { name: true } },
      },
    }),
  ]);

  const topConfidence = current.length > 0 ? Number(current[0]!.confidenceScore) : 0;
  const topQuality = current.length > 0 ? Number(current[0]!.dataQualityScore) : 0;

  // Bars only for factors the engine actually computed (§32 of the brief).
  const factors: FactorBar[] = [
    {
      key: 'modelAgreement',
      value: breakdown?.modelAgreement ?? 0,
      source: 'ensemble',
    },
    { key: 'confidence', value: topConfidence, source: 'prediction' },
    { key: 'dataQuality', value: topQuality, source: 'prediction' },
    {
      key: 'homeForm',
      value: Math.min(1, homeForm.windows.LAST_10.wins / Math.max(1, homeForm.windows.LAST_10.matchesPlayed)),
      source: 'form.last10',
    },
    {
      key: 'awayForm',
      value: Math.min(1, awayForm.windows.LAST_10.wins / Math.max(1, awayForm.windows.LAST_10.matchesPlayed)),
      source: 'form.last10',
    },
  ].filter((factor) => Number.isFinite(factor.value));

  return {
    match: {
      id: match.id,
      kickoffUtc: match.scheduledKickoffUtc,
      status: match.status,
      venue: match.venue,
      referee: match.referee,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      league: match.league.name,
      country: match.league.country,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      halfTimeHomeScore: match.halfTimeHomeScore,
      halfTimeAwayScore: match.halfTimeAwayScore,
    },
    hasPredictions: current.length > 0,
    predictionTimestamp: latestTimestamp,
    modelVersion: current[0]
      ? `${current[0].modelVersion.name}-${current[0].modelVersion.version}`
      : null,
    byMarket,
    valueSelections,
    factors,
    modelAgreement: breakdown?.modelAgreement ?? null,
    perModel: breakdown?.perModelResult ?? {},
    features: breakdown?.models ?? {},
    form:
      homeForm.windows.LAST_10.sampleSize > 0 || awayForm.windows.LAST_10.sampleSize > 0
        ? {
            home: {
              results: homeForm.windows.LAST_5.results,
              goalsFor: Number(homeForm.windows.LAST_10.averageGoalsFor.toFixed(2)),
              goalsAgainst: Number(homeForm.windows.LAST_10.averageGoalsAgainst.toFixed(2)),
              sample: homeForm.windows.LAST_10.sampleSize,
            },
            away: {
              results: awayForm.windows.LAST_5.results,
              goalsFor: Number(awayForm.windows.LAST_10.averageGoalsFor.toFixed(2)),
              goalsAgainst: Number(awayForm.windows.LAST_10.averageGoalsAgainst.toFixed(2)),
              sample: awayForm.windows.LAST_10.sampleSize,
            },
          }
        : null,
    elo: {
      home: Math.round(elo.get(match.homeTeamId)?.rating ?? 0),
      away: Math.round(elo.get(match.awayTeamId)?.rating ?? 0),
    },
    headToHead: h2h.map((m) => ({
      date: m.scheduledKickoffUtc,
      homeTeam: m.homeTeam.name,
      awayTeam: m.awayTeam.name,
      homeScore: m.homeScore as number,
      awayScore: m.awayScore as number,
    })),
  };
}
