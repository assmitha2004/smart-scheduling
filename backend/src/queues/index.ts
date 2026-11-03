import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

export type JobName = 'block-reminder' | 'daily-plan-sweep' | 'deadline-risk-sweep';

let connection: Redis | null = null;
let queue: Queue | null = null;

export function redisConnection(): Redis | null {
  if (!config.redisUrl) return null;
  connection ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return connection;
}

export function notificationsQueue(): Queue | null {
  const conn = redisConnection();
  if (!conn) return null;
  queue ??= new Queue(NOTIFICATIONS_QUEUE, {
    connection: conn,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
  });
  return queue;
}

/** Schedules a reminder shortly before each block starts. Safe to call repeatedly. */
export async function scheduleBlockReminders(
  blocks: { id: string; startAt: Date }[],
  leadMinutes: number,
): Promise<void> {
  const q = notificationsQueue();
  if (!q) return;
  const now = Date.now();
  await Promise.all(
    blocks.map(async (b) => {
      const delay = b.startAt.getTime() - leadMinutes * 60_000 - now;
      if (delay < 0) return;
      const jobId = `reminder-${b.id}-${b.startAt.getTime()}`;
      await q.add('block-reminder', { blockId: b.id, startAt: b.startAt.toISOString() }, { jobId, delay });
    }),
  );
}

/** Registers hourly sweeps (idempotent: BullMQ job schedulers upsert by id). */
export async function registerRepeatableJobs(): Promise<void> {
  const q = notificationsQueue();
  if (!q) return;
  await q.upsertJobScheduler('daily-plan-sweep', { pattern: '0 * * * *' }, { name: 'daily-plan-sweep' });
  await q.upsertJobScheduler('deadline-risk-sweep', { pattern: '30 * * * *' }, { name: 'deadline-risk-sweep' });
}

export async function closeQueues(): Promise<void> {
  await queue?.close().catch(() => undefined);
  await connection?.quit().catch(() => undefined);
  queue = null;
  connection = null;
}
