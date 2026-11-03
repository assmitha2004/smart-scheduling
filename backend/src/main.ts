/**
 * Long-running server (Docker, local dev): HTTP + Socket.IO + optional
 * in-process BullMQ workers. On Vercel, `src/app.ts` is used instead.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { closeRealtime, initRealtime } from './realtime/socket.js';
import { closeQueues, registerRepeatableJobs } from './queues/index.js';

const app = createApp();
const server = http.createServer(app);
initRealtime(server);

let stopWorker: (() => Promise<void>) | undefined;

server.listen(config.port, async () => {
  console.log(`Smart Scheduling API listening on http://localhost:${config.port}`);
  if (config.redisUrl) {
    await registerRepeatableJobs().catch((e) => console.warn('[queue] could not register jobs:', e.message));
    if (config.inlineWorker) {
      const { startWorkers } = await import('./workers/index.js');
      stopWorker = startWorkers();
      console.log('Background workers running in-process');
    }
  } else {
    console.log('REDIS_URL not set: background jobs disabled');
  }
});

async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close();
  await stopWorker?.();
  await closeRealtime();
  await closeQueues();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
