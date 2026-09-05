import { createHash } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import {
  DEFAULT_BULLETIN_SCHEDULE,
  bulletinScheduleSchema,
  type BulletinSchedule,
} from '@/lib/schedule/bulletin-schedule';
import {
  DEFAULT_CATEGORY_SETTINGS,
  DEFAULT_SYSTEM_SETTINGS,
  couponCategorySettingsSchema,
  systemCouponSettingsSchema,
  type CouponCategory,
  type CouponCategorySettings,
  type SystemCouponSettings,
} from './coupon-settings';

const log = createLogger('config');

/**
 * Reads live configuration (§17, §24).
 *
 * Nothing in the engine reads a default constant at runtime: it reads here, so
 * an operator change takes effect on the next run without a deploy. A row that
 * fails validation falls back to the shipped default rather than propagating a
 * broken configuration into generation.
 */

export async function getBulletinSchedule(): Promise<BulletinSchedule> {
  const row = await prisma.bulletinScheduleSetting.findFirst();
  if (!row) return DEFAULT_BULLETIN_SCHEDULE;

  const parsed = bulletinScheduleSchema.safeParse({
    enabled: row.enabled,
    timezone: row.timezone,
    publicationWeekdays: row.publicationWeekdays,
    coverageOffsetDays: row.coverageOffsetDays,
    coverageDays: row.coverageDays,
    publishTimeLocal: row.publishTimeLocal,
    grouping: row.grouping,
  });

  if (!parsed.success) {
    log.error('stored bulletin schedule is invalid, using defaults', {
      issues: parsed.error.issues.map((i) => i.message),
    });
    return DEFAULT_BULLETIN_SCHEDULE;
  }
  return parsed.data;
}

export async function getCategorySettings(): Promise<Record<CouponCategory, CouponCategorySettings>> {
  const rows = await prisma.couponCategorySetting.findMany();
  const result = { ...DEFAULT_CATEGORY_SETTINGS };

  for (const row of rows) {
    const parsed = couponCategorySettingsSchema.safeParse({
      category: row.category,
      enabled: row.enabled,
      couponCount: row.couponCount,
      minTotalOdds: Number(row.minTotalOdds),
      maxTotalOdds: row.maxTotalOdds === null ? null : Number(row.maxTotalOdds),
      minSelections: row.minSelections,
      maxSelections: row.maxSelections,
      minConfidence: Number(row.minConfidence),
      minExpectedValue: Number(row.minExpectedValue),
      minEdge: Number(row.minEdge),
      minProbability: Number(row.minProbability),
      maxRisk: Number(row.maxRisk),
      maxCorrelation: Number(row.maxCorrelation),
      minDataQuality: Number(row.minDataQuality),
      oneSelectionPerMatch: row.oneSelectionPerMatch,
      allowedMarkets: row.allowedMarkets,
    });

    if (parsed.success) {
      result[row.category as CouponCategory] = parsed.data;
    } else {
      log.error('invalid category settings, using default', { category: row.category });
    }
  }
  return result;
}

export async function getSystemSettings(): Promise<SystemCouponSettings> {
  const row = await prisma.systemCouponSetting.findFirst();
  if (!row) return DEFAULT_SYSTEM_SETTINGS;

  const parsed = systemCouponSettingsSchema.safeParse({
    enabled: row.enabled,
    allowedSystemTypes: row.allowedSystemTypes,
    defaultSystemType: row.defaultSystemType,
    sourceCategories:
      row.sourceCategories.length > 0
        ? row.sourceCategories
        : DEFAULT_SYSTEM_SETTINGS.sourceCategories,
    minBaseSelections: row.minBaseSelections,
    maxBaseSelections: row.maxBaseSelections,
    stakePerColumn: Number(row.stakePerColumn),
    maxTotalStake: Number(row.maxTotalStake),
    currency: row.currency,
    minCombinedProbability: Number(row.minCombinedProbability),
    minExpectedValue: Number(row.minExpectedValue),
    maxCorrelation: Number(row.maxCorrelation),
    oneSelectionPerMatch: row.oneSelectionPerMatch,
    couponCount: row.couponCount,
  });

  if (!parsed.success) {
    log.error('stored system settings are invalid, using defaults');
    return DEFAULT_SYSTEM_SETTINGS;
  }
  return parsed.data;
}

/** Typed reader for the generic key/value settings table. */
export async function getAppSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return fallback;

  try {
    switch (row.valueType) {
      case 'NUMBER':
      case 'DECIMAL': {
        const value = Number(row.value);
        return (Number.isFinite(value) ? value : fallback) as T;
      }
      case 'BOOLEAN':
        return (row.value === 'true') as T;
      case 'JSON':
        return JSON.parse(row.value) as T;
      default:
        return row.value as T;
    }
  } catch {
    log.warn('unparseable app setting, using fallback', { key });
    return fallback;
  }
}

export interface SettingsSnapshotPayload {
  schedule: BulletinSchedule;
  categories: Record<CouponCategory, CouponCategorySettings>;
  system: SystemCouponSettings;
}

/**
 * Freezes the configuration that drove one generation run.
 *
 * Coupons point at the snapshot, so changing a threshold tomorrow cannot
 * retroactively alter why yesterday's coupon was produced (§41). The checksum
 * deduplicates: an unchanged configuration reuses the same row.
 */
export async function captureSettingsSnapshot(): Promise<{ id: string; payload: SettingsSnapshotPayload }> {
  const payload: SettingsSnapshotPayload = {
    schedule: await getBulletinSchedule(),
    categories: await getCategorySettings(),
    system: await getSystemSettings(),
  };

  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  const checksum = createHash('sha256').update(canonical).digest('hex');

  const snapshot = await prisma.settingsSnapshot.upsert({
    where: { checksum },
    update: {},
    create: { checksum, payload: payload as never },
    select: { id: true },
  });

  return { id: snapshot.id, payload };
}
