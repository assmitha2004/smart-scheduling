-- Local AI assistant: learned profile, Google (Calendar/Meet + Gmail) connection,
-- questions for the user, actions awaiting approval, chat history.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "assistant_memory" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "calendar_events" ADD COLUMN "external_id" TEXT,
ADD COLUMN "meet_url" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "calendar_events_user_id_external_id_key" ON "calendar_events"("user_id", "external_id");

-- CreateTable
CREATE TABLE "google_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'google',
    "email" TEXT NOT NULL,
    "refresh_token_enc" TEXT,
    "scopes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "last_sync_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "google_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "google_accounts_user_id_key" ON "google_accounts"("user_id");

-- AddForeignKey
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "assistant_questions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "detail" TEXT,
    "options" JSONB NOT NULL DEFAULT '[]',
    "context" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),

    CONSTRAINT "assistant_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "assistant_questions_user_id_dedupe_key_key" ON "assistant_questions"("user_id", "dedupe_key");
CREATE INDEX "assistant_questions_user_id_status_created_at_idx" ON "assistant_questions"("user_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_questions" ADD CONSTRAINT "assistant_questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "assistant_actions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "question_id" UUID,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_at" TIMESTAMPTZ(3),

    CONSTRAINT "assistant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_actions_user_id_status_created_at_idx" ON "assistant_actions"("user_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "assistant_actions" ADD CONSTRAINT "assistant_actions_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "assistant_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "assistant_messages" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_messages_user_id_created_at_idx" ON "assistant_messages"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
