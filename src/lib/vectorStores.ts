import { Provider } from "@prisma/client";
import { prisma } from "../db.js";
import { getHotelOpenAIClient, getVectorStoresApi } from "./openai.js";

type LoggerLike = {
  info?: (obj: any, msg?: string) => void;
  warn?: (obj: any, msg?: string) => void;
  error?: (obj: any, msg?: string) => void;
} | undefined;

export async function ensureDefaultVectorStore(
  hotelId: string,
  logger?: LoggerLike
) {
  const existingDefault = await prisma.hotelVectorStore.findFirst({
    where: { hotelId, isDefault: true }
  });
  if (existingDefault) return existingDefault;

  const existingAny = await prisma.hotelVectorStore.findFirst({
    where: { hotelId },
    orderBy: { createdAt: "asc" }
  });
  if (existingAny) {
    if (!existingAny.isDefault) {
      await prisma.hotelVectorStore.updateMany({
        where: { hotelId },
        data: { isDefault: false }
      });
      await prisma.hotelVectorStore.update({
        where: { id: existingAny.id },
        data: { isDefault: true }
      });
    }
    return { ...existingAny, isDefault: true };
  }

  const client = await getHotelOpenAIClient(hotelId);
  const vectorStores = getVectorStoresApi(client);

  const remote = await vectorStores.create({
    name: `hotel-${hotelId}-default-store`,
    metadata: { hotelId }
  });

  const record = await prisma.hotelVectorStore.create({
    data: {
      hotelId,
      provider: Provider.openai,
      openaiId: remote.id,
      name: remote.name ?? `hotel-${hotelId}-store`,
      metadata: remote.metadata ?? { hotelId },
      isDefault: true
    }
  });

  logger?.info?.({ hotelId, vectorStoreId: record.id }, "default vector store created");
  return record;
}
