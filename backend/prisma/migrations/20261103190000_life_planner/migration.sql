-- "Plan my time": persona, saved answers, and a source for routine events it creates.
ALTER TYPE "EventSource" ADD VALUE IF NOT EXISTS 'PLANNER';

ALTER TABLE "users" ADD COLUMN "persona" TEXT;
ALTER TABLE "users" ADD COLUMN "life_profile" JSONB NOT NULL DEFAULT '{}';
