/*
  Warnings:

  - A unique constraint covering the columns `[departmentId]` on the table `HotelVectorStore` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "promptId" TEXT;

-- AlterTable
ALTER TABLE "public"."HotelVectorStore" ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "public"."Prompt" ADD COLUMN     "assignedUserId" TEXT,
ADD COLUMN     "departmentId" TEXT;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "departmentId" TEXT;

-- CreateTable
CREATE TABLE "public"."Department" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Department_hotelId_idx" ON "public"."Department"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_hotelId_name_key" ON "public"."Department"("hotelId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "HotelVectorStore_departmentId_key" ON "public"."HotelVectorStore"("departmentId");

-- CreateIndex
CREATE INDEX "Prompt_assignedUserId_idx" ON "public"."Prompt"("assignedUserId");

-- CreateIndex
CREATE INDEX "Prompt_departmentId_idx" ON "public"."Prompt"("departmentId");

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."Prompt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prompt" ADD CONSTRAINT "Prompt_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Prompt" ADD CONSTRAINT "Prompt_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HotelVectorStore" ADD CONSTRAINT "HotelVectorStore_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "public"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Department" ADD CONSTRAINT "Department_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
