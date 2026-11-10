-- My Day: time windows read from the day description ("after lunch", "by 5pm").
ALTER TABLE "tasks" ADD COLUMN "not_before" TEXT;
ALTER TABLE "tasks" ADD COLUMN "due_by" TEXT;
