import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import {
  ALLOWED_FILE_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  extractTextFromFile,
  isAllowedFile,
  persistMultipartFile,
  buildAttachmentContext
} from "../lib/conversationFiles.js";
import { getHotelOpenAIClient } from "../lib/openai.js";

const MAX_FILES_PER_REQUEST = 10;
const DOWNLOAD_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year
const DOWNLOAD_SECRET = process.env.JWT_SECRET || "dev_only";
const VISION_PROMPT =
  process.env.OPENAI_VISION_PROMPT ||
  "Describe the key elements of this hospitality-related image so I can answer guest questions accurately.";
const DEFAULT_VISION_MODEL =
  process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

async function analyzeImageWithVision({
  filePath,
  mimeType,
  hotelId,
  log
}: {
  filePath: string;
  mimeType: string;
  hotelId: string;
  log: any;
}) {
  if (!mimeType.startsWith("image/")) return null;
  try {
    const client = await getHotelOpenAIClient(hotelId);
    const data = await fs.promises.readFile(filePath);
    const base64 = data.toString("base64");
    const response = await client.responses.create({
      model: DEFAULT_VISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: VISION_PROMPT },
            { type: "input_image", image_url: `data:${mimeType};base64,${base64}`, detail: "auto" }
          ]
        }
      ]
    });
    const summary =
      (Array.isArray(response.output_text) && response.output_text.join("\n").trim()) ||
      response.output
        ?.map((block: any) =>
          Array.isArray(block.content)
            ? block.content
                .map((part: any) => part?.text ?? part?.content ?? "")
                .join(" ")
            : ""
        )
        .join("\n")
        .trim();
    if (summary) {
      return { summary, model: DEFAULT_VISION_MODEL };
    }
  } catch (err) {
    log?.warn?.({ err }, "vision_analysis_failed");
  }
  return null;
}

type UploadResult = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  status: string;
  warnings: string[];
  downloadUrl: string;
  visionSummary?: string | null;
};

function createDownloadToken(fileId: string, userId: string) {
  const timestamp = Date.now();
  const payload = `${fileId}:${userId}:${timestamp}`;
  const signature = crypto.createHmac("sha256", DOWNLOAD_SECRET).update(payload).digest("hex");
  const token = `${payload}:${signature}`;
  return Buffer.from(token).toString("base64url");
}

function verifyDownloadToken(token: string | undefined) {
  if (!token) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split(":");
  if (parts.length !== 4) return null;
  const [fileId, userId, timestampStr, signature] = parts;
  const timestamp = Number(timestampStr);
  if (!fileId || !userId || !timestamp || !signature) return null;
  const payload = `${fileId}:${userId}:${timestamp}`;
  const expectedSignature = crypto.createHmac("sha256", DOWNLOAD_SECRET).update(payload).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) return null;
  if (Date.now() - timestamp > DOWNLOAD_TOKEN_TTL_MS) return null;
  return { fileId, userId };
}

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
        let visionSummary: string | null = null;
        let visionModel: string | null = null;
        try {
          const extraction = await extractTextFromFile(persisted.path, mimeType, originalName);
          extractedText = extraction.text;
          warnings = extraction.warnings;
          if (mimeType.startsWith("image/")) {
            const vision = await analyzeImageWithVision({
              filePath: persisted.path,
              mimeType,
              hotelId: conversation.hotelId,
              log: req.log
            });
            if (vision?.summary) {
              visionSummary = vision.summary;
              visionModel = vision.model;
            }
          }
          await prisma.conversationFile.update({
            where: { id: record.id },
            data: {
              extractedText,
              metadata: warnings.length ? { warnings } : undefined,
              status: extractedText ? "parsed" : "uploaded",
              visionSummary,
              visionModel
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

        const token = createDownloadToken(record.id, req.user.id);
        const downloadUrl = `/conversations/${conversation.id}/files/${record.id}/download?token=${encodeURIComponent(
          token
        )}`;
        results.push({
          id: record.id,
          originalName,
          mimeType,
          sizeBytes: persisted.sizeBytes,
          status: extractedText ? "parsed" : "uploaded",
          warnings,
          downloadUrl,
          visionSummary
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

      const uploadedFiles = await prisma.conversationFile.findMany({
        where: { id: { in: results.map((r) => r.id) } },
        select: {
          originalName: true,
          mimeType: true,
          extractedText: true,
          visionSummary: true
        }
      });
      const attachmentContext = buildAttachmentContext(
        uploadedFiles
          .map((file) => {
            const combined = [file.extractedText, file.visionSummary ? `Vision summary:\n${file.visionSummary}` : null]
              .filter(Boolean)
              .join("\n\n");
            if (!combined) return null;
            return {
              originalName: file.originalName,
              mimeType: file.mimeType,
              extractedText: combined
            };
          })
          .filter(
            (entry): entry is { originalName: string; mimeType: string; extractedText: string } =>
              Boolean(entry?.extractedText)
          )
      );
      if (attachmentContext) {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "system",
            content: attachmentContext
          }
        });
      }
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
        metadata: true,
        userId: true
      }
    });

    return {
      files: files.map((file) => {
        const token = createDownloadToken(file.id, req.user.id);
        return {
          id: file.id,
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          status: file.status,
          createdAt: file.createdAt,
          metadata: file.metadata,
          downloadUrl: `/conversations/${id}/files/${file.id}/download?token=${encodeURIComponent(token)}`
        };
      })
    };
  });

  app.get("/conversations/:conversationId/files/:fileId/download", async (req: any, reply) => {
    const { conversationId, fileId } = req.params as { conversationId: string; fileId: string };
    const token = (req.query as any)?.token as string | undefined;
    const verified = verifyDownloadToken(token);
    if (!verified || verified.fileId !== fileId) {
      return reply.code(401).send({ error: "invalid_token" });
    }

    const file = await prisma.conversationFile.findFirst({
      where: { id: fileId, conversationId },
      select: {
        originalName: true,
        mimeType: true,
        storagePath: true,
        userId: true
      }
    });
    if (!file) {
      return reply.code(404).send({ error: "file_not_found" });
    }
    if (file.userId !== verified.userId) {
      return reply.code(403).send({ error: "forbidden" });
    }

    const absolutePath = path.resolve(process.cwd(), file.storagePath);
    if (!fs.existsSync(absolutePath)) {
      return reply.code(404).send({ error: "file_missing" });
    }

    const safeName = file.originalName.replace(/"/g, "");
    reply.header("Content-Type", file.mimeType);
    const isInline = file.mimeType.startsWith("image/");
    reply.header("Content-Disposition", `${isInline ? "inline" : "attachment"}; filename="${safeName}"`);
    return reply.send(fs.createReadStream(absolutePath));
  });
}
