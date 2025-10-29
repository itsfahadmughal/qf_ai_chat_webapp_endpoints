import { prisma } from "../db.js";
import { toFile } from "openai/uploads";
import { getHotelOpenAIClient, resolveHotelOpenAIConfig } from "./openai.js";

const prismaAny = prisma as any;

type LoggerLike = {
  info?: (obj: any, msg?: string) => void;
  warn?: (obj: any, msg?: string) => void;
  error?: (obj: any, msg?: string) => void;
};

function toISOString(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

async function buildFineTuneDataset(hotelId: string) {
  const [prompts, conversations, messages, messageFeedbacks, promptFeedbacks] = await Promise.all([
    prismaAny.prompt.findMany({
      where: { hotelId },
      select: {
        id: true,
        title: true,
        body: true,
        tags: true,
        version: true,
        departmentId: true,
        assignedUsers: { select: { id: true } },
        archived: true,
        createdAt: true,
        updatedAt: true
      }
    }),
    prismaAny.conversation.findMany({
      where: { hotelId },
      select: {
        id: true,
        userId: true,
        promptId: true,
        provider: true,
        model: true,
        archived: true,
        createdAt: true,
        updatedAt: true
      }
    }),
    prismaAny.message.findMany({
      where: { conversation: { hotelId } },
      select: {
        id: true,
        conversationId: true,
        role: true,
        content: true,
        createdAt: true,
        conversation: { select: { promptId: true } }
      }
    }),
    prismaAny.messageFeedback.findMany({
      where: { message: { conversation: { hotelId } } },
      select: {
        id: true,
        messageId: true,
        userId: true,
        reaction: true,
        reason: true,
        comment: true,
        createdAt: true
      }
    }),
    prismaAny.promptFeedback.findMany({
      where: { prompt: { hotelId } },
      select: {
        id: true,
        promptId: true,
        userId: true,
        feedbackScore: true,
        reaction: true,
        createdAt: true
      }
    })
  ]);

  const lines: string[] = [];

  for (const prompt of prompts) {
    lines.push(
      JSON.stringify({
        type: "prompt",
        id: prompt.id,
        title: prompt.title,
        body: prompt.body,
        tags: prompt.tags,
        version: prompt.version,
        departmentId: prompt.departmentId ?? null,
        assignedUserIds: Array.isArray(prompt.assignedUsers)
          ? prompt.assignedUsers.map((user: any) => user.id)
          : [],
        archived: prompt.archived,
        createdAt: toISOString(prompt.createdAt),
        updatedAt: toISOString(prompt.updatedAt)
      })
    );
  }

  for (const conversation of conversations) {
    lines.push(
      JSON.stringify({
        type: "conversation",
        id: conversation.id,
        userId: conversation.userId,
        promptId: conversation.promptId ?? null,
        provider: conversation.provider,
        model: conversation.model,
        archived: conversation.archived,
        createdAt: toISOString(conversation.createdAt),
        updatedAt: toISOString(conversation.updatedAt)
      })
    );
  }

  for (const message of messages) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: message.id,
        conversationId: message.conversationId,
        promptId: message.conversation?.promptId ?? null,
        role: message.role,
        content: message.content,
        createdAt: toISOString(message.createdAt)
      })
    );
  }

  for (const feedback of messageFeedbacks) {
    lines.push(
      JSON.stringify({
        type: "message_feedback",
        id: feedback.id,
        messageId: feedback.messageId,
        userId: feedback.userId,
        reaction: feedback.reaction,
        reason: feedback.reason ?? null,
        comment: feedback.comment ?? null,
        createdAt: toISOString(feedback.createdAt)
      })
    );
  }

  for (const feedback of promptFeedbacks) {
    lines.push(
      JSON.stringify({
        type: "prompt_feedback",
        id: feedback.id,
        promptId: feedback.promptId,
        userId: feedback.userId,
        feedbackScore: feedback.feedbackScore,
        reaction: feedback.reaction ?? null,
        createdAt: toISOString(feedback.createdAt)
      })
    );
  }

  return lines;
}

export async function uploadFineTuneDatasetForHotel(hotelId: string, logger?: LoggerLike) {
  const lines = await buildFineTuneDataset(hotelId);
  if (!lines.length) {
    logger?.info?.({ hotelId }, "fine tune dataset skipped (no data)");
    return;
  }

  const cfg = await resolveHotelOpenAIConfig(hotelId);
  if (!cfg.apiKey) {
    logger?.warn?.({ hotelId }, "fine tune dataset skipped (no OpenAI credentials)");
    return;
  }

  let client;
  try {
    client = await getHotelOpenAIClient(hotelId);
  } catch (err) {
    logger?.warn?.({ err, hotelId }, "fine tune dataset skipped (client init failed)");
    return;
  }

  const filename = `hotel-${hotelId}-fine-tune-${Date.now()}.jsonl`;
  const jsonl = lines.join("\n");
  const file = await toFile(Buffer.from(jsonl, "utf8"), filename, { type: "application/jsonl" });

  try {
    await client.files.create({
      purpose: "fine-tune",
      file
    });
    logger?.info?.({ hotelId, lines: lines.length }, "fine tune dataset uploaded");
  } catch (err) {
    logger?.error?.({ err, hotelId }, "fine tune dataset upload failed");
  }
}

export function scheduleFineTuneUpload(hotelId: string, logger?: LoggerLike) {
  uploadFineTuneDatasetForHotel(hotelId, logger).catch((err) => {
    logger?.error?.({ err, hotelId }, "fine tune dataset upload encountered error");
  });
}
