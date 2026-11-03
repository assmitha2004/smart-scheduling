import { Worker } from 'bullmq';
import { pathToFileURL } from 'node:url';
import { NOTIFICATIONS_QUEUE, redisConnection, registerRepeatableJobs } from '../queues/index.js';
import { runBlockReminder, runDailyPlanSweep, runDeadlineRiskSweep } from './jobs.js';

/** Starts BullMQ workers. Returns a stop function. */
export function startWorkers(): () => Promise<void> {
  const connection = redisConnection();
  if (!connection) throw new Error('REDIS_URL is required to run workers');
  const worker = new Worker(
    NOTIFICATIONS_QUEUE,
    async (job) => {
      switch (job.name) {
        case 'block-reminder':
          return runBlockReminder(job.data);
        case 'daily-plan-sweep':
          return runDailyPlanSweep();
        case 'deadline-risk-sweep':
          return runDeadlineRiskSweep();
        default:
          throw new Error(`Unknown job ${job.name}`);
      }
    },
    { connection, concurrency: 5 },
  );
  worker.on('failed', (job, err) => console.error(`[worker] ${job?.name} failed:`, err.message));
  return async () => {
    await worker.close();
  };
}

// Standalone entrypoint: `npm run worker`.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const stop = startWorkers();
  registerRepeatableJobs().catch((e) => console.error(e));
  console.log('Smart Scheduling worker started');
  const shutdown = async () => {
    await stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
