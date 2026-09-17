import { z } from 'zod';

/**
 * Fail fast on a bad environment rather than at 03:00 inside a cron job.
 * Only NEXT_PUBLIC_* values may ever reach the browser (§50).
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),

  FOOTBALL_PROVIDER: z.enum(['api-football', 'mock']).default('mock'),
  FOOTBALL_API_KEY: z.string().default(''),
  FOOTBALL_API_BASE_URL: z.string().default(''),

  ODDS_PROVIDER: z.enum(['the-odds-api', 'mock']).default('mock'),
  ODDS_API_KEY: z.string().default(''),
  ODDS_API_BASE_URL: z.string().default(''),

  /**
   * Free-tier ceilings. These are small enough that they shape the whole
   * ingestion schedule, so they are first-class configuration, not a footnote.
   */
  FOOTBALL_API_DAILY_BUDGET: z.coerce.number().int().positive().default(100),
  ODDS_API_MONTHLY_BUDGET: z.coerce.number().int().positive().default(500),

  /**
   * Narration only rewrites an already-computed feature breakdown into prose.
   * It is never allowed to produce a probability, a price or a reason (§48).
   */
  NARRATION_PROVIDER: z.enum(['gemini', 'none']).default('none'),
  /**
   * 0 takes every bookmaker the provider returns — same request cost, six books
   * instead of one, and a consensus price to calibrate against. Set a specific
   * id to pin a single book.
   */
  FOOTBALL_ODDS_BOOKMAKER_ID: z.coerce.number().int().min(0).default(0),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  /**
   * Tried in order when the primary's free-tier daily quota is spent. The quota
   * is per model, so each name here adds its own daily allowance.
   */
  GEMINI_FALLBACK_MODELS: z
    .string()
    .default('gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-lite-latest'),
  /**
   * The model that researches a fixture's news with the search tool. Grounded
   * search is metered separately from generation (5,000 a month free on the
   * paid tier, then $14 a thousand), so the cheapest model that searches well
   * is the right one; the reading is structured, not written.
   */
  INSIGHT_MODEL: z.string().default('gemini-3.5-flash-lite'),
  /** 'none' switches the layer off: predictions run on the archive alone. */
  INSIGHT_PROVIDER: z.enum(['gemini', 'none']).default('none'),

  BILLING_PROVIDER: z.enum(['stripe', 'none']).default('none'),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  AUTH_SECRET: z.string().default(''),
  JOB_TRIGGER_SECRET: z.string().default(''),
});

const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:6247'),
  NEXT_PUBLIC_DEFAULT_LOCALE: z.enum(['tr', 'en']).default('tr'),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().default(''),
});

function parseServerEnv() {
  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }

  const env = parsed.data;

  // A real provider without a key is a misconfiguration, not a fallback.
  if (env.FOOTBALL_PROVIDER === 'api-football' && !env.FOOTBALL_API_KEY) {
    throw new Error('FOOTBALL_PROVIDER=api-football requires FOOTBALL_API_KEY');
  }
  if (env.ODDS_PROVIDER === 'the-odds-api' && !env.ODDS_API_KEY) {
    throw new Error('ODDS_PROVIDER=the-odds-api requires ODDS_API_KEY');
  }
  if (env.NARRATION_PROVIDER === 'gemini' && !env.GEMINI_API_KEY) {
    throw new Error('NARRATION_PROVIDER=gemini requires GEMINI_API_KEY');
  }
  if (env.BILLING_PROVIDER === 'stripe' && env.NODE_ENV === 'production' && !env.STRIPE_SECRET_KEY) {
    throw new Error('BILLING_PROVIDER=stripe requires STRIPE_SECRET_KEY in production');
  }

  return env;
}

let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

/** Server-only. Throws if imported into a client component bundle. */
export function serverEnv() {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() must never be called in the browser');
  }
  cachedServerEnv ??= parseServerEnv();
  return cachedServerEnv;
}

export const clientEnv = clientSchema.parse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NEXT_PUBLIC_DEFAULT_LOCALE: process.env.NEXT_PUBLIC_DEFAULT_LOCALE,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
});

export type ServerEnv = ReturnType<typeof serverEnv>;
