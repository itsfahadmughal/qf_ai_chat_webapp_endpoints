-- CreateTable
CREATE TABLE "public"."HotelVectorStore" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "provider" "public"."Provider" NOT NULL DEFAULT 'openai',
    "openaiId" TEXT NOT NULL,
    "name" TEXT,
    "metadata" JSONB,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HotelVectorStore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HotelVectorStore_openaiId_key" ON "public"."HotelVectorStore"("openaiId");

-- CreateIndex
CREATE INDEX "HotelVectorStore_hotelId_idx" ON "public"."HotelVectorStore"("hotelId");

-- AddForeignKey
ALTER TABLE "public"."HotelVectorStore" ADD CONSTRAINT "HotelVectorStore_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
