-- CreateEnum
CREATE TYPE "public"."Reaction" AS ENUM ('like', 'dislike');

-- CreateTable
CREATE TABLE "public"."MessageFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reaction" "public"."Reaction" NOT NULL,
    "reason" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageFeedback_messageId_idx" ON "public"."MessageFeedback"("messageId");

-- CreateIndex
CREATE INDEX "MessageFeedback_userId_idx" ON "public"."MessageFeedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageFeedback_messageId_userId_key" ON "public"."MessageFeedback"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "public"."MessageFeedback" ADD CONSTRAINT "MessageFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageFeedback" ADD CONSTRAINT "MessageFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
