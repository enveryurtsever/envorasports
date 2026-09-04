import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATEGORY_SETTINGS,
  DEFAULT_MODEL_WEIGHTS,
  DEFAULT_SYSTEM_SETTINGS,
  couponCategorySettingsSchema,
  modelWeightsSchema,
  systemCouponSettingsSchema,
} from './coupon-settings';

describe('category settings validation (§17)', () => {
  const base = DEFAULT_CATEGORY_SETTINGS.BALANCED_PICKS;

  it('accepts the shipped defaults', () => {
    for (const settings of Object.values(DEFAULT_CATEGORY_SETTINGS)) {
      expect(couponCategorySettingsSchema.safeParse(settings).success).toBe(true);
    }
  });

  it('rejects an inverted odds range', () => {
    const result = couponCategorySettingsSchema.safeParse({ ...base, minTotalOdds: 6, maxTotalOdds: 2.5 });
    expect(result.success).toBe(false);
  });

  it('allows an open-ended maximum for high value', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, maxTotalOdds: null }).success).toBe(true);
  });

  it('rejects an inverted selection range', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, minSelections: 5, maxSelections: 2 }).success).toBe(false);
  });

  it('rejects odds below 1.00, which are not valid decimal odds', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, minTotalOdds: 0.5 }).success).toBe(false);
  });

  it('rejects probabilities outside 0..1', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, minConfidence: 1.5 }).success).toBe(false);
    expect(couponCategorySettingsSchema.safeParse({ ...base, maxRisk: -0.1 }).success).toBe(false);
  });

  it('rejects a negative coupon count', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, couponCount: -1 }).success).toBe(false);
  });

  it('accepts a changed coupon count, so counts really are dynamic (§30)', () => {
    const result = couponCategorySettingsSchema.safeParse({ ...base, couponCount: 10 });
    expect(result.success).toBe(true);
    expect(result.success && result.data.couponCount).toBe(10);
  });

  it('rejects an unknown market code', () => {
    expect(couponCategorySettingsSchema.safeParse({ ...base, allowedMarkets: ['NOT_A_MARKET'] }).success).toBe(false);
  });
});

describe('system settings validation (§18)', () => {
  it('accepts the shipped defaults', () => {
    expect(systemCouponSettingsSchema.safeParse(DEFAULT_SYSTEM_SETTINGS).success).toBe(true);
  });

  it('rejects an inverted base-selection range', () => {
    expect(
      systemCouponSettingsSchema.safeParse({ ...DEFAULT_SYSTEM_SETTINGS, minBaseSelections: 10, maxBaseSelections: 6 })
        .success,
    ).toBe(false);
  });

  it('rejects a default system type that is not allowed', () => {
    expect(
      systemCouponSettingsSchema.safeParse({ ...DEFAULT_SYSTEM_SETTINGS, defaultSystemType: 'SYSTEM_9' }).success,
    ).toBe(false);
  });

  it('rejects a system type that can never be satisfied', () => {
    // SYSTEM_12 needs 12 base selections but the maximum is 10.
    expect(
      systemCouponSettingsSchema.safeParse({
        ...DEFAULT_SYSTEM_SETTINGS,
        allowedSystemTypes: ['SYSTEM_3', 'SYSTEM_12'],
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed system type string', () => {
    expect(
      systemCouponSettingsSchema.safeParse({ ...DEFAULT_SYSTEM_SETTINGS, allowedSystemTypes: ['SYSTEM-3'] }).success,
    ).toBe(false);
  });
});

describe('model weights (§26)', () => {
  it('accepts the documented 20/40/20/20 split', () => {
    expect(modelWeightsSchema.safeParse(DEFAULT_MODEL_WEIGHTS).success).toBe(true);
  });

  it('rejects weights that do not sum to 1', () => {
    expect(modelWeightsSchema.safeParse({ elo: 0.5, poisson: 0.5, form: 0.5, xg: 0.5 }).success).toBe(false);
  });
});
