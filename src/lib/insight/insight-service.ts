import { z } from 'zod';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('insight');

/**
 * The reading of a fixture that the archive cannot give.
 *
 * Every model in the ensemble is arithmetic over past scorelines, blended
 * toward a market that is arithmetic over the same scorelines. Neither knows
 * that the striker is suspended, that the away side has lost three in a row
 * under a new manager, or that the home side rests its first eleven before a
 * derby. The bookmaker's price absorbs that news over the day; this reads it
 * in the morning.
 *
 * Two calls, deliberately. With a JSON schema and the search tool in one
 * request the model skipped the search and filled the schema from memory — a
 * player was listed as both a summer signing and an absentee. So the first
 * call searches and writes prose with its sources, and the second turns that
 * prose, and nothing else, into the structure. A reading with no sources is
 * discarded: an ungrounded model asserting a fixture's news is fiction.
 */

export interface FixtureDossier {
  homeTeam: string;
  awayTeam: string;
  league: string;
  kickoffUtc: Date;
  venueCountry?: string | null;
  /** The model's own view, so the reading can say where it disagrees. */
  modelView?: {
    homeWin: number;
    draw: number;
    awayWin: number;
    expectedGoals: number;
  };
}

const absentee = z.object({
  name: z.string(),
  reason: z.string(),
  importance: z.enum(['key', 'regular', 'fringe']),
});

const side = z.object({
  absentees: z.array(absentee),
  returning: z.array(z.string()),
  notes: z.array(z.string()),
});

export const insightPayloadSchema = z.object({
  home: side,
  away: side,
  context: z.object({
    homeMotivation: z.enum(['high', 'normal', 'low']),
    awayMotivation: z.enum(['high', 'normal', 'low']),
    homeRotationRisk: z.enum(['low', 'medium', 'high']),
    awayRotationRisk: z.enum(['low', 'medium', 'high']),
    congestion: z.string().nullable(),
    conditions: z.string().nullable(),
  }),
  tempo: z.enum(['very_low', 'low', 'normal', 'high', 'very_high']),
  lean: z.object({ side: z.enum(['home', 'neutral', 'away']), strength: z.number().min(0).max(1) }),
  goalAdjustment: z.object({ home: z.number().min(-0.4).max(0.4), away: z.number().min(-0.4).max(0.4) }),
  confidence: z.number().min(0).max(1),
  summaryTr: z.string(),
  summaryEn: z.string(),
});

export type InsightPayload = z.infer<typeof insightPayloadSchema>;

export interface ResearchResult {
  model: string;
  research: string;
  sources: Array<{ title: string; uri: string }>;
  queries: string[];
}

/** Hard ceilings on what a reading may do to the model, whatever it says. */
export const MAX_GOAL_ADJUSTMENT = 0.25;
export const MAX_RESULT_LEAN = 1;

const RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    home: {
      type: 'object',
      properties: {
        absentees: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' }, importance: { type: 'string', enum: ['key', 'regular', 'fringe'] } }, required: ['name', 'reason', 'importance'] } },
        returning: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['absentees', 'returning', 'notes'],
    },
    away: {
      type: 'object',
      properties: {
        absentees: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, reason: { type: 'string' }, importance: { type: 'string', enum: ['key', 'regular', 'fringe'] } }, required: ['name', 'reason', 'importance'] } },
        returning: { type: 'array', items: { type: 'string' } },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['absentees', 'returning', 'notes'],
    },
    context: {
      type: 'object',
      properties: {
        homeMotivation: { type: 'string', enum: ['high', 'normal', 'low'] },
        awayMotivation: { type: 'string', enum: ['high', 'normal', 'low'] },
        homeRotationRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
        awayRotationRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
        congestion: { type: 'string', nullable: true },
        conditions: { type: 'string', nullable: true },
      },
      required: ['homeMotivation', 'awayMotivation', 'homeRotationRisk', 'awayRotationRisk'],
    },
    tempo: { type: 'string', enum: ['very_low', 'low', 'normal', 'high', 'very_high'] },
    lean: { type: 'object', properties: { side: { type: 'string', enum: ['home', 'neutral', 'away'] }, strength: { type: 'number' } }, required: ['side', 'strength'] },
    goalAdjustment: { type: 'object', properties: { home: { type: 'number' }, away: { type: 'number' } }, required: ['home', 'away'] },
    confidence: { type: 'number' },
    summaryTr: { type: 'string' },
    summaryEn: { type: 'string' },
  },
  required: ['home', 'away', 'context', 'tempo', 'lean', 'goalAdjustment', 'confidence', 'summaryTr', 'summaryEn'],
} as const;

function fixtureLine(d: FixtureDossier): string {
  const date = d.kickoffUtc.toISOString().slice(0, 10);
  return `${d.homeTeam} vs ${d.awayTeam}, ${d.league}, ${date} (kick-off ${d.kickoffUtc.toISOString().slice(11, 16)} UTC)`;
}

function researchPrompt(d: FixtureDossier): string {
  return `${fixtureLine(d)}.

Search the web for the latest news on this specific fixture and write a factual pre-match briefing. Cover, for each side:
- injuries, suspensions and doubts, with the player's role (key starter / regular / fringe) and the reason;
- players returning from injury or suspension;
- expected rotation or rested players (cup ties, a bigger match within days, European travel);
- recent form and mood: results in the last few matches, manager changes, pressure;
- motivation: what the match means for each side (title, relegation, qualification, dead rubber);
- schedule congestion, travel, weather or pitch if reported;
- the managers' stated approach if quoted.

Rules: report only what the sources say, and name the source domain after each claim in brackets. If the sources do not cover a point, write "not reported". Do not guess. Do not give a prediction or a score. Keep it under 350 words.`;
}

function structurePrompt(d: FixtureDossier, research: string): string {
  const view = d.modelView
    ? `The statistical model currently has: home win ${(d.modelView.homeWin * 100).toFixed(0)}%, draw ${(d.modelView.draw * 100).toFixed(0)}%, away win ${(d.modelView.awayWin * 100).toFixed(0)}%, expected goals ${d.modelView.expectedGoals.toFixed(2)}. That model already knows results, form and head-to-head. Adjust ONLY for what the briefing adds that results cannot show.`
    : 'The statistical model already knows results, form and head-to-head. Adjust ONLY for what the briefing adds that results cannot show.';

  return `${fixtureLine(d)}.

BRIEFING (the only facts you have):
"""
${research}
"""

${view}

Turn the briefing into the JSON structure. Rules:
- absentees/returning/notes: only players and facts named in the briefing. Empty arrays are correct when the briefing reports nothing.
- goalAdjustment.home / .away: a signed fraction of that side's expected goals. A key striker missing: about -0.15. A key defender missing on the OTHER side: about +0.10 to the opponent. Heavy rotation: -0.10 to -0.20. Nothing notable: 0. Never beyond ±0.30.
- lean: which side the news favours beyond what results show, and how strongly (0 = nothing, 1 = decisive, e.g. half the first eleven missing).
- tempo: how open the match is expected to be from the briefing (managers' approach, both sides' needs); "normal" when unclear.
- confidence: how well-sourced and specific the briefing is. Vague or "not reported" everywhere: 0.2 or lower. Named absentees with roles from several sources: 0.7 or higher.
- summaryTr: 2-3 sentences in Turkish for a reader, stating the facts and what they change. No prediction, no score, no odds.
- summaryEn: the same in English.`;
}

interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  groundingMetadata?: {
    webSearchQueries?: string[];
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message?: string; status?: string };
}

async function callGemini(model: string, body: Record<string, unknown>): Promise<GeminiCandidate> {
  const env = serverEnv();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini responded ${response.status}: ${detail.slice(0, 300)}`);
  }
  const parsed = (await response.json()) as GeminiResponse;
  if (parsed.error) throw new Error(parsed.error.message ?? 'Gemini error');
  const candidate = parsed.candidates?.[0];
  if (!candidate) throw new Error('Gemini returned no candidate');
  return candidate;
}

function textOf(candidate: GeminiCandidate): string {
  return (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
}

export function insightModel(): string {
  return serverEnv().INSIGHT_MODEL;
}

/** Step one: search, and write what the sources say. */
export async function researchFixture(dossier: FixtureDossier): Promise<ResearchResult | null> {
  const model = insightModel();
  const candidate = await callGemini(model, {
    contents: [{ role: 'user', parts: [{ text: researchPrompt(dossier) }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 },
  });

  const research = textOf(candidate);
  const chunks = candidate.groundingMetadata?.groundingChunks ?? [];
  const sources = chunks
    .map((c) => ({ title: c.web?.title ?? '', uri: c.web?.uri ?? '' }))
    .filter((s) => s.uri.length > 0);
  const queries = candidate.groundingMetadata?.webSearchQueries ?? [];

  // No sources means no search happened, whatever the prose claims.
  if (sources.length === 0 || research.length < 80) {
    log.warn('research not grounded, discarded', {
      fixture: fixtureLine(dossier),
      sources: sources.length,
      length: research.length,
    });
    return null;
  }

  return { model, research, sources, queries };
}

/** Step two: structure the briefing, without the search tool. */
export async function structureInsight(
  dossier: FixtureDossier,
  research: string,
): Promise<InsightPayload> {
  const candidate = await callGemini(insightModel(), {
    contents: [{ role: 'user', parts: [{ text: structurePrompt(dossier, research) }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: RESEARCH_SCHEMA,
      maxOutputTokens: 1600,
    },
  });
  const raw = JSON.parse(textOf(candidate)) as unknown;
  return insightPayloadSchema.parse(raw);
}

/**
 * What the model is allowed to do with the reading.
 *
 * Adjustments are scaled by the reading's own confidence and capped: a
 * confident reading of a missing striker moves that side's goals by a sixth;
 * a vague briefing moves nothing. The lean is the same signed fraction for
 * the result, applied downstream as a bounded rating shift.
 */
export function boundedAdjustments(payload: InsightPayload): {
  homeGoalAdjustment: number;
  awayGoalAdjustment: number;
  resultLean: number;
  confidence: number;
} {
  const confidence = Math.max(0, Math.min(1, payload.confidence));
  const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));
  const direction = payload.lean.side === 'home' ? 1 : payload.lean.side === 'away' ? -1 : 0;
  return {
    homeGoalAdjustment: clamp(payload.goalAdjustment.home * confidence, MAX_GOAL_ADJUSTMENT),
    awayGoalAdjustment: clamp(payload.goalAdjustment.away * confidence, MAX_GOAL_ADJUSTMENT),
    resultLean: clamp(direction * payload.lean.strength * confidence, MAX_RESULT_LEAN),
    confidence,
  };
}
