-- CreateTable
CREATE TABLE "public"."HotelProviderCredential" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "provider" "public"."Provider" NOT NULL,
    "encKey" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "baseUrl" TEXT,
    "label" TEXT,
    "last4" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelProviderCredential_hotelId_provider_key" ON "public"."HotelProviderCredential"("hotelId", "provider");

-- AddForeignKey
ALTER TABLE "public"."HotelProviderCredential" ADD CONSTRAINT "HotelProviderCredential_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
