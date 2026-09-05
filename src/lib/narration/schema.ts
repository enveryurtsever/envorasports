import { z } from 'zod';

/**
 * Structured narration contract (§20, §21 of the intelligence brief).
 *
 * The model is never asked for a free-form paragraph. It fills a schema, the
 * schema is validated, and anything that fails validation is discarded in
 * favour of the deterministic template — so a bad response degrades to plain
 * language rather than to fiction.
 */

export const narrationSchema = z.object({
  /** One or two sentences. No numbers the payload did not contain. */
  summary: z.string().min(20).max(700),
  keyFactors: z
    .array(
      z.object({
        factor: z.string().min(2).max(60),
        impact: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']),
        /**
         * A 0-1 fraction. Models reliably answer "75" here instead, and
         * throwing away an otherwise sound narration over the unit is a poor
         * trade — anything above 1 is a percentage, so read it as one.
         */
        confidence: z.preprocess(
          (value) => (typeof value === 'number' && value > 1 && value <= 100 ? value / 100 : value),
          z.number().min(0).max(1),
        ),
        explanation: z.string().min(10).max(400),
      }),
    )
    .max(6),
  risks: z.array(z.string().min(5).max(300)).max(5),
  /** What the model was NOT given — the honest counterpart to keyFactors. */
  dataLimitations: z.array(z.string().min(5).max(300)).max(5),
});

export type Narration = z.infer<typeof narrationSchema>;

/** JSON schema handed to Gemini so it returns the right shape first time. */
export const NARRATION_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    keyFactors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          factor: { type: 'STRING' },
          impact: { type: 'STRING', enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'] },
          confidence: {
            type: 'NUMBER',
            description: 'Fraction between 0 and 1, e.g. 0.75. Not a percentage.',
          },
          explanation: { type: 'STRING' },
        },
        required: ['factor', 'impact', 'confidence', 'explanation'],
      },
    },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    dataLimitations: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'keyFactors', 'risks', 'dataLimitations'],
} as const;

/**
 * Every number the payload legitimately contains, as strings the narration
 * could reasonably print (raw, 1dp, 2dp, and the percentage forms).
 */
export function allowedNumbers(payload: unknown): Set<string> {
  const allowed = new Set<string>();

  const add = (value: number) => {
    if (!Number.isFinite(value)) return;
    for (const form of [
      String(value),
      value.toFixed(0),
      value.toFixed(1),
      value.toFixed(2),
      (value * 100).toFixed(0),
      (value * 100).toFixed(1),
      (value * 100).toFixed(2),
    ]) {
      allowed.add(form.replace(/^-/, ''));
      // Turkish decimal comma.
      allowed.add(form.replace(/^-/, '').replace('.', ','));
    }
  };

  const walk = (node: unknown): void => {
    if (typeof node === 'number') return add(node);
    if (typeof node === 'string') {
      const parsed = Number(node);
      if (Number.isFinite(parsed)) add(parsed);
      // Dates and codes may contain digits that are legitimately quotable.
      for (const match of node.matchAll(/\d+(?:[.,]\d+)?/g)) allowed.add(match[0]);
      // Selection codes encode lines with an underscore: OVER_2_5 is the 2.5
      // line, and a narration that writes "Over 2.5" is quoting the payload,
      // not inventing a figure.
      for (const match of node.matchAll(/(\d+)_(\d+)/g)) {
        allowed.add(`${match[1]}.${match[2]}`);
        allowed.add(`${match[1]},${match[2]}`);
      }
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
  };

  walk(payload);
  return allowed;
}

/** Small integers read as ordinary prose ("two key players"), not as data. */
const PROSE_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

export interface GroundingViolation {
  value: string;
  where: string;
}

/**
 * Rejects a narration that prints a figure the payload never contained.
 *
 * A prompt instruction alone is not a guarantee (§21). This checks the output
 * against the input, so an invented probability, price or scoreline is caught
 * mechanically rather than trusted away.
 */
export function findUngroundedNumbers(
  narration: Narration,
  payload: unknown,
): GroundingViolation[] {
  const allowed = allowedNumbers(payload);
  const violations: GroundingViolation[] = [];

  const check = (text: string, where: string) => {
    for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
      const value = match[0];
      if (allowed.has(value) || PROSE_NUMBERS.has(value)) continue;
      violations.push({ value, where });
    }
  };

  check(narration.summary, 'summary');
  narration.keyFactors.forEach((factor, i) => {
    check(factor.factor, `keyFactors[${i}].factor`);
    check(factor.explanation, `keyFactors[${i}].explanation`);
  });
  narration.risks.forEach((risk, i) => check(risk, `risks[${i}]`));
  narration.dataLimitations.forEach((limit, i) => check(limit, `dataLimitations[${i}]`));

  return violations;
}

/**
 * Language that promises an outcome is never acceptable (§2, §58).
 *
 * The check has to understand negation. "Predictions are not guarantees of
 * outcome" is the disclaimer the product is *required* to carry (§29); a naive
 * substring match would ban the very sentence the specification mandates.
 */
const BANNED_PHRASES = [
  'guaranteed',
  'guarantee',
  'sure bet',
  'certain win',
  'cannot lose',
  'garanti',
  'kesin kazan',
  'kesinlikle kazan',
];

/** Words that turn a banned phrase into a responsible disclaimer. */
const NEGATIONS = [
  'not',
  'never',
  'no',
  'nor',
  'without',
  'değil',
  'degil',
  'vermez',
  'yoktur',
  'olmaz',
  'sunmaz',
];

const NEGATION_WINDOW = 40;

function isNegated(haystack: string, index: number, phraseLength: number): boolean {
  const before = haystack.slice(Math.max(0, index - NEGATION_WINDOW), index);
  const after = haystack.slice(index + phraseLength, index + phraseLength + NEGATION_WINDOW);

  return NEGATIONS.some(
    (negation) =>
      new RegExp(`\\b${negation}\\b`).test(before) || new RegExp(`\\b${negation}`).test(after),
  );
}

export function findBannedLanguage(narration: Narration): string[] {
  // Each field is checked on its own. Concatenating them would let a negation
  // in one sentence ("no expected-goals data") mask a claim in another
  // ("bu maç kesin kazanır") that happens to sit within the window.
  const fields = [
    narration.summary,
    ...narration.keyFactors.flatMap((f) => [f.factor, f.explanation]),
    ...narration.risks,
    ...narration.dataLimitations,
  ].map((field) => field.toLowerCase());

  const found = new Set<string>();

  for (const field of fields) {
    for (const phrase of BANNED_PHRASES) {
      let index = field.indexOf(phrase);
      while (index !== -1) {
        // A claim, not a denial of one.
        if (!isNegated(field, index, phrase.length)) {
          found.add(phrase);
          break;
        }
        index = field.indexOf(phrase, index + phrase.length);
      }
    }

    // A percentage promise is always a claim, negated or not.
    if (/\b100\s*%|%\s*100\b/.test(field)) found.add('100%');
  }

  return [...found];
}
