import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
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
  downloadUrl: string;
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
      select: { id: true, hotelId: true, provider: true, model: true }
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

        const downloadUrl = `/conversations/${conversation.id}/files/${record.id}/download`;
        results.push({
          id: record.id,
          originalName,
          mimeType,
          sizeBytes: persisted.sizeBytes,
          status: extractedText ? "parsed" : "uploaded",
          warnings,
          downloadUrl
        });
      } catch (err: any) {
        return reply.code(500).send({ error: "file_upload_failed", details: String(err?.message ?? err) });
      }
    }

    if (!sawFile) {
      return reply.code(400).send({ error: "no_files", details: "Attach at least one file." });
    }

    if (results.length) {
      const lines = results.map(
        (f) =>
          `- ${f.originalName} (${f.mimeType}, ${Math.round(f.sizeBytes / 1024)} KB) -> ${f.downloadUrl}`
      );
      const content = `Uploaded files:\n${lines.join("\n")}`;
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content,
          provider: conversation.provider,
          model: conversation.model
        }
      });
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

    return {
      files: files.map((file) => ({
        ...file,
        downloadUrl: `/conversations/${id}/files/${file.id}/download`
      }))
    };
  });

  app.get(
    "/conversations/:conversationId/files/:fileId/download",
    { preHandler: app.authenticate },
    async (req: any, reply) => {
      const { conversationId, fileId } = req.params as { conversationId: string; fileId: string };
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, userId: req.user.id },
        select: { id: true, hotelId: true }
      });
      if (!conversation) {
        return reply.code(404).send({ error: "conversation_not_found" });
      }

      const file = await prisma.conversationFile.findFirst({
        where: { id: fileId, conversationId },
        select: {
          originalName: true,
          mimeType: true,
          storagePath: true
        }
      });
      if (!file) {
        return reply.code(404).send({ error: "file_not_found" });
      }

      const absolutePath = path.resolve(process.cwd(), file.storagePath);
      if (!fs.existsSync(absolutePath)) {
        return reply.code(404).send({ error: "file_missing" });
      }

      reply.header("Content-Type", file.mimeType);
      reply.header(
        "Content-Disposition",
        `attachment; filename="${file.originalName.replace(/"/g, "")}"`
      );
      return reply.send(fs.createReadStream(absolutePath));
    }
  );
}
