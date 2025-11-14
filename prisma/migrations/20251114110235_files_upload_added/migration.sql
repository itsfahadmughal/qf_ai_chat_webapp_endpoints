-- CreateEnum
CREATE TYPE "public"."ConversationFileStatus" AS ENUM ('uploaded', 'processing', 'parsed', 'failed');

-- CreateTable
CREATE TABLE "public"."ConversationFile" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storagePath" TEXT NOT NULL,
    "checksum" TEXT,
    "status" "public"."ConversationFileStatus" NOT NULL DEFAULT 'uploaded',
    "extractedText" TEXT,
    "metadata" JSONB,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationFile_conversationId_idx" ON "public"."ConversationFile"("conversationId");

-- CreateIndex
CREATE INDEX "ConversationFile_hotelId_idx" ON "public"."ConversationFile"("hotelId");

-- CreateIndex
CREATE INDEX "ConversationFile_userId_idx" ON "public"."ConversationFile"("userId");

-- AddForeignKey
ALTER TABLE "public"."ConversationFile" ADD CONSTRAINT "ConversationFile_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationFile" ADD CONSTRAINT "ConversationFile_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ConversationFile" ADD CONSTRAINT "ConversationFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
