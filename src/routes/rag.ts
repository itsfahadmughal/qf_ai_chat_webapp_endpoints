import type { FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { toFile } from "openai/uploads";
import type { MultipartFile } from "@fastify/multipart";
import { prisma } from "../db.js";
import { getHotelOpenAIClient, getVectorStoresApi, resolveHotelOpenAIConfig } from "../lib/openai.js";

type UploadableFile = Awaited<ReturnType<typeof toFile>>;
type FilePurpose = "assistants" | "batch" | "fine-tune" | "vision" | "user_data" | "evals";

const prismaAny = prisma as any;

const CreateVectorStoreSchema = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  departmentId: z.string().min(1, "departmentId is required"),
  name: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  makeDefault: z.boolean().optional()
});

const ListVectorStoresQuery = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  departmentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const ListVectorStoreFilesQuery = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  after: z.string().optional()
});

const FineTuneListQuery = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  purpose: z.enum(["fine-tune", "fine-tune-results", "assistants", "batch", "vision"]).optional()
});

const HotelScopedBody = z.object({
  hotelId: z.string().min(1, "hotelId is required")
});

async function collectMultipartFiles(req: any): Promise<{
  files: Array<{ file: UploadableFile; filename: string; mimetype: string; size: number }>;
  fields: Record<string, string>;
}> {
  const files: Array<{ file: UploadableFile; filename: string; mimetype: string; size: number }> = [];
  const fields: Record<string, string> = {};

  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      const filePart = part as MultipartFile;
      const buffer = await filePart.toBuffer();
      const safeName = filePart.filename || "upload";
      const size = buffer.length;
      if (size === 0) {
        throw new Error(`File "${safeName}" is empty`);
      }
      const file = await toFile(buffer, safeName, { type: filePart.mimetype });
      files.push({ file, filename: safeName, mimetype: filePart.mimetype, size });
    } else if (part.type === "field") {
      fields[part.fieldname] = part.value;
    }
  }

  return { files, fields };
}

async function getHotelOpenAIClientOrError(hotelId: string, reply: any) {
  try {
    return await getHotelOpenAIClient(hotelId);
  } catch (err: any) {
    reply.code(400).send({ error: "openai_credential_missing", details: String(err?.message ?? err) });
    return null;
  }
}

async function setDefaultVectorStore(hotelId: string, vectorStoreId: string) {
  await prisma.$transaction([
    prismaAny.hotelVectorStore.updateMany({
      where: { hotelId },
      data: { isDefault: false }
    }),
    prismaAny.hotelVectorStore.update({
      where: { id: vectorStoreId },
      data: { isDefault: true }
    })
  ]);
}

function formatVectorStoreRecord(record: any, remote: any, credentialAvailable: boolean) {
  return {
    id: record.id,
    hotelId: record.hotelId,
    openaiId: record.openaiId,
    name: record.name,
    metadata: record.metadata,
    isDefault: record.isDefault,
    departmentId: record.departmentId ?? null,
    department: record.department
      ? {
          id: record.department.id,
          name: record.department.name
        }
      : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    credentialAvailable,
    remote
  };
}

function normalizeString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(value) && value.length) {
    return normalizeString(value[0]);
  }
  return null;
}

async function ensureDepartmentForHotel(hotelId: string, departmentId: string, reply: any) {
  const department = await prismaAny.department.findFirst({
    where: { id: departmentId, hotelId },
    select: { id: true, name: true, isActive: true }
  });
  if (!department) {
    reply.code(404).send({ error: "department_not_found" });
    return null;
  }
  if (!department.isActive) {
    reply.code(403).send({ error: "department_inactive" });
    return null;
  }
  return department;
}

async function loadVectorStoreForHotel(id: string, hotelId: string) {
  return prismaAny.hotelVectorStore.findFirst({
    where: { id, hotelId },
    include: { department: { select: { id: true, name: true } } }
  });
}

export async function ragRoutes(app: FastifyInstance) {
  app.post("/rag/vector-stores", async (req: any, reply) => {
    try {
      const body = CreateVectorStoreSchema.parse(req.body ?? {});
      const { hotelId, departmentId } = body;

      const department = await ensureDepartmentForHotel(hotelId, departmentId, reply);
      if (!department) return;

      const existingForDepartment = await prismaAny.hotelVectorStore.findFirst({
        where: { hotelId, departmentId }
      });
      if (existingForDepartment) {
        return reply.code(409).send({ error: "department_vector_store_exists" });
      }

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;

      const vectorStores = getVectorStoresApi(client);
      const vectorStore = await vectorStores.create({
        name: body.name ?? `hotel-${hotelId}-store`,
        metadata: {
          ...((body.metadata as Record<string, string> | undefined) ?? {}),
          hotelId,
          departmentId
        }
      });

      const existing = await prismaAny.hotelVectorStore.findUnique({
        where: { openaiId: vectorStore.id }
      });

      let record = existing
        ? await prismaAny.hotelVectorStore.update({
            where: { openaiId: vectorStore.id },
            data: {
              hotelId,
              name: body.name ?? vectorStore.name ?? existing.name,
              metadata: body.metadata ?? vectorStore.metadata ?? existing.metadata,
              departmentId
            },
            include: { department: { select: { id: true, name: true } } }
          })
        : await prismaAny.hotelVectorStore.create({
            data: {
              hotelId,
              provider: "openai",
              openaiId: vectorStore.id,
              name: body.name ?? vectorStore.name ?? null,
              metadata: body.metadata ?? vectorStore.metadata ?? null,
              departmentId,
              isDefault: false
            },
            include: { department: { select: { id: true, name: true } } }
          });

      const shouldMakeDefault =
        body.makeDefault ||
        !(await prismaAny.hotelVectorStore.count({ where: { hotelId, isDefault: true } }));

      if (shouldMakeDefault) {
        await setDefaultVectorStore(hotelId, record.id);
        record = await prismaAny.hotelVectorStore.findUniqueOrThrow({
          where: { id: record.id },
          include: { department: { select: { id: true, name: true } } }
        });
      }

      const credential = await resolveHotelOpenAIConfig(hotelId);
      return {
        vectorStore,
        record: formatVectorStoreRecord(record, vectorStore, Boolean(credential.apiKey))
      };
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: err.errors });
      }
      req.log.error({ err }, "vector store create failed");
      return reply.code(500).send({ error: "vector_store_create_failed", details: String(err?.message ?? err) });
    }
  });

  app.get("/rag/vector-stores", async (req: any, reply) => {
    try {
      const query = ListVectorStoresQuery.parse(req.query ?? {});
      const { hotelId, departmentId } = query;

      if (departmentId) {
        const department = await ensureDepartmentForHotel(hotelId, departmentId, reply);
        if (!department) return;
      }

      const stores = await prismaAny.hotelVectorStore.findMany({
        where: {
          hotelId,
          ...(departmentId ? { departmentId } : {})
        },
        orderBy: { createdAt: "desc" },
        take: query.limit ?? undefined,
        include: { department: { select: { id: true, name: true } } }
      });

      const cfg = await resolveHotelOpenAIConfig(hotelId);
      const credentialAvailable = !!cfg.apiKey;
      let vectorStores: ReturnType<typeof getVectorStoresApi> | null = null;
      if (credentialAvailable) {
        try {
          const client = await getHotelOpenAIClient(hotelId);
          vectorStores = getVectorStoresApi(client);
        } catch (err) {
          req.log.warn({ err }, "failed to initialize OpenAI client for vector store list");
          vectorStores = null;
        }
      }

      const results = await Promise.all(
        stores.map(async (store) => {
          if (!vectorStores) return formatVectorStoreRecord(store, null, credentialAvailable);
          try {
            const remote = await vectorStores.retrieve(store.openaiId);
            return formatVectorStoreRecord(store, remote, credentialAvailable);
          } catch (err: any) {
            req.log.warn({ err }, "failed to fetch remote vector store");
            return formatVectorStoreRecord(store, null, credentialAvailable);
          }
        })
      );

      return { vectorStores: results };
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: err.errors });
      }
      req.log.error({ err }, "vector store list failed");
      return reply.code(500).send({ error: "vector_store_list_failed", details: String(err?.message ?? err) });
    }
  });

  app.get("/rag/vector-stores/:id", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { hotelId } = HotelScopedBody.parse(req.query ?? {});

      const record = await loadVectorStoreForHotel(id, hotelId);
      if (!record) return reply.code(404).send({ error: "vector_store_not_found" });

      const cfg = await resolveHotelOpenAIConfig(hotelId);
      if (!cfg.apiKey) {
        return {
          record: formatVectorStoreRecord(record, null, false),
          remote: null
        };
      }

      try {
        const client = await getHotelOpenAIClient(hotelId);
        const vectorStores = getVectorStoresApi(client);
        const remote = await vectorStores.retrieve(record.openaiId);
        return {
          record: formatVectorStoreRecord(record, remote, true),
          remote
        };
      } catch (err: any) {
        req.log.warn({ err }, "vector store retrieve failed remotely");
        return {
          record: formatVectorStoreRecord(record, null, true),
          remote: null
        };
      }
    } catch (err: any) {
      req.log.error({ err }, "vector store retrieve failed");
      return reply.code(500).send({ error: "vector_store_retrieve_failed", details: String(err?.message ?? err) });
    }
  });

  app.get("/rag/vector-stores/:id/files", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };
      const query = ListVectorStoreFilesQuery.parse(req.query ?? {});
      const { hotelId } = query;

      const record = await loadVectorStoreForHotel(id, hotelId);
      if (!record) return reply.code(404).send({ error: "vector_store_not_found" });

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;
      const vectorStores = getVectorStoresApi(client);

      const page = await vectorStores.files.list(record.openaiId, {
        limit: query.limit ?? 50,
        after: query.after
      });
      return {
        object: (page as any)?.object ?? "list",
        data: (page as any)?.data ?? [],
        has_more: (page as any)?.has_more ?? false
      };
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: err.errors });
      }
      req.log.error({ err }, "vector store files list failed");
      const status = err?.status === 404 ? 404 : 500;
      return reply.code(status).send({ error: "vector_store_files_failed", details: String(err?.message ?? err) });
    }
  });

  app.post("/rag/vector-stores/:id/files", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };

      let collected;
      try {
        collected = await collectMultipartFiles(req);
      } catch (err: any) {
        return reply.code(400).send({ error: "invalid_file", details: String(err?.message ?? err) });
      }

      const { files, fields } = collected;
      if (!files.length) {
        return reply.code(400).send({ error: "no_files_uploaded" });
      }

      const hotelId = normalizeString(fields.hotelId);
      if (!hotelId) {
        return reply.code(400).send({ error: "hotel_id_required" });
      }

      const record = await loadVectorStoreForHotel(id, hotelId);
      if (!record) return reply.code(404).send({ error: "vector_store_not_found" });

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;
      const vectorStores = getVectorStoresApi(client);

      const baseAttributes: Record<string, string> = {};
      const setAttr = (key: string, value: string | undefined | null) => {
        const trimmed = value ? value.trim() : "";
        if (trimmed) baseAttributes[key] = trimmed;
      };
      setAttr("hotelId", hotelId);
      setAttr("departmentId", record.departmentId ?? null);
      setAttr("title", fields.title);
      setAttr("language", fields.language);
      setAttr("module", fields.module);
      setAttr("moduleAssignment", fields.moduleAssignment);
      setAttr("description", fields.description);

      const uploads: Array<{
        vectorStoreFile: any;
        sourceFileId: string;
        attributes: Record<string, string>;
      }> = [];

      for (const f of files) {
        const uploaded = await client.files.create({
          purpose: "assistants",
          file: f.file
        });

        const attributes = {
          originalFilename: f.filename,
          ...baseAttributes
        };

        const attached = await vectorStores.files.create(record.openaiId, {
          file_id: uploaded.id,
          attributes
        });

        uploads.push({
          vectorStoreFile: attached,
          sourceFileId: uploaded.id,
          attributes
        });
      }

      return {
        vectorStoreId: record.id,
        files: uploads
      };
    } catch (err: any) {
      req.log.error({ err }, "vector store file upload failed");
      const status = err?.status === 404 ? 404 : 500;
      return reply.code(status).send({ error: "vector_store_upload_failed", details: String(err?.message ?? err) });
    }
  });

  app.patch("/rag/vector-stores/:id/default", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { hotelId } = HotelScopedBody.parse(req.body ?? {});

      const record = await loadVectorStoreForHotel(id, hotelId);
      if (!record) return reply.code(404).send({ error: "vector_store_not_found" });

      await setDefaultVectorStore(hotelId, record.id);
      return { ok: true };
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: err.errors });
      }
      req.log.error({ err }, "vector store default update failed");
      return reply.code(500).send({ error: "vector_store_default_failed", details: String(err?.message ?? err) });
    }
  });

  app.delete("/rag/vector-stores/:id", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { hotelId } = HotelScopedBody.parse(req.query ?? {});

      const record = await loadVectorStoreForHotel(id, hotelId);
      if (!record) return reply.code(404).send({ error: "vector_store_not_found" });

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;
      const vectorStores = getVectorStoresApi(client);

      try {
        if (typeof vectorStores.del === "function") {
          await vectorStores.del(record.openaiId);
        } else if (typeof vectorStores.delete === "function") {
          await vectorStores.delete(record.openaiId);
        }
      } catch (err: any) {
        if (err?.status !== 404) {
          req.log.warn({ err }, "failed to delete remote vector store");
        }
      }

      await prismaAny.hotelVectorStore.delete({ where: { id: record.id } });

      if (record.isDefault) {
        const next = await prismaAny.hotelVectorStore.findFirst({
          where: { hotelId },
          orderBy: { createdAt: "asc" }
        });
        if (next) {
          await prismaAny.hotelVectorStore.update({
            where: { id: next.id },
            data: { isDefault: true }
          });
        }
      }

      return { ok: true };
    } catch (err: any) {
      req.log.error({ err }, "vector store delete failed");
      return reply.code(500).send({ error: "vector_store_delete_failed", details: String(err?.message ?? err) });
    }
  });

  app.post("/openai/fine-tuning/files", async (req: any, reply) => {
    try {
      let collected;
      try {
        collected = await collectMultipartFiles(req);
      } catch (err: any) {
        return reply.code(400).send({ error: "invalid_file", details: String(err?.message ?? err) });
      }
      const { files, fields } = collected;
      const hotelId = normalizeString(fields.hotelId);
      if (!hotelId) {
        return reply.code(400).send({ error: "hotel_id_required" });
      }

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;

      const rawPurpose = (fields.purpose ?? "").trim().toLowerCase();
      const allowedPurposes: FilePurpose[] = ["assistants", "batch", "fine-tune", "vision", "user_data", "evals"];
      const purpose = (allowedPurposes.includes(rawPurpose as FilePurpose) ? rawPurpose : "fine-tune") as FilePurpose;
      if (!files.length) {
        return reply.code(400).send({ error: "no_files_uploaded" });
      }

      const uploads: any[] = [];
      for (const f of files) {
        const uploaded = await client.files.create({
          purpose,
          file: f.file
        });
        uploads.push(uploaded);
      }

      return { purpose, files: uploads };
    } catch (err: any) {
      req.log.error({ err }, "fine-tune file upload failed");
      return reply.code(500).send({ error: "fine_tune_upload_failed", details: String(err?.message ?? err) });
    }
  });

  app.get("/openai/fine-tuning/files", async (req: any, reply) => {
    try {
      const query = FineTuneListQuery.parse(req.query ?? {});
      const { hotelId } = query;

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;

      const res = await client.files.list({
        purpose: query.purpose
      });
      return res;
    } catch (err: any) {
      if (err instanceof ZodError) {
        return reply.code(400).send({ error: "validation_error", details: err.errors });
      }
      req.log.error({ err }, "fine-tune file list failed");
      return reply.code(500).send({ error: "fine_tune_file_list_failed", details: String(err?.message ?? err) });
    }
  });

  app.get("/openai/fine-tuning/files/:id", async (req: any, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { hotelId } = HotelScopedBody.parse(req.query ?? {});

      const client = await getHotelOpenAIClientOrError(hotelId, reply);
      if (!client) return;

      const file = await client.files.retrieve(id);
      return { file };
    } catch (err: any) {
      req.log.error({ err }, "fine-tune file retrieve failed");
      const status = err?.status === 404 ? 404 : 500;
      return reply.code(status).send({ error: "fine_tune_file_retrieve_failed", details: String(err?.message ?? err) });
    }
  });
}
