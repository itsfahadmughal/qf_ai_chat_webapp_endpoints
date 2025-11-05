import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { collectTrainingExamplesForHotel } from "../lib/training/examples.js";
import { syncTrainingExamplesToVectorStore } from "../lib/training/vectorStore.js";
import { scheduleFineTuneUpload } from "../lib/fineTuning.js";

const ReactionEnum = z.enum(["like", "dislike"]);
const SetFeedbackBody = z.object({
  reaction: z.union([ReactionEnum, z.literal("none")]), // "none" = clear feedback
  reason: z.string().max(50).optional(),
  comment: z.string().max(500).optional()
});

export async function feedbackRoutes(app: FastifyInstance) {
  // helper to ensure the message belongs to this user (via conversation.owner)
  async function assertOwnAssistantMessage(messageId: string, userId: string) {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        role: true,
        conversation: { select: { userId: true, hotelId: true } }
      }
    });
    if (!msg) return { error: { code: 404, msg: "Message not found" } };
    if (msg.conversation.userId !== userId) return { error: { code: 403, msg: "Forbidden" } };
    if (msg.role !== "assistant") return { error: { code: 400, msg: "Only assistant messages can be rated" } };
    return { ok: true, message: msg };
  }

  // Set or clear feedback
  app.post("/messages/:id/feedback", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const { reaction, reason, comment } = SetFeedbackBody.parse(req.body ?? {});

    const check = await assertOwnAssistantMessage(id, req.user.id);
    const err = (check as any).error;
    if (err) return reply.code(err.code).send({ error: err.msg });

    const hotelId = (check as any).message?.conversation?.hotelId as string | undefined;

    if (reaction === "none") {
      await prisma.messageFeedback.deleteMany({
        where: { messageId: id, userId: req.user.id }
      });
      await prisma.message.update({
        where: { id },
        data: {
          qualityScore: null,
          feedbackAt: new Date(),
          includedInTraining: false
        }
      });
      await prisma.trainingExample.deleteMany({ where: { messageId: id } });
      return { ok: true, reaction: null };
    }

    const saved = await prisma.messageFeedback.upsert({
      where: { messageId_userId: { messageId: id, userId: req.user.id } },
      create: { messageId: id, userId: req.user.id, reaction: reaction as any, reason, comment },
      update: { reaction: reaction as any, reason, comment }
    });

    const qualityScore = reaction === "like" ? 1 : reaction === "dislike" ? -1 : null;
    await prisma.message.update({
      where: { id },
      data: {
        qualityScore,
        feedbackAt: new Date(),
        includedInTraining: reaction === "like"
      }
    });

    if (hotelId && reaction === "like") {
      collectTrainingExamplesForHotel(hotelId)
        .then(() => syncTrainingExamplesToVectorStore(hotelId).catch(() => {}))
        .then(() => scheduleFineTuneUpload(hotelId).catch(() => {}))
        .catch(() => {});
    }

    return { ok: true, reaction: saved.reaction, reason: saved.reason ?? null, comment: saved.comment ?? null };
  });

  // Get counts (+ your own reaction)
  app.get("/messages/:id/feedback", { preHandler: (app as any).authenticate }, async (req: any, reply) => {
    const { id } = req.params as { id: string };

    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, conversation: { select: { userId: true } } }
    });
    if (!msg) return reply.code(404).send({ error: "Message not found" });
    if (msg.conversation.userId !== req.user.id) return reply.code(403).send({ error: "Forbidden" });

    const [likes, dislikes, mine] = await Promise.all([
      prisma.messageFeedback.count({ where: { messageId: id, reaction: "like" as any } }),
      prisma.messageFeedback.count({ where: { messageId: id, reaction: "dislike" as any } }),
      prisma.messageFeedback.findUnique({ where: { messageId_userId: { messageId: id, userId: req.user.id } } })
    ]);

    return {
      messageId: id,
      likeCount: likes,
      dislikeCount: dislikes,
      myReaction: mine?.reaction ?? null,
      myReason: mine?.reason ?? null,
      myComment: mine?.comment ?? null
    };
  });
}
