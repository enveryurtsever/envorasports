'use server';

import { revalidatePath } from 'next/cache';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { getViewer } from '@/lib/auth/session';
import { createLogger } from '@/lib/logging/logger';
import {
  COUPON_CATEGORIES,
  couponCategorySettingsSchema,
  type CouponCategory,
} from '@/lib/config/coupon-settings';
import { bulletinScheduleSchema } from '@/lib/schedule/bulletin-schedule';
import { runNamedJob, type JobName } from '@/services/jobs/registry';
import type { ActionState } from './action-state';

const log = createLogger('admin:settings');

/** Every mutating admin action re-checks the role server-side. */
async function requireAdmin() {
  const viewer = await getViewer();
  if (!viewer.isAdmin) throw new Error('forbidden');
  return viewer;
}

function num(formData: FormData, key: string): number {
  return Number(formData.get(key));
}

function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === 'on' || formData.get(key) === 'true';
}

export async function saveCategorySettings(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const viewer = await requireAdmin();
  const category = String(formData.get('category')) as CouponCategory;

  if (!COUPON_CATEGORIES.includes(category)) {
    return { ok: false, message: 'unknown_category', issues: [] };
  }

  const maxTotalOddsRaw = String(formData.get('maxTotalOdds') ?? '').trim();

  const candidate = {
    category,
    enabled: bool(formData, 'enabled'),
    couponCount: num(formData, 'couponCount'),
    minTotalOdds: num(formData, 'minTotalOdds'),
    // Blank means "no ceiling", which High Value genuinely wants.
    maxTotalOdds: maxTotalOddsRaw === '' ? null : Number(maxTotalOddsRaw),
    minSelections: num(formData, 'minSelections'),
    maxSelections: num(formData, 'maxSelections'),
    minConfidence: num(formData, 'minConfidence'),
    minExpectedValue: num(formData, 'minExpectedValue'),
    minEdge: num(formData, 'minEdge'),
    minProbability: num(formData, 'minProbability'),
    maxRisk: num(formData, 'maxRisk'),
    maxCorrelation: num(formData, 'maxCorrelation'),
    minDataQuality: num(formData, 'minDataQuality'),
    oneSelectionPerMatch: bool(formData, 'oneSelectionPerMatch'),
    allowedMarkets: String(formData.get('allowedMarkets') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  const parsed = couponCategorySettingsSchema.safeParse(candidate);
  if (!parsed.success) {
    // An impossible configuration never reaches the database (§17).
    return {
      ok: false,
      message: 'invalid',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const previous = await prisma.couponCategorySetting.findUnique({ where: { category } });
  const s = parsed.data;

  await prisma.couponCategorySetting.update({
    where: { category },
    data: {
      enabled: s.enabled,
      couponCount: s.couponCount,
      minTotalOdds: new Prisma.Decimal(s.minTotalOdds),
      maxTotalOdds: s.maxTotalOdds === null ? null : new Prisma.Decimal(s.maxTotalOdds),
      minSelections: s.minSelections,
      maxSelections: s.maxSelections,
      minConfidence: new Prisma.Decimal(s.minConfidence),
      minExpectedValue: new Prisma.Decimal(s.minExpectedValue),
      minEdge: new Prisma.Decimal(s.minEdge),
      minProbability: new Prisma.Decimal(s.minProbability),
      maxRisk: new Prisma.Decimal(s.maxRisk),
      maxCorrelation: new Prisma.Decimal(s.maxCorrelation),
      minDataQuality: new Prisma.Decimal(s.minDataQuality),
      oneSelectionPerMatch: s.oneSelectionPerMatch,
      allowedMarkets: s.allowedMarkets,
    },
  });

  // Configuration changes are audited (§24). Historical coupons keep their own
  // settings snapshot, so this cannot rewrite the past.
  await prisma.settingsAuditLog.create({
    data: {
      actorId: viewer.userId,
      scope: 'coupon_category',
      key: category,
      oldValue: previous ? JSON.parse(JSON.stringify(previous)) : Prisma.JsonNull,
      newValue: JSON.parse(JSON.stringify(s)),
    },
  });

  log.info('category settings updated', { category, actor: viewer.email });
  revalidatePath('/admin/settings/coupons');
  return { ok: true, message: 'saved', issues: [] };
}

export async function saveSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const viewer = await requireAdmin();

  const candidate = {
    enabled: bool(formData, 'enabled'),
    timezone: String(formData.get('timezone') ?? 'Europe/Istanbul'),
    publicationWeekdays: formData.getAll('publicationWeekdays').map(Number),
    coverageOffsetDays: num(formData, 'coverageOffsetDays'),
    coverageDays: num(formData, 'coverageDays'),
    publishTimeLocal: String(formData.get('publishTimeLocal') ?? '09:00'),
    grouping: String(formData.get('grouping') ?? 'PER_DAY'),
  };

  const parsed = bulletinScheduleSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'invalid',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const existing = await prisma.bulletinScheduleSetting.findFirst();
  const s = parsed.data;

  const data = {
    enabled: s.enabled,
    timezone: s.timezone,
    publicationWeekdays: s.publicationWeekdays,
    coverageOffsetDays: s.coverageOffsetDays,
    coverageDays: s.coverageDays,
    publishTimeLocal: s.publishTimeLocal,
    grouping: s.grouping,
  };

  if (existing) {
    await prisma.bulletinScheduleSetting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.bulletinScheduleSetting.create({ data });
  }

  await prisma.settingsAuditLog.create({
    data: {
      actorId: viewer.userId,
      scope: 'bulletin_schedule',
      key: 'schedule',
      oldValue: existing ? JSON.parse(JSON.stringify(existing)) : Prisma.JsonNull,
      newValue: JSON.parse(JSON.stringify(s)),
    },
  });

  revalidatePath('/admin/settings/schedule');
  revalidatePath('/admin');
  return { ok: true, message: 'saved', issues: [] };
}

/** Manual job trigger from the admin panel (§39). */
export async function triggerJob(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireAdmin();

  const job = String(formData.get('job')) as JobName;
  const force = formData.get('force') === 'true';

  const outcome = await runNamedJob(job, { force });
  revalidatePath('/admin');

  return {
    ok: outcome.status !== 'FAILED',
    message: outcome.status === 'SKIPPED' ? outcome.reason : outcome.status.toLowerCase(),
    issues: outcome.status === 'FAILED' ? [outcome.error] : [],
  };
}
