// src/routes/mcp.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { mcpManager } from "../mcp/manager.js";

const CreateServerSchema = z.object({
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  isActive: z.boolean().default(true),
  // Keeping env allowed for future, but we ignore it for now (no crypto needed)
  env: z.record(z.string(), z.string()).optional()
});

export async function mcpRoutes(app: FastifyInstance) {
  // helper to get the caller's hotelId from DB
  async function getHotelId(req: any) {
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    return me?.hotelId;
  }

  // Create MCP server config (per hotel)
  app.post("/mcp/servers", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });

    const body = CreateServerSchema.parse(req.body ?? {});
    const row = await prisma.mCPServer.create({
      data: {
        hotelId,
        name: body.name,
        transport: body.transport,
        command: body.command,
        args: body.args ?? [],
        url: body.url,
        isActive: body.isActive,
        // envEnc: null // ignoring encrypted env for now
      }
    });
    return row;
  });

  // List MCP servers for this hotel
  app.get("/mcp/servers", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });

    return prisma.mCPServer.findMany({ where: { hotelId } });
  });

  // Discover tools on a server
  app.get("/mcp/servers/:id/tools", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });

    const { id } = req.params as { id: string };
    const server = await prisma.mCPServer.findFirst({ where: { id, hotelId, isActive: true } });
    if (!server) return reply.code(404).send({ error: "Server not found" });

    const tools = await mcpManager.listTools(id);
    return tools;
  });

  // Execute a tool and log the call
  app.post("/tools/execute", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const hotelId = await getHotelId(req);
    if (!hotelId) return reply.code(400).send({ error: "User has no hotelId" });

    const Body = z.object({
      serverId: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).default({}),
      conversationId: z.string().optional()
    }).parse(req.body ?? {});

    const server = await prisma.mCPServer.findFirst({
      where: { id: Body.serverId, hotelId, isActive: true }
    });
    if (!server) return reply.code(404).send({ error: "Server not found" });

    const started = Date.now();
    try {
      const res = await mcpManager.callTool(Body.serverId, Body.tool, Body.arguments);
      const contentText = res?.content?.[0]?.text ?? "";
      const resultJson = tryJson(contentText);

      await prisma.toolCallLog.create({
        data: {
          hotelId,
          userId: req.user.id,
          conversationId: Body.conversationId ?? null,
          serverId: server.id,
          toolName: Body.tool,
          args: Body.arguments,
          result: resultJson ?? { text: contentText },
          status: "ok",
          startedAt: new Date(started),
          finishedAt: new Date(),
          durationMs: Date.now() - started
        }
      });

      return { ok: true, content: res.content ?? [], tool: Body.tool, raw: res };
    } catch (err: any) {
      await prisma.toolCallLog.create({
        data: {
          hotelId,
          userId: req.user.id,
          conversationId: Body.conversationId ?? null,
          serverId: Body.serverId,
          toolName: Body.tool,
          args: Body.arguments,
          error: String(err?.message ?? err),
          status: "error",
          startedAt: new Date(started),
          finishedAt: new Date(),
          durationMs: Date.now() - started
        }
      });
      return reply.code(500).send({ error: "tool_error", details: String(err?.message ?? err) });
    }
  });
}

function tryJson(t?: string) {
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}
