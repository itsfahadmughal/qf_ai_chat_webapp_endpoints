-- CreateTable
CREATE TABLE "public"."PromptFeedback" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feedbackScore" INTEGER NOT NULL,
    "reaction" "public"."Reaction",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptFeedback_promptId_idx" ON "public"."PromptFeedback"("promptId");

-- CreateIndex
CREATE INDEX "PromptFeedback_userId_idx" ON "public"."PromptFeedback"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptFeedback_promptId_userId_key" ON "public"."PromptFeedback"("promptId", "userId");

-- AddForeignKey
ALTER TABLE "public"."PromptFeedback" ADD CONSTRAINT "PromptFeedback_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."Prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PromptFeedback" ADD CONSTRAINT "PromptFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
