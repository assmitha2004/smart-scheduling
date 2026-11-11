-- Plans for several days (week, month, year, any number of days) made in the planning chat.
CREATE TABLE "plan_programs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "start_date" TEXT NOT NULL,
    "end_date" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "days" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "plan_programs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "plan_programs_user_id_status_start_date_idx" ON "plan_programs"("user_id", "status", "start_date");
ALTER TABLE "plan_programs" ADD CONSTRAINT "plan_programs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
