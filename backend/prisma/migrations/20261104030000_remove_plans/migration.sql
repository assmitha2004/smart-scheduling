-- Everything is free for everyone: drop the plan and trial columns.
ALTER TABLE "users" DROP COLUMN IF EXISTS "plan";
ALTER TABLE "users" DROP COLUMN IF EXISTS "trial_ends_at";
