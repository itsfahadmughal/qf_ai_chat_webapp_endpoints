/*
  Warnings:

  - You are about to drop the column `assignedUserId` on the `Prompt` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Prompt" DROP CONSTRAINT "Prompt_assignedUserId_fkey";

-- DropIndex
DROP INDEX "public"."Prompt_assignedUserId_idx";

-- AlterTable
ALTER TABLE "public"."Prompt" DROP COLUMN "assignedUserId";

-- CreateTable
CREATE TABLE "public"."_PromptAssignedUser" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromptAssignedUser_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_PromptAssignedUser_B_index" ON "public"."_PromptAssignedUser"("B");

-- AddForeignKey
ALTER TABLE "public"."_PromptAssignedUser" ADD CONSTRAINT "_PromptAssignedUser_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."Prompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_PromptAssignedUser" ADD CONSTRAINT "_PromptAssignedUser_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
