import { DateTime } from 'luxon';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { emitToUser } from '../../realtime/socket.js';

export type NotificationType =
  | 'TASK_REMINDER'
  | 'DEADLINE_RISK'
  | 'DEPENDENCY_UNBLOCKED'
  | 'DAILY_PLAN'
  | 'SCHEDULE_UPDATED'
  | 'CARRIED_OVER';

export interface NotificationPrefs {
  taskReminders: boolean;
  deadlineRisk: boolean;
  dependencyUnblocked: boolean;
  dailyPlan: boolean;
  reminderLeadMinutes: number;
  dailyPlanHour: number;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  taskReminders: true,
  deadlineRisk: true,
  dependencyUnblocked: true,
  dailyPlan: true,
  reminderLeadMinutes: 10,
  dailyPlanHour: 7,
};

const PREF_FOR_TYPE: Partial<Record<NotificationType, keyof NotificationPrefs>> = {
  TASK_REMINDER: 'taskReminders',
  DEADLINE_RISK: 'deadlineRisk',
  DEPENDENCY_UNBLOCKED: 'dependencyUnblocked',
  DAILY_PLAN: 'dailyPlan',
  CARRIED_OVER: 'dailyPlan',
};

export function resolvePrefs(raw: unknown): NotificationPrefs {
  return { ...DEFAULT_PREFS, ...((raw && typeof raw === 'object' ? raw : {}) as Partial<NotificationPrefs>) };
}

/** Is `at` inside the user's quiet hours (local time; window may wrap midnight)? */
export function inQuietHours(
  user: { timezone: string; quietHoursStart: string | null; quietHoursEnd: string | null },
  at: Date = new Date(),
): boolean {
  if (!user.quietHoursStart || !user.quietHoursEnd) return false;
  const local = DateTime.fromJSDate(at, { zone: user.timezone }).toFormat('HH:mm');
  const s = user.quietHoursStart;
  const e = user.quietHoursEnd;
  return s <= e ? local >= s && local < e : local >= s || local < e;
}

/**
 * Creates a notification if the user's preferences allow it. `dedupeKey`
 * makes the call idempotent (e.g. one risk alert per task per day).
 * During quiet hours the notification is stored but not pushed live.
 */
export async function notify(params: {
  userId: string;
  type: NotificationType;
  message: string;
  data?: Prisma.InputJsonValue;
  dedupeKey?: string;
}): Promise<{ created: boolean; pushed: boolean }> {
  const user = await prisma.user.findUnique({ where: { id: params.userId } });
  if (!user) return { created: false, pushed: false };
  const prefKey = PREF_FOR_TYPE[params.type];
  const prefs = resolvePrefs(user.notificationPrefs);
  if (prefKey && prefs[prefKey] === false) return { created: false, pushed: false };

  if (params.dedupeKey) {
    const existing = await prisma.notification.findUnique({ where: { dedupeKey: params.dedupeKey } });
    if (existing) return { created: false, pushed: false };
  }
  let n;
  try {
    n = await prisma.notification.create({
      data: {
        userId: params.userId,
        type: params.type,
        message: params.message,
        data: params.data,
        dedupeKey: params.dedupeKey,
      },
    });
  } catch (e) {
    // Lost a race on dedupeKey: someone else created it.
    if ((e as { code?: string }).code === 'P2002') return { created: false, pushed: false };
    throw e;
  }
  const quiet = inQuietHours(user);
  if (!quiet) emitToUser(params.userId, 'notification:new', n);
  return { created: true, pushed: !quiet };
}
