import {
  FineTuneModelStatus,
  FineTuneStatus,
  Provider
} from "@prisma/client";
import { toFile } from "openai/uploads";
import { prisma } from "../db.js";
import { getHotelOpenAIClient, resolveHotelOpenAIConfig } from "./openai.js";

type LoggerLike = {
  info?: (obj: any, msg?: string) => void;
  warn?: (obj: any, msg?: string) => void;
  error?: (obj: any, msg?: string) => void;
};

const prismaAny = prisma as any;

function toISOString(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

async function buildFineTuneDataset(hotelId: string) {
  const [prompts, conversations, messages, messageFeedbacks, promptFeedbacks, trainingExamples] =
    await Promise.all([
      prismaAny.prompt.findMany({
        where: { hotelId },
        select: {
          id: true,
          title: true,
          body: true,
          tags: true,
          version: true,
          departmentId: true,
          archived: true,
          createdAt: true,
          updatedAt: true,
          qualityScore: true,
          feedbackCount: true
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
          qualityScore: true,
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
      }),
      prisma.trainingExample.findMany({
        where: { hotelId },
        select: {
          id: true,
          inputText: true,
          outputText: true,
          score: true,
          metadata: true,
          source: true,
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
        archived: prompt.archived,
        qualityScore: prompt.qualityScore ?? null,
        feedbackCount: prompt.feedbackCount ?? 0,
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
        qualityScore: message.qualityScore ?? null,
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

  for (const example of trainingExamples) {
    lines.push(
      JSON.stringify({
        type: "training_example",
        id: example.id,
        input: example.inputText,
        output: example.outputText,
        score: example.score ?? null,
        metadata: example.metadata ?? null,
        source: example.source,
        createdAt: toISOString(example.createdAt)
      })
    );
  }

  return lines;
}

function mapOpenAIStatus(status: string | null | undefined): FineTuneStatus {
  switch (status) {
    case "pending":
      return FineTuneStatus.pending;
    case "running":
      return FineTuneStatus.running;
    case "succeeded":
      return FineTuneStatus.succeeded;
    case "failed":
      return FineTuneStatus.failed;
    case "cancelled":
    case "canceled":
      return FineTuneStatus.canceled;
    default:
      return FineTuneStatus.running;
  }
}

export async function processFineTuneJob(jobId: string, logger?: LoggerLike) {
  const job = await prisma.fineTuneJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  const lines = await buildFineTuneDataset(job.hotelId);
  if (!lines.length) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: FineTuneStatus.canceled,
        error: "No training data available",
        completedAt: new Date()
      }
    });
    logger?.info?.({ hotelId: job.hotelId }, "fine tune skipped (no data)");
    return;
  }

  const cfg = await resolveHotelOpenAIConfig(job.hotelId);
  if (!cfg.apiKey) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: FineTuneStatus.failed,
        error: "OpenAI credential missing"
      }
    });
    logger?.warn?.({ hotelId: job.hotelId }, "fine tune skipped (missing credentials)");
    return;
  }

  let client;
  try {
    client = await getHotelOpenAIClient(job.hotelId);
  } catch (err) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: FineTuneStatus.failed,
        error: `Client init failed: ${String((err as any)?.message ?? err)}`
      }
    });
    logger?.warn?.({ err, hotelId: job.hotelId }, "fine tune client init failed");
    return;
  }

  const filename = `hotel-${job.hotelId}-fine-tune-${Date.now()}.jsonl`;
  const jsonl = lines.join("\n");
  const file = await toFile(Buffer.from(jsonl, "utf8"), filename, {
    type: "application/jsonl"
  });

  await prisma.fineTuneJob.update({
    where: { id: jobId },
    data: {
      status: FineTuneStatus.uploading,
      error: null,
      startedAt: new Date()
    }
  });

  let uploadedFileId: string | null = null;
  try {
    const uploadedFile = await client.files.create({
      purpose: "fine-tune",
      file
    });
    uploadedFileId = uploadedFile.id;
  } catch (err) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: FineTuneStatus.failed,
        error: `Upload failed: ${String((err as any)?.message ?? err)}`,
        completedAt: new Date()
      }
    });
    logger?.error?.({ err, hotelId: job.hotelId }, "fine tune dataset upload failed");
    return;
  }

  await prisma.fineTuneJob.update({
    where: { id: jobId },
    data: {
      datasetFileId: uploadedFileId ?? undefined
    }
  });

  try {
    const suffix = `hotel-${job.hotelId}-${Date.now()}`;
    const baseModel =
      process.env.FINE_TUNE_BASE_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-4o-mini";
    const remoteJob = await client.fineTuning.jobs.create({
      model: baseModel,
      training_file: uploadedFileId!,
      suffix
    } as any);

    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: mapOpenAIStatus(remoteJob.status),
        openaiJobId: remoteJob.id,
        resultingModel: remoteJob.fine_tuned_model ?? null,
        error: remoteJob.error ? JSON.stringify(remoteJob.error) : null
      }
    });

    if (remoteJob.fine_tuned_model) {
      await activateFineTuneModel(job.hotelId, remoteJob.fine_tuned_model, jobId, remoteJob);
    }
  } catch (err) {
    await prisma.fineTuneJob.update({
      where: { id: jobId },
      data: {
        status: FineTuneStatus.failed,
        error: `Job create failed: ${String((err as any)?.message ?? err)}`,
        completedAt: new Date()
      }
    });
    logger?.error?.({ err, hotelId: job.hotelId }, "fine tune job create failed");
  }
}

async function activateFineTuneModel(
  hotelId: string,
  modelId: string,
  jobId: string,
  metadata: unknown
) {
  const now = new Date();
  const metadataJson =
    metadata != null ? JSON.parse(JSON.stringify(metadata)) : null;

  const model = await prisma.fineTuneModel.upsert({
    where: {
      hotelId_provider_modelId: {
        hotelId,
        provider: Provider.openai,
        modelId
      }
    },
    update: {
      status: FineTuneModelStatus.active,
      activatedAt: now,
      metadata: metadataJson
    },
    create: {
      hotelId,
      provider: Provider.openai,
      jobId,
      modelId,
      status: FineTuneModelStatus.active,
      metadata: metadataJson,
      activatedAt: now
    }
  });

  await prisma.fineTuneModel.updateMany({
    where: {
      hotelId,
      provider: Provider.openai,
      status: FineTuneModelStatus.active,
      id: { not: model.id }
    },
    data: {
      status: FineTuneModelStatus.retired,
      deactivatedAt: now
    }
  });

  await prisma.hotelProviderToggle.upsert({
    where: { hotelId_provider: { hotelId, provider: Provider.openai } },
    update: { defaultModel: model.modelId },
    create: { hotelId, provider: Provider.openai, isEnabled: true, defaultModel: model.modelId }
  });
}

export async function scheduleFineTuneUpload(hotelId: string, logger?: LoggerLike) {
  const existing = await prisma.fineTuneJob.findFirst({
    where: {
      hotelId,
      status: { in: [FineTuneStatus.pending, FineTuneStatus.uploading, FineTuneStatus.running] }
    }
  });
  if (existing) {
    logger?.info?.({ hotelId }, "fine tune job already in progress");
    return existing;
  }

  const job = await prisma.fineTuneJob.create({
    data: {
      hotelId,
      provider: Provider.openai,
      status: FineTuneStatus.pending
    }
  });

  processFineTuneJob(job.id, logger).catch((err) => {
    logger?.error?.({ err, hotelId }, "fine tune job processing failed");
  });

  return job;
}

export async function refreshFineTuneJobsForHotel(hotelId: string, logger?: LoggerLike) {
  const jobs = await prisma.fineTuneJob.findMany({
    where: {
      hotelId,
      status: { in: [FineTuneStatus.uploading, FineTuneStatus.running] },
      openaiJobId: { not: null }
    }
  });
  if (!jobs.length) return;

  const client = await getHotelOpenAIClient(hotelId);

  for (const job of jobs) {
    try {
      const remote = await client.fineTuning.jobs.retrieve(job.openaiJobId!);
      const status = mapOpenAIStatus(remote.status);
      const data: any = {
        status,
        error: remote.error ? JSON.stringify(remote.error) : null
      };
      if (remote.fine_tuned_model) {
        data.resultingModel = remote.fine_tuned_model;
        data.completedAt = new Date();
        await activateFineTuneModel(hotelId, remote.fine_tuned_model, job.id, remote);
      }
      await prisma.fineTuneJob.update({
        where: { id: job.id },
        data
      });
    } catch (err) {
      logger?.warn?.({ err, jobId: job.id }, "fine tune job status update failed");
    }
  }
}

export async function resetFineTuneState(hotelId: string) {
  await prisma.$transaction([
    prisma.fineTuneModel.updateMany({
      where: { hotelId, status: FineTuneModelStatus.active },
      data: { status: FineTuneModelStatus.retired, deactivatedAt: new Date() }
    }),
    prisma.fineTuneJob.updateMany({
      where: { hotelId, status: { not: FineTuneStatus.succeeded } },
      data: { status: FineTuneStatus.canceled }
    }),
    prisma.hotelProviderToggle.updateMany({
      where: { hotelId, provider: Provider.openai },
      data: { defaultModel: null }
    })
  ]);
}
