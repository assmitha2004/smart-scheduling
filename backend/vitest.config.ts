import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/smart_scheduling_test',
      REDIS_URL: '',
      JWT_SECRET: 'test-secret',
      AI_SERVICE_URL: 'http://127.0.0.1:4999',
      AI_SERVICE_TIMEOUT_MS: '3000',
    },
  },
});
