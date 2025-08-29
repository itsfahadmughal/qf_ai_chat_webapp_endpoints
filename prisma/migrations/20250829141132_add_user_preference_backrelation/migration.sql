-- CreateTable
CREATE TABLE "public"."UserPreference" (
    "userId" TEXT NOT NULL,
    "abEnabled" BOOLEAN NOT NULL DEFAULT false,
    "modelA" TEXT,
    "providerA" "public"."Provider",
    "modelB" TEXT,
    "providerB" "public"."Provider",
    "locale" TEXT,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "public"."UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
