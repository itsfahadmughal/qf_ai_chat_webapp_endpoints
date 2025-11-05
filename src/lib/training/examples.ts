import { TrainingExampleSource, TrainingVectorStatus } from "@prisma/client";
import { prisma } from "../../db.js";

type CollectOptions = {
  limit?: number;
};

function reactionScore(reaction: "like" | "dislike" | null | undefined): number | null {
  if (reaction === "like") return 1;
  if (reaction === "dislike") return -1;
  return null;
}

export async function collectTrainingExamplesForHotel(
  hotelId: string,
  opts: CollectOptions = {}
): Promise<{ created: number; updated: number }> {
  const limit = opts.limit ?? 200;

  const likedAssistantMessages = await prisma.message.findMany({
    where: {
      conversation: { hotelId },
      role: "assistant",
      MessageFeedback: { some: { reaction: "like" } }
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      MessageFeedback: {
        where: { reaction: "like" },
        select: { reaction: true, createdAt: true },
        orderBy: { createdAt: "desc" }
      }
    }
  });

  let created = 0;
  let updated = 0;

  for (const message of likedAssistantMessages) {
    const latestUserMessage = await prisma.message.findFirst({
      where: {
        conversationId: message.conversationId,
        createdAt: { lt: message.createdAt },
        role: "user"
      },
      orderBy: { createdAt: "desc" }
    });

    if (!latestUserMessage) continue;

    const feedbackReaction = message.MessageFeedback.at(0)?.reaction ?? null;
    const qualityScore = message.qualityScore ?? reactionScore(feedbackReaction) ?? 1;
    const metadata = {
      conversationId: message.conversationId,
      messageId: message.id
    };

    const payload = {
      hotelId,
      source: TrainingExampleSource.conversation,
      messageId: message.id,
      inputText: latestUserMessage.content,
      outputText: message.content,
      score: qualityScore,
      metadata
    };

    const existing = await prisma.trainingExample.findUnique({
      where: { messageId: message.id }
    });

    if (existing) {
      await prisma.trainingExample.update({
        where: { id: existing.id },
        data: {
          inputText: payload.inputText,
          outputText: payload.outputText,
          score: payload.score,
          metadata: payload.metadata,
          vectorStatus:
            existing.vectorStatus === TrainingVectorStatus.uploaded
              ? TrainingVectorStatus.uploaded
              : TrainingVectorStatus.pending
        }
      });
      updated += 1;
    } else {
      await prisma.trainingExample.create({
        data: {
          ...payload,
          vectorStatus: TrainingVectorStatus.pending
        }
      });
      created += 1;
    }

    await prisma.message.update({
      where: { id: message.id },
      data: {
        qualityScore,
        feedbackAt: message.MessageFeedback.at(0)?.createdAt ?? message.createdAt,
        includedInTraining: true
      }
    });
  }

  return { created, updated };
}
