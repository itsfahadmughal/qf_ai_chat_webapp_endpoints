import type { FastifyInstance } from "fastify";
import { FineTuneModelStatus, TrainingVectorStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import {
  collectTrainingExamplesForHotel
} from "../lib/training/examples.js";
import { syncTrainingExamplesToVectorStore } from "../lib/training/vectorStore.js";
import {
  refreshFineTuneJobsForHotel,
  resetFineTuneState,
  scheduleFineTuneUpload
} from "../lib/fineTuning.js";
import { getHotelOpenAIClient, getVectorStoresApi } from "../lib/openai.js";

function scopeIncludes(scope: string, value: "vector" | "fine-tune") {
  return scope === "all" || scope === value;
}

export async function trainingRoutes(app: FastifyInstance) {
  app.get("/training/status", { preHandler: app.authenticate }, async (req: any, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    if (!user?.hotelId) return reply.code(403).send({ error: "User has no hotel" });

    await refreshFineTuneJobsForHotel(user.hotelId).catch(() => {});

    const [exampleStats, totalExamples, latestJob, activeModel, vectorStore] = await Promise.all([
      prisma.trainingExample.groupBy({
        by: ["vectorStatus"],
        _count: { _all: true },
        where: { hotelId: user.hotelId }
      }),
      prisma.trainingExample.count({ where: { hotelId: user.hotelId } }),
      prisma.fineTuneJob.findFirst({
        where: { hotelId: user.hotelId },
        orderBy: { createdAt: "desc" }
      }),
      prisma.fineTuneModel.findFirst({
        where: { hotelId: user.hotelId, status: FineTuneModelStatus.active },
        orderBy: { activatedAt: "desc" }
      }),
      prisma.hotelVectorStore.findFirst({
        where: { hotelId: user.hotelId, isDefault: true },
        include: { department: { select: { id: true, name: true } } }
      })
    ]);

    const statusCounts: Record<TrainingVectorStatus, number> = {
      pending: 0,
      uploading: 0,
      uploaded: 0,
      failed: 0
    };
    for (const stat of exampleStats) {
      statusCounts[stat.vectorStatus as TrainingVectorStatus] = stat._count._all;
    }

    return {
      hotelId: user.hotelId,
      trainingExamples: {
        total: totalExamples,
        pending: statusCounts.pending,
        uploading: statusCounts.uploading,
        uploaded: statusCounts.uploaded,
        failed: statusCounts.failed
      },
      vectorStore: vectorStore
        ? {
            id: vectorStore.id,
            openaiId: vectorStore.openaiId,
            name: vectorStore.name,
            department: vectorStore.department
          }
        : null,
      latestJob,
      activeModel
    };
  });

  app.post("/training/sync", { preHandler: app.authenticate }, async (req: any, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    if (!user?.hotelId) return reply.code(403).send({ error: "User has no hotel" });

    const results: any = {};
    results.examples = await collectTrainingExamplesForHotel(user.hotelId);
    try {
      results.vector = await syncTrainingExamplesToVectorStore(user.hotelId);
    } catch (err) {
      results.vector = { error: String((err as any)?.message ?? err) };
    }

    await scheduleFineTuneUpload(user.hotelId).catch(() => {});

    return { ok: true, results };
  });

  app.post("/training/reset", { preHandler: app.authenticate }, async (req: any, reply) => {
    const Body = z
      .object({
        scope: z.enum(["all", "vector", "fine-tune"]).default("all")
      })
      .parse(req.body ?? {});

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { hotelId: true }
    });
    if (!user?.hotelId) return reply.code(403).send({ error: "User has no hotel" });

    if (scopeIncludes(Body.scope, "vector")) {
      const examples = await prisma.trainingExample.findMany({
        where: { hotelId: user.hotelId, vectorFileId: { not: null } },
        select: { vectorFileId: true }
      });

      try {
        const client = await getHotelOpenAIClient(user.hotelId);
        const store = await prisma.hotelVectorStore.findFirst({
          where: { hotelId: user.hotelId, isDefault: true }
        });
        if (store) {
          const vectorStores = getVectorStoresApi(client);
          for (const ex of examples) {
            if (!ex.vectorFileId) continue;
            try {
              if (typeof vectorStores.files.del === "function") {
                await vectorStores.files.del(store.openaiId, ex.vectorFileId);
              } else if (typeof vectorStores.files.delete === "function") {
                await vectorStores.files.delete(store.openaiId, ex.vectorFileId);
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore vector cleanup failure
      }

      await prisma.trainingExample.deleteMany({ where: { hotelId: user.hotelId } });
      await prisma.message.updateMany({
        where: { conversation: { hotelId: user.hotelId } },
        data: { includedInTraining: false }
      });
    }

    if (scopeIncludes(Body.scope, "fine-tune")) {
      await resetFineTuneState(user.hotelId);
    }

    return { ok: true };
  });
}
