-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."SessionStatus" AS ENUM ('LOBBY', 'QUESTION_ACTIVE', 'QUESTION_CLOSED', 'FINISHED');

-- CreateEnum
CREATE TYPE "public"."SessionMode" AS ENUM ('MANUAL', 'TIMER');

-- CreateEnum
CREATE TYPE "public"."AnswerChoice" AS ENUM ('A', 'B', 'C', 'D');

-- CreateTable
CREATE TABLE "public"."Teacher" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Quiz" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Question" (
    "id" UUID NOT NULL,
    "quizId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT NOT NULL,
    "optionD" TEXT NOT NULL,
    "correctAnswer" "public"."AnswerChoice" NOT NULL,
    "durationSeconds" INTEGER NOT NULL DEFAULT 30,
    "order" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."QuizSession" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "quizId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "roomCode" TEXT NOT NULL,
    "status" "public"."SessionStatus" NOT NULL DEFAULT 'LOBBY',
    "mode" "public"."SessionMode" NOT NULL DEFAULT 'MANUAL',
    "durationSeconds" INTEGER,
    "currentQuestionIndex" INTEGER NOT NULL DEFAULT -1,
    "questionStartedAt" TIMESTAMP(3),
    "questionEndsAt" TIMESTAMP(3),
    "nextQuestionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "QuizSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SessionQuestion" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "sourceQuestionId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT NOT NULL,
    "optionD" TEXT NOT NULL,
    "correctAnswer" "public"."AnswerChoice" NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "SessionQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Device" (
    "id" TEXT NOT NULL,
    "online" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SessionParticipant" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "studentCode" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Answer" (
    "id" UUID NOT NULL,
    "participantId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "answer" "public"."AnswerChoice" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "clientTimestamp" TIMESTAMP(3) NOT NULL,
    "serverTimestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Answer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProcessedMqttMessage" (
    "requestId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "ack" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMqttMessage_pkey" PRIMARY KEY ("requestId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_email_key" ON "public"."Teacher"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "public"."RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_familyId_idx" ON "public"."RefreshToken"("familyId");

-- CreateIndex
CREATE INDEX "Quiz_teacherId_deletedAt_idx" ON "public"."Quiz"("teacherId", "deletedAt");

-- CreateIndex
CREATE INDEX "Question_quizId_order_idx" ON "public"."Question"("quizId", "order");

-- CreateIndex
CREATE INDEX "QuizSession_teacherId_createdAt_idx" ON "public"."QuizSession"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "QuizSession_roomCode_status_idx" ON "public"."QuizSession"("roomCode", "status");

-- Codes can be reused only after the earlier session is finished.
CREATE UNIQUE INDEX "QuizSession_live_roomCode_key" ON "public"."QuizSession"("roomCode") WHERE "status" <> 'FINISHED';

ALTER TABLE "public"."Question" ADD CONSTRAINT "Question_duration_check" CHECK ("durationSeconds" BETWEEN 5 AND 3600);
ALTER TABLE "public"."SessionQuestion" ADD CONSTRAINT "SessionQuestion_duration_check" CHECK ("durationSeconds" BETWEEN 5 AND 3600);
ALTER TABLE "public"."QuizSession" ADD CONSTRAINT "QuizSession_roomCode_check" CHECK ("roomCode" ~ '^[0-9]{6}$');
ALTER TABLE "public"."Answer" ADD CONSTRAINT "Answer_sequence_check" CHECK ("sequence" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "SessionQuestion_sessionId_order_key" ON "public"."SessionQuestion"("sessionId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_deviceId_key" ON "public"."SessionParticipant"("sessionId", "deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionParticipant_sessionId_studentCode_key" ON "public"."SessionParticipant"("sessionId", "studentCode");

-- CreateIndex
CREATE INDEX "Answer_questionId_idx" ON "public"."Answer"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "Answer_participantId_questionId_key" ON "public"."Answer"("participantId", "questionId");

-- CreateIndex
CREATE INDEX "ProcessedMqttMessage_processedAt_idx" ON "public"."ProcessedMqttMessage"("processedAt");

-- AddForeignKey
ALTER TABLE "public"."RefreshToken" ADD CONSTRAINT "RefreshToken_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Quiz" ADD CONSTRAINT "Quiz_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Question" ADD CONSTRAINT "Question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "public"."Quiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QuizSession" ADD CONSTRAINT "QuizSession_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QuizSession" ADD CONSTRAINT "QuizSession_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "public"."Quiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionQuestion" ADD CONSTRAINT "SessionQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."QuizSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionParticipant" ADD CONSTRAINT "SessionParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."QuizSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionParticipant" ADD CONSTRAINT "SessionParticipant_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "public"."Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Answer" ADD CONSTRAINT "Answer_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "public"."SessionParticipant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Answer" ADD CONSTRAINT "Answer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."SessionQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
