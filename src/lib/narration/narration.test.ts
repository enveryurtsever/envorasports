import { describe, expect, it } from 'vitest';
import {
  allowedNumbers,
  findBannedLanguage,
  findUngroundedNumbers,
  narrationSchema,
  type Narration,
} from './schema';
import { templateNarration } from './narration-service';

const payload = {
  homeTeam: 'Arsenal',
  awayTeam: 'Chelsea',
  probability: 0.62,
  odds: 1.85,
  edge: 0.081,
  modelAgreement: 0.74,
  dataQuality: 0.68,
  hasXg: false,
  form: { homeLast5: 'WWDLW', awayLast5: 'LDWWL' },
};

function narration(overrides: Partial<Narration> = {}): Narration {
  return {
    summary: 'The model favours the home side at a probability of 62%.',
    keyFactors: [
      {
        factor: 'Model agreement',
        impact: 'POSITIVE',
        confidence: 0.74,
        explanation: 'The contributing models arrived at a similar view.',
      },
    ],
    risks: ['Model output carries uncertainty.'],
    dataLimitations: ['No expected-goals data for this fixture.'],
    ...overrides,
  };
}

describe('allowedNumbers', () => {
  it('accepts a payload figure in its raw and percentage forms', () => {
    const allowed = allowedNumbers(payload);
    expect(allowed.has('0.62')).toBe(true);
    expect(allowed.has('62')).toBe(true);
    expect(allowed.has('62.0')).toBe(true);
    expect(allowed.has('1.85')).toBe(true);
  });

  it('accepts the Turkish decimal comma', () => {
    expect(allowedNumbers({ odds: 1.85 }).has('1,85')).toBe(true);
  });

  it('understands the underscore line encoding in selection codes', () => {
    // OVER_2_5 is the 2.5 goals line; quoting "Over 2.5" is not an invention.
    const allowed = allowedNumbers({ selection: 'OVER_2_5' });
    expect(allowed.has('2.5')).toBe(true);
    expect(allowed.has('2,5')).toBe(true);
  });

  it('reaches into nested objects and arrays', () => {
    const allowed = allowedNumbers({ a: [{ b: 3.14 }] });
    expect(allowed.has('3.14')).toBe(true);
  });
});

describe('findUngroundedNumbers', () => {
  it('passes a narration that only quotes supplied figures', () => {
    expect(findUngroundedNumbers(narration(), payload)).toEqual([]);
  });

  it('catches an invented probability', () => {
    const bad = narration({ summary: 'The model gives this a 91% chance.' });
    const violations = findUngroundedNumbers(bad, payload);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.value).toBe('91');
    expect(violations[0]!.where).toBe('summary');
  });

  it('does not flag a goals line that came from a selection code', () => {
    const withCode = { ...payload, selections: [{ selection: 'OVER_2_5' }] };
    const narrationWithLine = narration({ summary: 'The model leans to Over 2.5 goals here.' });
    expect(findUngroundedNumbers(narrationWithLine, withCode)).toEqual([]);
  });

  it('catches an invented price inside a factor explanation', () => {
    const bad = narration({
      keyFactors: [
        {
          factor: 'Market',
          impact: 'POSITIVE',
          confidence: 0.7,
          explanation: 'The price of 2.45 is generous.',
        },
      ],
    });

    expect(findUngroundedNumbers(bad, payload).map((v) => v.value)).toContain('2.45');
  });

  it('catches an invented scoreline in a risk note', () => {
    const bad = narration({ risks: ['A 3-0 defeat would undo this.'] });
    // 3 and 0 read as prose, so the guard must not fire on them.
    expect(findUngroundedNumbers(bad, payload)).toEqual([]);

    const worse = narration({ risks: ['They conceded 47 shots last week.'] });
    expect(findUngroundedNumbers(worse, payload).map((v) => v.value)).toContain('47');
  });

  it('allows small numbers that read as ordinary prose', () => {
    const prose = narration({ summary: 'Two of the three models agree on the outcome.' });
    expect(findUngroundedNumbers(prose, payload)).toEqual([]);
  });

  it('checks every field, not just the summary', () => {
    const bad = narration({ dataLimitations: ['Only 88 matches were available.'] });
    expect(findUngroundedNumbers(bad, payload).map((v) => v.where)).toContain('dataLimitations[0]');
  });
});

describe('findBannedLanguage', () => {
  it('accepts responsible wording', () => {
    expect(findBannedLanguage(narration())).toEqual([]);
  });

  it('rejects a promise of a guaranteed outcome', () => {
    expect(findBannedLanguage(narration({ summary: 'This is a guaranteed win.' }))).toContain(
      'guaranteed',
    );
  });

  it('rejects the Turkish equivalents too', () => {
    expect(
      findBannedLanguage(narration({ risks: ['Bu maç kesin kazanır.'] })).length,
    ).toBeGreaterThan(0);
  });

  it('allows the required disclaimer, which negates a guarantee', () => {
    // §29 mandates this sentence; a naive substring match would ban it.
    expect(
      findBannedLanguage(narration({ summary: 'Predictions are not guarantees of outcome, only estimates.' })),
    ).toEqual([]);
    expect(
      findBannedLanguage(narration({ summary: 'Tahminler istatistikseldir ve sonuç garantisi değildir.' })),
    ).toEqual([]);
  });

  it('still rejects a percentage promise', () => {
    expect(findBannedLanguage(narration({ summary: 'This one is 100% safe to back.' })).length).toBeGreaterThan(0);
  });

  it('looks in every field', () => {
    const bad = narration({
      keyFactors: [
        { factor: 'Sure bet', impact: 'POSITIVE', confidence: 1, explanation: 'It cannot lose.' },
      ],
    });
    expect(findBannedLanguage(bad).length).toBeGreaterThan(0);
  });
});

describe('narrationSchema', () => {
  it('accepts a well-formed narration', () => {
    expect(narrationSchema.safeParse(narration()).success).toBe(true);
  });

  it('rejects a confidence outside 0..1', () => {
    const bad = narration({
      keyFactors: [{ factor: 'X', impact: 'POSITIVE', confidence: 4, explanation: 'Long enough.' }],
    });
    expect(narrationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown impact value', () => {
    const bad = {
      ...narration(),
      keyFactors: [{ factor: 'X', impact: 'CERTAIN', confidence: 0.5, explanation: 'Long enough.' }],
    };
    expect(narrationSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty summary', () => {
    expect(narrationSchema.safeParse(narration({ summary: 'short' })).success).toBe(false);
  });
});

describe('templateNarration', () => {
  const request = {
    entityType: 'match' as const,
    entityId: 'm1',
    locale: 'en' as const,
    payload,
  };

  it('produces a valid narration with no model involved', () => {
    const result = templateNarration(request);
    expect(narrationSchema.safeParse(result).success).toBe(true);
  });

  it('quotes only supplied figures, so it passes its own guard', () => {
    expect(findUngroundedNumbers(templateNarration(request), payload)).toEqual([]);
  });

  it('never uses banned language', () => {
    expect(findBannedLanguage(templateNarration(request))).toEqual([]);
  });

  it('reports the missing xG rather than staying silent about it', () => {
    const result = templateNarration(request);
    expect(result.dataLimitations.join(' ')).toMatch(/expected-goals/i);
  });

  it('writes Turkish when asked', () => {
    const result = templateNarration({ ...request, locale: 'tr' });
    expect(result.summary).toMatch(/tahmin/i);
    expect(findBannedLanguage(result)).toEqual([]);
  });
});
