-- CreateTable
CREATE TABLE "public"."PromptUsage" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "usedById" TEXT,
    "source" TEXT,
    "notes" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromptUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptUsage_hotelId_promptId_idx" ON "public"."PromptUsage"("hotelId", "promptId");

-- CreateIndex
CREATE INDEX "PromptUsage_promptId_idx" ON "public"."PromptUsage"("promptId");

-- CreateIndex
CREATE INDEX "PromptUsage_hotelId_usedById_idx" ON "public"."PromptUsage"("hotelId", "usedById");

-- AddForeignKey
ALTER TABLE "public"."PromptUsage" ADD CONSTRAINT "PromptUsage_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."Prompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PromptUsage" ADD CONSTRAINT "PromptUsage_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PromptUsage" ADD CONSTRAINT "PromptUsage_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
