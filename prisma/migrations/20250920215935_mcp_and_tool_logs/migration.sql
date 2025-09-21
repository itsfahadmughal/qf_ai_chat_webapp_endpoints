-- CreateTable
CREATE TABLE "public"."MCPServer" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "command" TEXT,
    "args" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "url" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "envEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MCPServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ToolCallLog" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "serverId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ToolCallLog_hotelId_idx" ON "public"."ToolCallLog"("hotelId");

-- CreateIndex
CREATE INDEX "ToolCallLog_serverId_idx" ON "public"."ToolCallLog"("serverId");

-- CreateIndex
CREATE INDEX "ToolCallLog_conversationId_idx" ON "public"."ToolCallLog"("conversationId");

-- AddForeignKey
ALTER TABLE "public"."MCPServer" ADD CONSTRAINT "MCPServer_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "public"."Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallLog" ADD CONSTRAINT "ToolCallLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "public"."MCPServer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallLog" ADD CONSTRAINT "ToolCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallLog" ADD CONSTRAINT "ToolCallLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
