import { createHash } from 'node:crypto';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';
import { prisma } from '@/lib/db/prisma';
import { availableModels, isQuotaError, markExhausted } from './model-budget';
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

export interface NarrateOptions {
  /**
   * Whether this call may reach the model.
   *
   * Page renders pass false and are served from the cache alone. Generating on
   * render made /predictions take ~6 seconds: every coupon called out, hit the
   * free tier's rate limit, retried with backoff and fell back to the template
   * anyway. Only the background job generates.
   */
  allowGeneration?: boolean;
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

async function callGemini(
  request: NarrationRequest,
  model: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const env = serverEnv();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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
    // The body carries the reason — which quota, and how long to wait. Without
    // it a 429 is indistinguishable from a daily exhaustion.
    const detail = await response.text().catch(() => '');
    throw new Error(`Gemini responded ${response.status}: ${detail.slice(0, 300)}`);
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

  const str = (key: string): string | null =>
    typeof payload[key] === 'string' ? (payload[key] as string) : null;

  interface PayloadSelection {
    match?: string;
    league?: string;
    pick?: string;
    odds?: string;
    modelProbability?: string;
    marketProbability?: string;
    edge?: string;
  }
  const selections = Array.isArray(payload.selections)
    ? (payload.selections as PayloadSelection[])
    : [];

  const system = payload.system as { label?: string; legs?: number; columns?: number } | null;

  // Written from this coupon's own figures. A generic paragraph is worse than
  // no paragraph — it tells the reader nothing about what they are looking at.
  const summaryParts: string[] = [];

  if (selections.length > 0) {
    const legs = selections
      .slice(0, 3)
      .map((s) => `${s.match ?? ''}${s.pick ? ` (${s.pick})` : ''}`)
      .filter(Boolean)
      .join(tr ? '; ' : '; ');

    const more = selections.length > 3 ? selections.length - 3 : 0;

    summaryParts.push(
      tr
        ? `Bu kupon ${selections.length} seçimden oluşuyor: ${legs}${more > 0 ? ` ve ${more} seçim daha` : ''}.`
        : `This coupon has ${selections.length} selections: ${legs}${more > 0 ? ` and ${more} more` : ''}.`,
    );
  }

  const odds = str('totalOdds');
  const modelProbability = str('modelProbability');
  if (odds) {
    summaryParts.push(
      tr
        ? `Toplam oran ${odds}${modelProbability ? `, modelin tutma olasılığı ${modelProbability}` : ''}.`
        : `Total odds ${odds}${modelProbability ? `, with a model probability of ${modelProbability}` : ''}.`,
    );
  }

  if (system?.label) {
    summaryParts.push(
      tr
        ? `Sistem ${system.label} oynanıyor, yani seçimlerin tamamının tutması gerekmiyor.`
        : `Played as system ${system.label}, so not every selection has to land.`,
    );
  }

  summaryParts.push(
    tr
      ? 'Tahminler istatistikseldir ve sonuç garantisi vermez.'
      : 'Predictions are statistical estimates and are not guarantees of outcome.',
  );

  // One factor per selection, built from its own edge — the actual reason it
  // is on the coupon.
  const keyFactors: Narration['keyFactors'] = selections.slice(0, 4).map((selection) => {
    const edge = selection.edge ?? '';
    const negative = edge.trim().startsWith('-');

    return {
      factor: `${selection.match ?? ''}${selection.pick ? ` · ${selection.pick}` : ''}`.slice(0, 60) ||
        (tr ? 'Seçim' : 'Selection'),
      impact: negative ? 'NEGATIVE' : 'POSITIVE',
      confidence: 0.6,
      explanation: tr
        ? `Oran ${selection.odds ?? '—'}; model ${selection.modelProbability ?? '—'} verirken piyasa ${selection.marketProbability ?? '—'} ima ediyor, aradaki fark ${edge || '—'}.`
        : `Priced at ${selection.odds ?? '—'}; the model says ${selection.modelProbability ?? '—'} against a market-implied ${selection.marketProbability ?? '—'}, a gap of ${edge || '—'}.`,
    };
  });

  const risks: string[] = [];
  if (system?.columns) {
    risks.push(
      tr
        ? `${system.columns} kolonun tamamı tutmadıkça maksimum kazanç elde edilmez.`
        : `The maximum return needs all ${system.columns} columns to land.`,
    );
  } else if (selections.length > 1) {
    risks.push(
      tr
        ? `Kuponun kazanması için ${selections.length} seçimin hepsinin tutması gerekir.`
        : `Every one of the ${selections.length} selections has to land for the coupon to win.`,
    );
  }

  const risk = str('risk');
  if (risk) {
    risks.push(tr ? `Modelin risk skoru ${risk}.` : `The model's risk score is ${risk}.`);
  }

  const limitations: string[] = [];
  if (payload.hasXg === false) {
    limitations.push(
      tr
        ? 'Bu maçlar için beklenen gol (xG) verisi yok; xG modeli katkı vermedi.'
        : 'No expected-goals data for these matches, so the xG model did not contribute.',
    );
  }
  limitations.push(
    tr
      ? 'Sakatlık, kadro ve hakem bilgileri bu analize dâhil değildir.'
      : 'Injury, line-up and referee information is not part of this analysis.',
  );

  return {
    summary: summaryParts.join(' '),
    keyFactors,
    risks: risks.length > 0 ? risks : [
      tr
        ? 'Model çıktısı belirsizlik içerir; tek sonuç modelin doğruluğunu ölçmez.'
        : 'Model output carries uncertainty; one result does not measure whether it was right.',
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
export async function narrate(
  input: NarrationRequest,
  options: NarrateOptions = {},
): Promise<NarrationResult> {
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

  // Cache miss on a render path: answer immediately with the template rather
  // than making the reader wait on a network call.
  if (!options.allowGeneration) {
    return { narration: templateNarration(request), source: 'template', reason: 'cache_miss' };
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

  // Models to try in order. A 429 moves to the next one instead of retrying:
  // the free tier's cap is per day and per model, so waiting cannot clear it
  // but a different model has its own budget.
  const models = await availableModels();
  let modelIndex = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const model = models[modelIndex];
    if (!model) break;

    // 503 from Gemini means "busy", not "wrong". Back off before retrying.
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt - 1)));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);

    try {
      let raw: unknown;
      try {
        raw = await callGemini(request, model, controller.signal);
      } catch (error) {
        lastReason = `request_failed: ${String(error)}`;

        if (isQuotaError(error)) {
          await markExhausted(model);
          modelIndex++;
          // Not a failed attempt — nothing was generated, so it must not eat
          // the retry budget the next model is entitled to.
          attempt--;
          if (modelIndex >= models.length) break;
        }
        continue;
      }

      const parsed = narrationSchema.safeParse(raw);
      if (!parsed.success) {
        // Name the offending field: "too long" and "wrong shape" need different
        // fixes, and without this the log says only that something was wrong.
        const issues = parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
          .join('; ');
        lastReason = `schema_validation_failed: ${issues}`;
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
