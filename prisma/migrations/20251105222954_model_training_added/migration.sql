-- CreateEnum
CREATE TYPE "public"."TrainingExampleSource" AS ENUM ('conversation', 'prompt');

-- CreateEnum
CREATE TYPE "public"."TrainingVectorStatus" AS ENUM ('pending', 'uploading', 'uploaded', 'failed');

-- CreateEnum
CREATE TYPE "public"."FineTuneStatus" AS ENUM ('pending', 'uploading', 'running', 'succeeded', 'failed', 'canceled');

-- CreateEnum
CREATE TYPE "public"."FineTuneModelStatus" AS ENUM ('pending', 'active', 'retired');

-- AlterTable
ALTER TABLE "public"."Message" ADD COLUMN     "feedbackAt" TIMESTAMP(3),
ADD COLUMN     "includedInTraining" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "qualityScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "public"."Prompt" ADD COLUMN     "feedbackCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFeedbackAt" TIMESTAMP(3),
ADD COLUMN     "qualityScore" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "public"."TrainingExample" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "source" "public"."TrainingExampleSource" NOT NULL,
    "messageId" TEXT,
    "promptId" TEXT,
    "inputText" TEXT NOT NULL,
    "outputText" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "metadata" JSONB,
    "vectorStatus" "public"."TrainingVectorStatus" NOT NULL DEFAULT 'pending',
    "vectorFileId" TEXT,
    "vectorUploadedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainingExample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FineTuneJob" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "provider" "public"."Provider" NOT NULL DEFAULT 'openai',
    "status" "public"."FineTuneStatus" NOT NULL DEFAULT 'pending',
    "datasetFileId" TEXT,
    "openaiJobId" TEXT,
    "resultingModel" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FineTuneJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FineTuneModel" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "provider" "public"."Provider" NOT NULL DEFAULT 'openai',
    "jobId" TEXT,
    "modelId" TEXT NOT NULL,
    "status" "public"."FineTuneModelStatus" NOT NULL DEFAULT 'pending',
    "metadata" JSONB,
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FineTuneModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingExample_hotelId_vectorStatus_idx" ON "public"."TrainingExample"("hotelId", "vectorStatus");

-- CreateIndex
CREATE INDEX "TrainingExample_messageId_idx" ON "public"."TrainingExample"("messageId");

-- CreateIndex
CREATE INDEX "TrainingExample_promptId_idx" ON "public"."TrainingExample"("promptId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingExample_messageId_key" ON "public"."TrainingExample"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingExample_promptId_key" ON "public"."TrainingExample"("promptId");

-- CreateIndex
CREATE INDEX "FineTuneJob_hotelId_status_idx" ON "public"."FineTuneJob"("hotelId", "status");

-- CreateIndex
CREATE INDEX "FineTuneModel_hotelId_provider_idx" ON "public"."FineTuneModel"("hotelId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "FineTuneModel_hotelId_provider_modelId_key" ON "public"."FineTuneModel"("hotelId", "provider", "modelId");

-- AddForeignKey
ALTER TABLE "public"."TrainingExample" ADD CONSTRAINT "TrainingExample_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrainingExample" ADD CONSTRAINT "TrainingExample_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TrainingExample" ADD CONSTRAINT "TrainingExample_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."Prompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FineTuneJob" ADD CONSTRAINT "FineTuneJob_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FineTuneModel" ADD CONSTRAINT "FineTuneModel_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."FineTuneModel" ADD CONSTRAINT "FineTuneModel_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."FineTuneJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
