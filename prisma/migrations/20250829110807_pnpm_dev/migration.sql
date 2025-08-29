/*
  Warnings:

  - Added the required column `hotelId` to the `Conversation` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `provider` on the `Conversation` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `hotelId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "public"."Provider" AS ENUM ('openai', 'deepseek', 'perplexity');

-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hotelId" TEXT NOT NULL,
DROP COLUMN "provider",
ADD COLUMN     "provider" "public"."Provider" NOT NULL;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "hotelId" TEXT NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'reader';

-- CreateTable
CREATE TABLE "public"."Hotel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HotelProviderToggle" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "provider" "public"."Provider" NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultModel" TEXT,

    CONSTRAINT "HotelProviderToggle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PromptCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "PromptCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Prompt" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "categoryId" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Prompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelProviderToggle_hotelId_provider_key" ON "public"."HotelProviderToggle"("hotelId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PromptCategory_name_key" ON "public"."PromptCategory"("name");

-- CreateIndex
CREATE INDEX "Prompt_hotelId_archived_idx" ON "public"."Prompt"("hotelId", "archived");

-- AddForeignKey
ALTER TABLE "public"."HotelProviderToggle" ADD CONSTRAINT "HotelProviderToggle_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prompt" ADD CONSTRAINT "Prompt_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prompt" ADD CONSTRAINT "Prompt_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prompt" ADD CONSTRAINT "Prompt_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "public"."PromptCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
