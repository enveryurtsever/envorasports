import { createHash } from 'node:crypto';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import {
  NARRATION_RESPONSE_SCHEMA,
  findBannedLanguage,
  findUngroundedNumbers,
  narrationSchema,
  type Narration,
} from './schema';

const log = createLogger('narration');

/**
 * Narration (§19-21 of the intelligence brief).
 *
 * What this layer may do: turn a structured, already-computed payload into
 * readable EN/TR prose.
 *
 * What it may not do: produce a probability, a price, an edge, an EV, an
 * injury, a lineup, or any figure the payload did not contain. That is not left
 * to the prompt — the output is checked against the input, and a narration that
 * prints an ungrounded number is thrown away.
 *
 * With NARRATION_PROVIDER=none, or on any failure, the deterministic template
 * below is used instead. Nothing downstream depends on the model being
 * available.
 */

export type NarrationLocale = 'en' | 'tr';

export interface NarrationRequest {
  entityType: 'match' | 'coupon' | 'post_match';
  entityId: string;
  locale: NarrationLocale;
  /** Structured facts. This is the ONLY thing the model is given. */
  payload: Record<string, unknown>;
}

export interface NarrationResult {
  narration: Narration;
  source: 'model' | 'template';
  reason?: string;
}

const SYSTEM_RULES = `You are the analysis writer for EnvoraSports, a football prediction platform.

ABSOLUTE RULES
1. Use ONLY the structured data supplied in the user message. It is the complete
   set of facts available to you.
2. Never invent or estimate a player injury, lineup, statistic, odd, probability,
   edge, expected value, historical fact or match event.
3. Never print a number that does not appear in the supplied data.
4. If something is not in the data, say so in dataLimitations. Write
   "Insufficient data" rather than guessing.
5. Never promise or imply a guaranteed outcome. No "guaranteed", "sure bet",
   "certain win", "100%". These are model estimates, not predictions of fact.
6. Do not add hindsight: for a match that has finished, explain what the model
   saw beforehand, not what became obvious afterwards.
7. Write in the requested language, in plain, professional prose.`;

function promptFor(request: NarrationRequest): string {
  const language = request.locale === 'tr' ? 'Turkish' : 'English';

  const task =
    request.entityType === 'post_match'
      ? 'Review this finished prediction. Explain which of the model\'s assumptions held and which did not, without using information that only became available after kickoff.'
      : request.entityType === 'coupon'
        ? 'Explain why these selections were grouped together and where the risk in the combination lies.'
        : 'Explain what the model sees in this match and what would undermine it.';

  return `${task}

Write in ${language}.

STRUCTURED DATA (the only facts you have):
${JSON.stringify(request.payload, null, 2)}`;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
}

async function callGemini(request: NarrationRequest, signal?: AbortSignal): Promise<unknown> {
  const env = serverEnv();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
      contents: [{ role: 'user', parts: [{ text: promptFor(request) }] }],
      generationConfig: {
        // Low temperature: this is a rewriting task, not a creative one.
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: NARRATION_RESPONSE_SCHEMA,
        maxOutputTokens: 2400,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini responded ${response.status}`);
  }

  const body = (await response.json()) as GeminiResponse;
  if (body.error) throw new Error(body.error.message ?? 'Gemini error');

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no content');

  return JSON.parse(text);
}

/**
 * Deterministic fallback.
 *
 * Built from the same payload with plain templates, so the product reads
 * sensibly with the model switched off entirely.
 */
export function templateNarration(request: NarrationRequest): Narration {
  const tr = request.locale === 'tr';
  const payload = request.payload as Record<string, unknown>;

  const factors: Narration['keyFactors'] = [];
  const agreement = typeof payload.modelAgreement === 'number' ? payload.modelAgreement : null;

  if (agreement !== null) {
    factors.push({
      factor: tr ? 'Model uyumu' : 'Model agreement',
      impact: agreement >= 0.7 ? 'POSITIVE' : agreement >= 0.45 ? 'NEUTRAL' : 'NEGATIVE',
      confidence: agreement,
      explanation: tr
        ? 'Modellerin birbirine ne kadar yakın sonuç ürettiğini gösterir.'
        : 'How closely the contributing models arrived at the same view.',
    });
  }

  const quality = typeof payload.dataQuality === 'number' ? payload.dataQuality : null;
  if (quality !== null) {
    factors.push({
      factor: tr ? 'Veri kalitesi' : 'Data quality',
      impact: quality >= 0.7 ? 'POSITIVE' : quality >= 0.5 ? 'NEUTRAL' : 'NEGATIVE',
      confidence: quality,
      explanation: tr
        ? 'Modelin ihtiyaç duyduğu verinin ne kadarının mevcut olduğunu ölçer.'
        : 'How much of the data the model wanted was actually available.',
    });
  }

  const limitations: string[] = [];
  if (payload.hasXg === false) {
    limitations.push(
      tr
        ? 'Bu maç için beklenen gol (xG) verisi yok; xG modeli devre dışı.'
        : 'No expected-goals data for this match, so the xG model did not contribute.',
    );
  }
  if (quality !== null && quality < 0.6) {
    limitations.push(
      tr ? 'Veri kalitesi düşük; tahminin ağırlığı sınırlandırıldı.' : 'Data quality is low, so the estimate carries less weight.',
    );
  }

  return {
    summary: tr
      ? 'Bu analiz, modelin hesapladığı olasılık ve piyasa fiyatı karşılaştırmasına dayanır. Tahminler istatistiksel öngörüdür, sonuç garantisi değildir.'
      : 'This analysis rests on the model’s computed probability compared with the market price. Predictions are statistical estimates, not guarantees of outcome.',
    keyFactors: factors,
    risks: [
      tr
        ? 'Model çıktısı belirsizlik içerir; tek maç sonucu modelin doğruluğunu ölçmez.'
        : 'Model output carries uncertainty; a single result does not measure whether the model was right.',
    ],
    dataLimitations: limitations,
  };
}

/**
 * Rounds a payload to display precision before it is sent.
 *
 * Two reasons. Readability: given 0.54406434 the model dutifully prints
 * 0.54406434, which is not prose. And consistency: the grounding check runs
 * against the *same* rounded payload, so "54%" is recognised as quoting the
 * data rather than inventing it.
 */
export function roundPayload(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value)) return value;
    // Probabilities and ratios read best as whole percentages; prices to 2dp.
    return Math.abs(value) < 1 ? Number(value.toFixed(4)) : Number(value.toFixed(2));
  }
  if (Array.isArray(value)) return value.map(roundPayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, roundPayload(item)]),
    );
  }
  return value;
}

function checksumOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

/**
 * Produces a narration, cached against a checksum of its inputs so identical
 * facts are never paid for twice.
 */
export async function narrate(input: NarrationRequest): Promise<NarrationResult> {
  // Everything downstream — prompt, grounding check, cache key — uses the
  // rounded payload, so they can never disagree about what a figure is.
  const request: NarrationRequest = {
    ...input,
    payload: roundPayload(input.payload) as Record<string, unknown>,
  };

  const checksum = checksumOf({ ...request.payload, locale: request.locale });
  const cacheKey = `narration:${request.entityType}:${request.entityId}:${request.locale}`;

  const cached = await prisma.appSetting.findUnique({ where: { key: cacheKey } });
  if (cached) {
    try {
      const parsed = JSON.parse(cached.value) as { checksum: string; narration: Narration };
      if (parsed.checksum === checksum) {
        const validated = narrationSchema.safeParse(parsed.narration);
        if (validated.success) return { narration: validated.data, source: 'model' };
      }
    } catch {
      // A corrupt cache entry is simply ignored and rewritten below.
    }
  }

  const env = serverEnv();
  if (env.NARRATION_PROVIDER !== 'gemini') {
    return { narration: templateNarration(request), source: 'template', reason: 'provider_disabled' };
  }

  // One retry: a malformed response or a 503 is usually transient. Each attempt
  // gets its own deadline — sharing one meant a slow first try left the second
  // with no time at all.
  let lastReason = 'unknown';
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // 503 from Gemini means "busy", not "wrong". Back off before retrying.
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt - 1)));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    try {
      let raw: unknown;
      try {
        raw = await callGemini(request, controller.signal);
      } catch (error) {
        lastReason = `request_failed: ${String(error)}`;
        continue;
      }

      const parsed = narrationSchema.safeParse(raw);
      if (!parsed.success) {
        lastReason = 'schema_validation_failed';
        continue;
      }

      const banned = findBannedLanguage(parsed.data);
      if (banned.length > 0) {
        lastReason = `banned_language: ${banned.join(', ')}`;
        continue;
      }

      const ungrounded = findUngroundedNumbers(parsed.data, request.payload);
      if (ungrounded.length > 0) {
        // The decisive check: a figure that is not in the payload is invented.
        lastReason = `ungrounded_numbers: ${ungrounded.map((v) => v.value).join(', ')}`;
        log.warn('narration rejected for ungrounded numbers', {
          entity: request.entityId,
          values: ungrounded,
        });
        continue;
      }

      await prisma.appSetting
        .upsert({
          where: { key: cacheKey },
          update: { value: JSON.stringify({ checksum, narration: parsed.data }) },
          create: {
            key: cacheKey,
            value: JSON.stringify({ checksum, narration: parsed.data }),
            valueType: 'JSON',
            category: 'narration',
            description: `Cached narration for ${request.entityType} ${request.entityId}`,
          },
        })
        .catch(() => undefined);

      return { narration: parsed.data, source: 'model' };
    } finally {
      clearTimeout(timer);
    }
  }

  log.warn('falling back to template narration', { reason: lastReason });
  return { narration: templateNarration(request), source: 'template', reason: lastReason };
}
