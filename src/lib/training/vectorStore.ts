import { TrainingVectorStatus } from "@prisma/client";
import { toFile } from "openai/uploads";
import { prisma } from "../../db.js";
import { getHotelOpenAIClient, getVectorStoresApi } from "../openai.js";

async function resolveHotelVectorStore(hotelId: string) {
  const existing = await prisma.hotelVectorStore.findFirst({
    where: { hotelId, isDefault: true }
  });
  if (existing) return existing;

  return prisma.hotelVectorStore.findFirst({
    where: { hotelId },
    orderBy: { createdAt: "asc" }
  });
}

export async function syncTrainingExamplesToVectorStore(
  hotelId: string,
  maxBatch = 10
): Promise<{ uploaded: number; failed: number }> {
  const examples = await prisma.trainingExample.findMany({
    where: { hotelId, vectorStatus: { in: [TrainingVectorStatus.pending, TrainingVectorStatus.failed] } },
    orderBy: { updatedAt: "asc" },
    take: maxBatch
  });

  if (!examples.length) return { uploaded: 0, failed: 0 };

  const store = await resolveHotelVectorStore(hotelId);
  if (!store) {
    throw new Error("No vector store available for hotel");
  }

  const client = await getHotelOpenAIClient(hotelId);
  const vectorStores = getVectorStoresApi(client);

  let uploaded = 0;
  let failed = 0;

  for (const example of examples) {
    await prisma.trainingExample.update({
      where: { id: example.id },
      data: { vectorStatus: TrainingVectorStatus.uploading, error: null }
    });

    try {
      const payload = {
        input: example.inputText,
        output: example.outputText,
        score: example.score,
        metadata: example.metadata
      };

      const buffer = Buffer.from(JSON.stringify(payload), "utf8");
      const file = await toFile(buffer, `training-${example.id}.json`, { type: "application/json" });
      const uploadedFile = await client.files.create({
        purpose: "assistants",
        file
      });

      const attributes = {
        source: example.source,
        trainingExampleId: example.id,
        score: example.score?.toString() ?? "",
        createdAt: example.createdAt.toISOString()
      };

      const result = await vectorStores.files.create(store.openaiId, {
        file_id: uploadedFile.id,
        attributes
      });

      await prisma.trainingExample.update({
        where: { id: example.id },
        data: {
          vectorStatus: TrainingVectorStatus.uploaded,
          vectorFileId: result.id ?? uploadedFile.id,
          vectorUploadedAt: new Date()
        }
      });

      uploaded += 1;
    } catch (err: any) {
      await prisma.trainingExample.update({
        where: { id: example.id },
        data: {
          vectorStatus: TrainingVectorStatus.failed,
          error: String(err?.message ?? err)
        }
      });
      failed += 1;
    }
  }

  return { uploaded, failed };
}
