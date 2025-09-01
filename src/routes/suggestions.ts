import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getComposerSuggestions, getPostReplySuggestions, resolveSuggestion } from "../suggestions/engine.js";
import { prisma } from "../db.js";

export async function suggestionsRoutes(app: FastifyInstance) {
  app.get("/suggestions", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const Q = z.object({
      mode: z.enum(["composer", "afterReply"]).default("composer"),
      conversationId: z.string().optional(),
      locale: z.string().optional(),
      category: z.enum(["writing","translate","summarize","brainstorm","planning","coding","data"]).optional(),
      limit: z.coerce.number().min(1).max(12).optional(),
      q: z.string().optional()
    }).parse(req.query ?? {});
    const locale = Q.locale ?? "en";

    if (Q.mode === "composer") {
      const suggestions = getComposerSuggestions(locale, { category: Q.category, limit: Q.limit ?? 8, q: Q.q });
      return { suggestions };
    }

    if (!Q.conversationId) return reply.code(400).send({ error: "conversationId is required for mode=afterReply" });

    const lastAssistant = await prisma.message.findFirst({
      where: { conversationId: Q.conversationId, role: "assistant" },
      orderBy: { createdAt: "desc" },
      select: { content: true }
    });

    const suggestions = getPostReplySuggestions(lastAssistant?.content ?? "", locale, Q.limit ?? 3);
    return { suggestions };
  });

  app.post("/suggestions/resolve", { preHandler: (app as any).authenticate }, async (req: any) => {
    const B = z.object({
      key: z.string(),
      template: z.string(),
      requires: z.array(z.enum(["TEXT", "LANG"])).optional(),
      vars: z.record(z.string(), z.string()).default({})
    }).parse(req.body ?? {});
    const prompt = resolveSuggestion({ key: B.key, label: "", template: B.template, requires: B.requires }, B.vars);
    return { prompt };
  });
}
