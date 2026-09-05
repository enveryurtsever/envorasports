import { prisma } from '@/lib/db/prisma';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('narration:budget');

/**
 * Free-tier budget management.
 *
 * Gemini's free tier caps requests per day *per model* — 20/day for
 * gemini-3.6-flash. The cap is not shared between models, so a chain of models
 * gets a daily budget that is the sum of theirs, and one exhausted model costs
 * an analysis nothing but a hop to the next.
 *
 * Two rules make that work:
 *   - a 429 is never retried against the same model (a daily quota does not
 *     clear in the seconds a backoff waits, so the retry is pure waste);
 *   - an exhausted model is remembered for the rest of the day, so a fresh
 *     process does not spend a request rediscovering it.
 */

const EXHAUSTED_KEY = 'narration.exhaustedModels';

/** UTC day. Google's quotas reset on Pacific midnight, but any stable day-key
 *  works here: the worst case is retrying a model a few hours late. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function readExhausted(): Promise<Record<string, string>> {
  const row = await prisma.appSetting.findUnique({ where: { key: EXHAUSTED_KEY } });
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** The models to try, in order, minus any already exhausted today. */
export async function availableModels(): Promise<string[]> {
  const env = serverEnv();
  const chain = [
    env.GEMINI_MODEL,
    ...env.GEMINI_FALLBACK_MODELS.split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  ];

  // De-duplicate while keeping order: the primary may also appear in the chain.
  const ordered = [...new Set(chain)];

  const exhausted = await readExhausted();
  const day = today();
  const usable = ordered.filter((model) => exhausted[model] !== day);

  // Everything is spent: return the chain anyway so the caller learns the real
  // reason from a live 429 rather than silently producing templates forever on
  // a stale marker.
  return usable.length > 0 ? usable : ordered;
}

export async function markExhausted(model: string): Promise<void> {
  const exhausted = await readExhausted();
  exhausted[model] = today();

  const value = JSON.stringify(exhausted);
  await prisma.appSetting
    .upsert({
      where: { key: EXHAUSTED_KEY },
      update: { value },
      create: {
        key: EXHAUSTED_KEY,
        value,
        valueType: 'JSON',
        category: 'narration',
        description: 'Models whose free-tier daily quota is spent, by date',
      },
    })
    .catch(() => undefined);

  log.warn('model daily quota exhausted', { model });
}

/** True when the error is a rate-limit rejection rather than a real failure. */
export function isQuotaError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('responded 429');
}
