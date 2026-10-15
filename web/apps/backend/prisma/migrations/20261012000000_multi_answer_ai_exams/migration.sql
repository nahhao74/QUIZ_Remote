-- Multiple-answer questions, question metadata, AI jobs/review queue, classes and exams.
-- Existing A/B/C/D enum values are converted in place to canonical answer keys ("A", "AC", ...).

-- CreateEnum
CREATE TYPE "public"."QuestionType" AS ENUM ('SINGLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "public"."Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "public"."QuestionOrigin" AS ENUM ('MANUAL', 'IMPORT', 'AI');

-- CreateEnum
CREATE TYPE "public"."AiJobKind" AS ENUM ('GENERATE_QUESTIONS', 'EXTRACT_QUESTIONS', 'REVIEW_QUIZ', 'ANALYZE_SESSION', 'ANALYZE_EXAM');

-- CreateEnum
CREATE TYPE "public"."AiJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."Question" ADD COLUMN     "difficulty" "public"."Difficulty",
ADD COLUMN     "explanation" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "knowledge" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "origin" "public"."QuestionOrigin" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "topic" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "type" "public"."QuestionType" NOT NULL DEFAULT 'SINGLE',
ALTER COLUMN "correctAnswer" SET DATA TYPE TEXT USING "correctAnswer"::text;

-- AlterTable
ALTER TABLE "public"."QuizSession" ADD COLUMN     "classroomId" UUID,
ADD COLUMN     "examId" UUID,
ADD COLUMN     "variantCode" TEXT;

-- AlterTable
ALTER TABLE "public"."SessionQuestion" ADD COLUMN     "difficulty" "public"."Difficulty",
ADD COLUMN     "explanation" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "knowledge" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "optionOrder" TEXT NOT NULL DEFAULT 'ABCD',
ADD COLUMN     "topic" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "type" "public"."QuestionType" NOT NULL DEFAULT 'SINGLE',
ALTER COLUMN "correctAnswer" SET DATA TYPE TEXT USING "correctAnswer"::text;

-- AlterTable
ALTER TABLE "public"."Answer" ALTER COLUMN "answer" SET DATA TYPE TEXT USING "answer"::text;

-- DropEnum
DROP TYPE "public"."AnswerChoice";

-- CreateTable
CREATE TABLE "public"."SourceDocument" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "text" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "data" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SourceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AiJob" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "kind" "public"."AiJobKind" NOT NULL,
    "status" "public"."AiJobStatus" NOT NULL DEFAULT 'QUEUED',
    "documentId" UUID,
    "quizId" UUID,
    "sessionId" UUID,
    "examId" UUID,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL DEFAULT '',
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GeneratedQuestion" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT NOT NULL,
    "optionD" TEXT NOT NULL,
    "type" "public"."QuestionType" NOT NULL DEFAULT 'SINGLE',
    "correctAnswer" TEXT NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "difficulty" "public"."Difficulty",
    "sourceExcerpt" TEXT NOT NULL DEFAULT '',
    "status" "public"."ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "quizId" UUID,
    "questionId" UUID,
    "order" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "GeneratedQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Classroom" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Classroom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Student" (
    "id" UUID NOT NULL,
    "classroomId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Exam" (
    "id" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "quizId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT true,
    "durationSeconds" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Exam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExamQuestion" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "sourceQuestionId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "optionA" TEXT NOT NULL,
    "optionB" TEXT NOT NULL,
    "optionC" TEXT NOT NULL,
    "optionD" TEXT NOT NULL,
    "type" "public"."QuestionType" NOT NULL DEFAULT 'SINGLE',
    "correctAnswer" TEXT NOT NULL,
    "explanation" TEXT NOT NULL DEFAULT '',
    "knowledge" TEXT NOT NULL DEFAULT '',
    "topic" TEXT NOT NULL DEFAULT '',
    "difficulty" "public"."Difficulty",
    "durationSeconds" INTEGER NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExamVariant" (
    "id" UUID NOT NULL,
    "examId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "layout" JSONB NOT NULL,

    CONSTRAINT "ExamVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SourceDocument_teacherId_deletedAt_idx" ON "public"."SourceDocument"("teacherId", "deletedAt");

-- CreateIndex
CREATE INDEX "AiJob_teacherId_kind_createdAt_idx" ON "public"."AiJob"("teacherId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AiJob_status_idx" ON "public"."AiJob"("status");

-- CreateIndex
CREATE INDEX "GeneratedQuestion_teacherId_status_createdAt_idx" ON "public"."GeneratedQuestion"("teacherId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "GeneratedQuestion_jobId_idx" ON "public"."GeneratedQuestion"("jobId");

-- CreateIndex
CREATE INDEX "Classroom_teacherId_deletedAt_idx" ON "public"."Classroom"("teacherId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_classroomId_code_key" ON "public"."Student"("classroomId", "code");

-- CreateIndex
CREATE INDEX "Exam_teacherId_deletedAt_idx" ON "public"."Exam"("teacherId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamQuestion_examId_order_key" ON "public"."ExamQuestion"("examId", "order");

-- CreateIndex
CREATE UNIQUE INDEX "ExamVariant_examId_code_key" ON "public"."ExamVariant"("examId", "code");

-- CreateIndex
CREATE INDEX "QuizSession_classroomId_idx" ON "public"."QuizSession"("classroomId");

-- CreateIndex
CREATE INDEX "QuizSession_examId_idx" ON "public"."QuizSession"("examId");

-- AddForeignKey
ALTER TABLE "public"."QuizSession" ADD CONSTRAINT "QuizSession_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "public"."Classroom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."QuizSession" ADD CONSTRAINT "QuizSession_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SourceDocument" ADD CONSTRAINT "SourceDocument_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AiJob" ADD CONSTRAINT "AiJob_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GeneratedQuestion" ADD CONSTRAINT "GeneratedQuestion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."AiJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Classroom" ADD CONSTRAINT "Classroom_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Student" ADD CONSTRAINT "Student_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "public"."Classroom"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Exam" ADD CONSTRAINT "Exam_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Exam" ADD CONSTRAINT "Exam_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "public"."Quiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamQuestion" ADD CONSTRAINT "ExamQuestion_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamVariant" ADD CONSTRAINT "ExamVariant_examId_fkey" FOREIGN KEY ("examId") REFERENCES "public"."Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Canonical keys: one or more of A-D in alphabetical order, no repeats. Single-answer questions hold one letter.
ALTER TABLE "public"."Question" ADD CONSTRAINT "Question_correctAnswer_check" CHECK ("correctAnswer" ~ '^(A?B?C?D?)$' AND "correctAnswer" <> '' AND ("type" = 'MULTIPLE' OR length("correctAnswer") = 1));
ALTER TABLE "public"."SessionQuestion" ADD CONSTRAINT "SessionQuestion_correctAnswer_check" CHECK ("correctAnswer" ~ '^(A?B?C?D?)$' AND "correctAnswer" <> '' AND ("type" = 'MULTIPLE' OR length("correctAnswer") = 1));
ALTER TABLE "public"."SessionQuestion" ADD CONSTRAINT "SessionQuestion_optionOrder_check" CHECK ("optionOrder" ~ '^[A-D]{4}$');
ALTER TABLE "public"."Answer" ADD CONSTRAINT "Answer_answer_check" CHECK ("answer" ~ '^(A?B?C?D?)$' AND "answer" <> '');
ALTER TABLE "public"."ExamQuestion" ADD CONSTRAINT "ExamQuestion_correctAnswer_check" CHECK ("correctAnswer" ~ '^(A?B?C?D?)$' AND "correctAnswer" <> '' AND ("type" = 'MULTIPLE' OR length("correctAnswer") = 1));
ALTER TABLE "public"."ExamQuestion" ADD CONSTRAINT "ExamQuestion_duration_check" CHECK ("durationSeconds" BETWEEN 5 AND 3600);
ALTER TABLE "public"."GeneratedQuestion" ADD CONSTRAINT "GeneratedQuestion_correctAnswer_check" CHECK ("correctAnswer" ~ '^(A?B?C?D?)$');
ALTER TABLE "public"."Student" ADD CONSTRAINT "Student_code_check" CHECK ("code" ~ '^[0-9]{2}$');
ALTER TABLE "public"."AiJob" ADD CONSTRAINT "AiJob_progress_check" CHECK ("progress" BETWEEN 0 AND 100);
