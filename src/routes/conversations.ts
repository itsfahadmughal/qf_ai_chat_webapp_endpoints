import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { scheduleFineTuneUpload } from "../lib/fineTuning.js";

const prismaAny = prisma as any;
const MEMORY_MESSAGE_ROLE = "memory";

const CreateConv = z.object({
  title: z.string().optional(),
  model: z.string().optional(),
  provider: z.enum(["openai", "deepseek", "perplexity"]).optional(),
  promptId: z.string().nullable().optional()
});

export async function conversationRoutes(app: FastifyInstance) {
  app.post("/conversations", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { title, model, provider, promptId: rawPromptId } = CreateConv.parse(req.body ?? {});

    // Load user to get hotelId (JWT usually only has id/email)
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, hotelId: true }
    });
    if (!user) return reply.code(401).send({ error: "User not found" });

    let promptId: string | null = null;
    if (rawPromptId) {
      const prompt = await prisma.prompt.findFirst({
        where: { id: rawPromptId, hotelId: user.hotelId },
        select: { id: true }
      });
      if (!prompt) {
        return reply.code(400).send({ error: "Invalid promptId for this hotel" });
      }
      promptId = prompt.id;
    }

    // Create with nested connects (avoids needing userId/hotelId scalar fields)
    const conv = await prismaAny.conversation.create({
      data: {
        title: title ?? "New chat",
        provider: (provider ?? "openai") as any,
        model: model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        user:  { connect: { id: user.id } },
        hotel: { connect: { id: user.hotelId } },
        prompt: promptId ? { connect: { id: promptId } } : undefined
      }
    });

    scheduleFineTuneUpload(user.hotelId, req.log);

    return conv;
  });

  app.get("/conversations", { preHandler: app.authenticate }, async (req: any) => {
    return prismaAny.conversation.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: "desc" }
    });
  });

  app.get("/conversations/by-prompt/:promptId", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { promptId } = req.params as { promptId: string };

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    if (!user) return reply.code(401).send({ error: "User not found" });

    const prompt = await (prisma as any).prompt.findFirst({
      where: { id: promptId, hotelId: user.hotelId },
      select: { id: true }
    });
    if (!prompt) return reply.code(404).send({ error: "Prompt not found" });

    return prismaAny.conversation.findMany({
      where: { hotelId: user.hotelId, promptId },
      orderBy: { updatedAt: "desc" }
    });
  });

  app.get("/conversations/:id/messages", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params as any;
    const conv = await prismaAny.conversation.findFirst({ where: { id, userId: req.user.id } });
    if (!conv) return reply.code(404).send({ error: "Not found" });
    const messagesRaw = await prisma.message.findMany({
      where: { conversationId: id, NOT: { role: MEMORY_MESSAGE_ROLE } },
      orderBy: { createdAt: "asc" }
    });

    const messages = messagesRaw.map(m => ({
      ...m,
      provider: m.provider ?? conv.provider,
      model: m.model ?? conv.model
    }));

    return { conversation: conv, messages };

  });
}
