import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { prisma } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { isRealtimeEnabled } from './realtime/socket.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { availabilityRouter, usersRouter } from './modules/users/users.routes.js';
import { workspacesRouter } from './modules/workspaces/workspaces.routes.js';
import { projectsRouter } from './modules/projects/projects.routes.js';
import { tasksRouter } from './modules/tasks/tasks.routes.js';
import { calendarRouter } from './modules/calendar/calendar.routes.js';
import { schedulesRouter } from './modules/scheduling/scheduling.routes.js';
import { briefingsRouter } from './modules/briefings/briefings.routes.js';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { aiRouter } from './modules/ai/ai.routes.js';
import { plannerRouter } from './modules/planner/planner.routes.js';
import { accountRouter } from './modules/account/account.routes.js';
import { feedSettingsRouter, publicFeedRouter } from './modules/calendar/feed.routes.js';
import { progressRouter } from './modules/progress/progress.routes.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  if (!config.isTest) app.use(morgan('dev'));

  app.get('/health', async (_req, res) => {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, redis: config.redisUrl ? 'configured' : 'disabled' });
  });

  const v1 = Router();
  /** Public capabilities, so the client knows whether to open a WebSocket. */
  v1.get('/meta', (_req, res) => {
    res.json({ realtime: isRealtimeEnabled(), backgroundJobs: !!config.redisUrl });
  });
  v1.use('/auth', authRouter);
  // Public, token-protected iCalendar feed (calendar apps can't send a login).
  v1.use('/feed', publicFeedRouter);
  v1.use(requireAuth);
  v1.use('/users', usersRouter);
  v1.use('/availability', availabilityRouter);
  v1.use('/workspaces', workspacesRouter);
  v1.use('/projects', projectsRouter);
  v1.use('/tasks', tasksRouter);
  v1.use('/calendar', calendarRouter);
  v1.use('/schedules', schedulesRouter);
  v1.use('/briefings', briefingsRouter);
  v1.use('/analytics', analyticsRouter);
  v1.use('/notifications', notificationsRouter);
  v1.use('/ai', aiRouter);
  v1.use('/planner', plannerRouter);
  v1.use('/account', accountRouter);
  v1.use('/calendar-feed', feedSettingsRouter);
  v1.use('/progress', progressRouter);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/**
 * Default export for serverless hosts (Vercel detects `src/app.ts` and serves
 * the exported Express app as a function). No WebSockets or workers here.
 */
export default createApp();
