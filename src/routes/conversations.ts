import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";

const CreateConv = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  provider: z.enum(["openai", "deepseek", "perplexity"]).optional()
});

export async function conversationRoutes(app: FastifyInstance) {
  app.post("/conversations", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { title, model, provider } = CreateConv.parse(req.body ?? {});

    // Load user to get hotelId (JWT usually only has id/email)
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, hotelId: true }
    });
    if (!user) return reply.code(401).send({ error: "User not found" });

    // Create with nested connects (avoids needing userId/hotelId scalar fields)
    const conv = await prisma.conversation.create({
      data: {
        title: title ?? "New chat",
        provider: (provider ?? "openai") as any,
        model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        user:  { connect: { id: user.id } },
        hotel: { connect: { id: user.hotelId } }
      }
    });

    return conv;
  });

  app.get("/conversations", { preHandler: app.authenticate }, async (req: any) => {
    return prisma.conversation.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: "desc" }
    });
  });

  app.get("/conversations/:id/messages", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params as any;
    const conv = await prisma.conversation.findFirst({ where: { id, userId: req.user.id } });
    if (!conv) return reply.code(404).send({ error: "Not found" });
    return prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: "asc" } });
  });
}