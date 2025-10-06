/*
  Warnings:

  - A unique constraint covering the columns `[hotelId,name]` on the table `PromptCategory` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `hotelId` to the `PromptCategory` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."PromptCategory_name_key";

-- AlterTable
ALTER TABLE "public"."PromptCategory" ADD COLUMN     "hotelId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PromptCategory_hotelId_name_key" ON "public"."PromptCategory"("hotelId", "name");

-- AddForeignKey
ALTER TABLE "public"."PromptCategory" ADD CONSTRAINT "PromptCategory_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
