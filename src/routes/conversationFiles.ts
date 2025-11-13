import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import path from "node:path";
import { prisma } from "../db.js";
import {
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  extractTextFromFile,
  isAllowedFile,
  persistMultipartFile
} from "../lib/conversationFiles.js";

const MAX_FILES_PER_REQUEST = 10;

type UploadResult = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  warnings: string[];
};

function warnUnsupported(filename: string, mimeType: string | undefined) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.has(ext) && (!mimeType || !ALLOWED_MIME_TYPES.has(mimeType))) {
    return `File type "${ext || mimeType || "unknown"}" is not supported.`;
  }
  return null;
}

export async function conversationFileRoutes(app: FastifyInstance) {
  app.post("/conversations/:id/files", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findFirst({
      where: { id, userId: req.user.id },
      select: { id: true, hotelId: true }
    });
    if (!conversation) {
      return reply.code(404).send({ error: "conversation_not_found" });
    }

    const results: UploadResult[] = [];
    const parts = req.parts();
    let processed = 0;
    let sawFile = false;

    for await (const rawPart of parts) {
      if (rawPart.type !== "file") {
        continue;
      }
      const part = rawPart as MultipartFile;
      sawFile = true;
      processed += 1;
      if (processed > MAX_FILES_PER_REQUEST) {
        part.file.resume();
        return reply
          .code(400)
          .send({ error: "too_many_files", details: `Upload up to ${MAX_FILES_PER_REQUEST} files per request.` });
      }

      const originalName = part.filename || "upload";
      const mimeType = part.mimetype || "application/octet-stream";
      if (!isAllowedFile(originalName, mimeType)) {
        part.file.resume();
        return reply.code(415).send({ error: "unsupported_file", details: warnUnsupported(originalName, mimeType) ?? "Unsupported file type." });
      }

      try {
        const persisted = await persistMultipartFile(part, conversation.id);
        const relativePath = path.relative(process.cwd(), persisted.path);
        const record = await prisma.conversationFile.create({
          data: {
            conversationId: conversation.id,
            hotelId: conversation.hotelId,
            userId: req.user.id,
            originalName,
            mimeType,
            sizeBytes: persisted.sizeBytes,
            storagePath: relativePath,
            checksum: persisted.checksum,
            status: "uploaded"
          }
        });

        let warnings: string[] = [];
        let extractedText: string | null = null;
        try {
          const extraction = await extractTextFromFile(persisted.path, mimeType, originalName);
          extractedText = extraction.text;
          warnings = extraction.warnings;
          await prisma.conversationFile.update({
            where: { id: record.id },
            data: {
              extractedText,
              metadata: warnings.length ? { warnings } : undefined,
              status: extractedText ? "parsed" : "uploaded"
            }
          });
        } catch (err: any) {
          warnings = [`Extraction failed: ${String(err?.message ?? err)}`];
          await prisma.conversationFile.update({
            where: { id: record.id },
            data: {
              status: "failed",
              error: warnings[0]
            }
          });
        }

        results.push({
          id: record.id,
          originalName,
          mimeType,
          sizeBytes: persisted.sizeBytes,
          status: extractedText ? "parsed" : "uploaded",
          warnings
        });
      } catch (err: any) {
        return reply.code(500).send({ error: "file_upload_failed", details: String(err?.message ?? err) });
      }
    }

    if (!sawFile) {
      return reply.code(400).send({ error: "no_files", details: "Attach at least one file." });
    }

    return { files: results };
  });

  app.get("/conversations/:id/files", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await prisma.conversation.findFirst({
      where: { id, userId: req.user.id },
      select: { id: true }
    });
    if (!conversation) {
      return reply.code(404).send({ error: "conversation_not_found" });
    }

    const files = await prisma.conversationFile.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        sizeBytes: true,
        status: true,
        createdAt: true,
        metadata: true
      }
    });

    return { files };
  });
}
