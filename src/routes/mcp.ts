// src/routes/mcp.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { mcpManager } from "../mcp/manager.js";
import { decryptSecret } from "../crypto/secrets.js";
import { sanitizeToolsResponse } from "../mcp/sanitizeToolSchema.js";

const CreateServerSchema = z.object({
  hotelId: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(["stdio", "http", "remote"]).default("stdio"),
  command: z.string().optional(), // for stdio
  args: z.array(z.string()).optional(), // for stdio
  url: z.string().url().optional(), // for http/remote
  isActive: z.boolean().default(true)
});

export async function mcpRoutes(app: FastifyInstance) {
  async function getHotelId(req: any) {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    return me?.hotelId ?? null;
  }

  // Helper: inject Brevo API key from BYOK table (if missing in args)
  async function injectBrevoKey(hotelId: string, args: Record<string, unknown>) {
    if ((args as any)?.apiKey) return args;
    const cred = await prisma.hotelProviderCredential.findUnique({
      where: { hotelId_provider: { hotelId, provider: "brevo" as any } },
      select: { encKey: true, iv: true, tag: true, isActive: true }
    });
    if (!cred || !cred.isActive) {
      throw new Error("No active Brevo credential configured for this hotel");
    }
    const apiKey = decryptSecret(
      cred.encKey as unknown as Buffer,
      cred.iv as unknown as Buffer,
      cred.tag as unknown as Buffer
    );
    return { ...args, apiKey };
  }

  // CREATE (server belongs to provided hotel)
  app.post("/mcp/servers", async (req: any, reply) => {
    const body = CreateServerSchema.parse(req.body ?? {});
    const hotelId = body.hotelId;

    const row = await prisma.mCPServer.create({
      data: {
        hotelId,
        name: body.name,
        transport: body.transport,
        command: body.command,
        args: body.args,
        url: body.url,
        isActive: body.isActive
      }
    });

    if (row.isActive) { try { await mcpManager.listTools(row.id); } catch {} }
    return row;
  });

  // LIST (my hotel)
  app.get("/mcp/servers", { preHandler: (app as any).authenticate }, async (req: any) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return { error: "User has no hotelId" };
    return prisma.mCPServer.findMany({
      where: { hotelId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, transport: true, command: true, args: true, url: true,
        isActive: true, createdAt: true, updatedAt: true
      }
    });
  });

  // OPTIONAL admin list by hotel...
  app.get("/admin/hotels/:hotelId/mcp/servers", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    // if (req.user.role !== 'admin') return reply.code(403).send({ error: "Forbidden" });
    const { hotelId } = req.params as { hotelId: string };
    return prisma.mCPServer.findMany({ where: { hotelId }, orderBy: { createdAt: "desc" } });
  });

  // GET TOOLS
  app.get("/mcp/servers/:id/tools", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const hid = hotelId as string;
    const { id } = req.params as { id: string };
    const row = await prisma.mCPServer.findFirst({ where: { id, hotelId:hid } });
    if (!row) return reply.code(404).send({ error: "Server not found" });
    try {
      const raw = await mcpManager.listTools(id);
      const tools = sanitizeToolsResponse(raw.tools);
      return tools;
    } catch (e: any) {
      return reply.code(500).send({ error: "mcp_list_error", details: String(e?.message ?? e) });
    }
  });

  // EXECUTE TOOL (auto-inject Brevo API key from BYOK if needed)
  app.post("/tools/execute", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const Body = z.object({
      serverId: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      conversationId: z.string().optional()
    });
    const { serverId, tool, arguments: argsRaw, conversationId } = Body.parse(req.body ?? {});
    const srv = await prisma.mCPServer.findFirst({
      where: { id: serverId, hotelId, isActive: true }
    });
    if (!srv) return reply.code(404).send({ error: "MCP server not found for this hotel" });

    let args = argsRaw as Record<string, unknown>;
    if (tool.startsWith("brevo.")) {
      try {
        args = await injectBrevoKey(hotelId, args);
      } catch (e: any) {
        return reply
          .code(400)
          .send({ error: "brevo_credential_missing", details: String(e?.message ?? e) });
      }
    }

    try {
      const out = await mcpManager.callTool(serverId, tool, args);

      let toolMessageId: string | undefined;
      if (conversationId) {
        const conv = await prisma.conversation.findFirst({
          where: { id: conversationId, hotelId }
        });
        if (!conv) {
          return reply.code(404).send({ error: "conversation_not_found" });
        }
        const rendered =
          typeof (out as any)?.content?.[0]?.text === "string"
            ? (out as any).content[0].text
            : JSON.stringify(out, null, 2).slice(0, 4000);
        const labeled = `TOOL ${tool} RESULT:\n${rendered}`;
        const message = await prisma.message.create({
          data: {
            conversationId,
            role: "tool",
            content: labeled,
            provider: conv.provider,
            model: conv.model
          },
          select: { id: true }
        });
        toolMessageId = message.id;
      }

      return { toolMessageId, result: out };
    } catch (e: any) {
      return reply.code(500).send({ error: "tool_error", details: String(e?.message ?? e) });
    }
  });

  // ENABLE / DISABLE / STATUS / DELETE
  app.patch("/mcp/servers/:id/enable", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req); const { id } = req.params as { id: string };
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const hid = hotelId as string;
    const row = await prisma.mCPServer.findFirst({ where: { id, hotelId:hid } });
    if (!row) return reply.code(404).send({ error: "Server not found" });
    const updated = await prisma.mCPServer.update({ where: { id }, data: { isActive: true } });
    try { await mcpManager.listTools(id); } catch {}
    return updated;
  });

  app.patch("/mcp/servers/:id/disable", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req); const { id } = req.params as { id: string };
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const hid = hotelId as string;
    const row = await prisma.mCPServer.findFirst({ where: { id, hotelId:hid } });
    if (!row) return reply.code(404).send({ error: "Server not found" });
    const updated = await prisma.mCPServer.update({ where: { id }, data: { isActive: false } });
    await mcpManager.close(id);
    return { ...updated, closed: true };
  });

  app.get("/mcp/servers/:id/status", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req); const { id } = req.params as { id: string };
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const hid = hotelId as string;
    const s = await prisma.mCPServer.findFirst({ where: { id, hotelId:hid } });
    if (!s) return reply.code(404).send({ error: "Server not found" });
    let alive = false, toolsCount: number | undefined, error: string | undefined;
    if (s.isActive) {
      try { const tools = await mcpManager.listTools(id); alive = true; toolsCount = (tools as any)?.tools?.length; }
      catch (e: any) { error = String(e?.message ?? e); }
    }
    return { isActive: s.isActive, alive, toolsCount, error };
  });

  app.delete("/mcp/servers/:id", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req); const { id } = req.params as { id: string };
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });
    const hid = hotelId as string;
    const row = await prisma.mCPServer.findFirst({ where: { id, hotelId:hid } });
    if (!row) return reply.code(404).send({ error: "Server not found" });
    await mcpManager.close(id);
    await prisma.mCPServer.delete({ where: { id } });
    return { ok: true };
  });
}
