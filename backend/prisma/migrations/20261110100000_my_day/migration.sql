-- "My Day": plan a single day from a plain task list, track it and carry leftovers over.
ALTER TABLE "tasks" ADD COLUMN "planned_date" TEXT;
ALTER TABLE "tasks" ADD COLUMN "must_do" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "day_top" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tasks" ADD COLUMN "effort" TEXT;
ALTER TABLE "tasks" ADD COLUMN "fixed_time" TEXT;
ALTER TABLE "tasks" ADD COLUMN "rollover_count" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "tasks_assignee_id_planned_date_idx" ON "tasks"("assignee_id", "planned_date");

CREATE TABLE "day_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "items" JSONB NOT NULL DEFAULT '[]',
    "insights" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "day_plans_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "day_plans_user_id_date_key" ON "day_plans"("user_id", "date");
ALTER TABLE "day_plans" ADD CONSTRAINT "day_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
