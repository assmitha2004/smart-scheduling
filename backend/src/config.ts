import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  nodeEnv,
  isTest: nodeEnv === 'test',
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', nodeEnv === 'production' ? undefined : 'dev-only-insecure-secret-change-me'),
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 15 * 60),
  refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  /** Optional. Without Redis, background jobs are disabled and notifications are delivered inline. */
  redisUrl: process.env.REDIS_URL || undefined,
  /** Run BullMQ workers inside the API process (handy for local dev). */
  inlineWorker: process.env.INLINE_WORKER === 'true',
  aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:8000',
  aiServiceTimeoutMs: Number(process.env.AI_SERVICE_TIMEOUT_MS ?? 20000),
  planningHorizonDays: Number(process.env.PLANNING_HORIZON_DAYS ?? 28),
};
