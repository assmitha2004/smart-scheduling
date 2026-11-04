-- Plans (Free / Pro with trial) and the private calendar feed.
ALTER TABLE "users" ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'FREE';
ALTER TABLE "users" ADD COLUMN "trial_ends_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "calendar_feed_token" TEXT;
CREATE UNIQUE INDEX "users_calendar_feed_token_key" ON "users"("calendar_feed_token");

-- Existing accounts get the same 14-day Pro trial as new sign-ups.
UPDATE "users" SET "trial_ends_at" = NOW() + INTERVAL '14 days';
