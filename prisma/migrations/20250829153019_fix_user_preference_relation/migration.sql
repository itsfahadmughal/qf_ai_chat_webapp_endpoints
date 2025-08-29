/*
  Warnings:

  - You are about to drop the column `abEnabled` on the `UserPreference` table. All the data in the column will be lost.
  - You are about to drop the column `modelA` on the `UserPreference` table. All the data in the column will be lost.
  - You are about to drop the column `modelB` on the `UserPreference` table. All the data in the column will be lost.
  - You are about to drop the column `providerA` on the `UserPreference` table. All the data in the column will be lost.
  - You are about to drop the column `providerB` on the `UserPreference` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."UserPreference" DROP COLUMN "abEnabled",
DROP COLUMN "modelA",
DROP COLUMN "modelB",
DROP COLUMN "providerA",
DROP COLUMN "providerB",
ADD COLUMN     "defaultProvider" "public"."Provider",
ADD COLUMN     "enabledProviders" "public"."Provider"[] DEFAULT ARRAY[]::"public"."Provider"[],
ADD COLUMN     "modelDeepseek" TEXT,
ADD COLUMN     "modelOpenAI" TEXT,
ADD COLUMN     "modelPerplexity" TEXT;
