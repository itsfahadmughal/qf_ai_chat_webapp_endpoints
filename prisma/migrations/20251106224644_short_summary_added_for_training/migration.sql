-- AlterEnum
ALTER TYPE "public"."TrainingExampleSource" ADD VALUE 'conversation_summary';

-- AlterTable
ALTER TABLE "public"."TrainingExample" ADD COLUMN     "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "TrainingExample_conversationId_idx" ON "public"."TrainingExample"("conversationId");

-- AddForeignKey
ALTER TABLE "public"."TrainingExample" ADD CONSTRAINT "TrainingExample_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
