import path from "node:path";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import crypto from "node:crypto";
import type { MultipartFile } from "@fastify/multipart";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { htmlToText } from "html-to-text";
import xlsx from "xlsx";
import AdmZip from "adm-zip";
import Tesseract from "tesseract.js";

const PROJECT_ROOT = process.cwd();
const CONVERSATION_UPLOAD_ROOT = path.resolve(PROJECT_ROOT, "uploads", "conversations");
const DEFAULT_TEXT_LIMIT = 20000;
const DEFAULT_PER_FILE_CONTEXT_LIMIT = 2000;
const DEFAULT_TOTAL_CONTEXT_LIMIT = 8000;

export const ALLOWED_FILE_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".json",
  ".csv",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);

export const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "image/png",
  "image/jpeg",
  "image/webp"
]);

const ARCHIVE_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".html",
  ".htm"
]);

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function isAllowedFile(filename: string, mimeType?: string | null): boolean {
  const ext = path.extname(filename || "").toLowerCase();
  if (ALLOWED_FILE_EXTENSIONS.has(ext)) return true;
  if (mimeType && ALLOWED_MIME_TYPES.has(mimeType)) return true;
  return false;
}

async function ensureConversationDir(conversationId: string) {
  const dir = path.join(CONVERSATION_UPLOAD_ROOT, conversationId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function persistMultipartFile(part: MultipartFile, conversationId: string) {
  const dir = await ensureConversationDir(conversationId);
  const originalName = part.filename || "upload";
  const safeName = sanitizeFileName(originalName);
  const storedName = `${Date.now()}-${safeName}`;
  const targetPath = path.join(dir, storedName);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const writeStream = createWriteStream(targetPath);
    part.file.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });
    part.file.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    part.file.pipe(writeStream);
  });

  return {
    path: targetPath,
    sizeBytes,
    checksum: hash.digest("hex"),
    storedName
  };
}

function truncateText(text: string, limit = DEFAULT_TEXT_LIMIT) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated]`;
}

function bufferToUtf8(buffer: Buffer) {
  return buffer.toString("utf8");
}

async function extractFromPdf(filePath: string) {
  const buffer = await fs.readFile(filePath);
  const parsed = await pdfParse(buffer);
  return parsed.text || null;
}

async function extractFromDocx(filePath: string) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || null;
}

async function extractFromXlsx(filePath: string) {
  const workbook = xlsx.readFile(filePath);
  if (!workbook.SheetNames.length) return null;
  const parts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = xlsx.utils.sheet_to_csv(sheet);
    if (!csv.trim()) continue;
    parts.push(`Sheet: ${name}\n${csv}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

async function extractFromZip(filePath: string) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!ARCHIVE_TEXT_EXTENSIONS.has(ext)) continue;
    const data = entry.getData();
    const content = data.toString("utf8");
    if (!content.trim()) continue;
    parts.push(`[${entry.entryName}]\n${content}`);
    if (parts.join("\n\n").length > DEFAULT_TEXT_LIMIT) break;
  }
  return parts.length ? parts.join("\n\n") : null;
}

async function extractFromImage(filePath: string, originalName: string) {
  try {
    const lang = process.env.TESSERACT_LANGUAGES || "eng+deu+spa+ita";
    const result = await Tesseract.recognize(filePath, lang);
    const text = result?.data?.text?.trim();
    if (text) return text;
  } catch (err) {
    console.warn(`OCR failed for ${originalName}:`, err);
  }
  return null;
}

export async function extractTextFromFile(filePath: string, mimeType: string | null, originalName: string) {
  const ext = path.extname(originalName || "").toLowerCase();
  const normalizedMime = mimeType?.toLowerCase() ?? "";
  const warnings: string[] = [];
  let text: string | null = null;

  try {
    if (normalizedMime === "application/pdf" || ext === ".pdf") {
      text = await extractFromPdf(filePath);
    } else if (
      normalizedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      ext === ".docx"
    ) {
      text = await extractFromDocx(filePath);
    } else if (normalizedMime === "application/msword" || ext === ".doc") {
      warnings.push("Legacy .doc files are not fully supported; please convert to .docx if possible.");
    } else if (
      normalizedMime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      normalizedMime === "application/vnd.ms-excel" ||
      ext === ".xlsx" ||
      ext === ".xls"
    ) {
      text = await extractFromXlsx(filePath);
    } else if (normalizedMime === "text/csv" || ext === ".csv") {
      text = bufferToUtf8(await fs.readFile(filePath));
    } else if (normalizedMime.startsWith("text/") || ext === ".txt" || ext === ".md" || ext === ".markdown") {
      text = bufferToUtf8(await fs.readFile(filePath));
    } else if (normalizedMime === "application/json" || ext === ".json") {
      text = bufferToUtf8(await fs.readFile(filePath));
    } else if (normalizedMime === "text/html" || ext === ".html" || ext === ".htm") {
      const raw = bufferToUtf8(await fs.readFile(filePath));
      text = htmlToText(raw, { wordwrap: 80 });
    } else if (
      normalizedMime === "application/vnd.ms-powerpoint" ||
      normalizedMime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      ext === ".ppt" ||
      ext === ".pptx"
    ) {
      warnings.push("PowerPoint parsing is not automated yet. Consider uploading a PDF export.");
    } else if (normalizedMime === "application/zip" || ext === ".zip") {
      text = await extractFromZip(filePath);
      if (!text) warnings.push("No text-based files found inside the archive.");
    } else if (
      normalizedMime === "image/png" ||
      normalizedMime === "image/jpeg" ||
      normalizedMime === "image/webp" ||
      ext === ".png" ||
      ext === ".jpg" ||
      ext === ".jpeg" ||
      ext === ".webp"
    ) {
      text = await extractFromImage(filePath, originalName);
      if (!text) {
        warnings.push("Unable to extract text from image automatically.");
        text = `Image attachment "${originalName}" (${normalizedMime || ext || "image"}). OCR failed; please describe the image if needed.`;
      }
    } else {
      warnings.push("File type not recognized for automatic text extraction.");
    }
  } catch (err: any) {
    warnings.push(`Failed to extract text: ${String(err?.message ?? err)}`);
    text = null;
  }

  const trimmed = text ? truncateText(text) : null;
  return { text: trimmed, warnings };
}

export function buildAttachmentContext(
  files: Array<{ originalName: string; mimeType: string; extractedText: string | null }>,
  options?: { perFileLimit?: number; totalLimit?: number }
) {
  if (!files?.length) return null;
  const perFileLimit = options?.perFileLimit ?? DEFAULT_PER_FILE_CONTEXT_LIMIT;
  const totalLimit = options?.totalLimit ?? DEFAULT_TOTAL_CONTEXT_LIMIT;
  const snippets: string[] = [];
  let total = 0;

  for (const file of files) {
    const text = (file.extractedText ?? "").trim();
    if (!text) continue;
    let snippet = text;
    let truncated = false;
    if (snippet.length > perFileLimit) {
      snippet = snippet.slice(0, perFileLimit);
      truncated = true;
    }
    let block = `Attachment: ${file.originalName} (${file.mimeType})\n${snippet}`;
    if (truncated) block += "\n...";
    if (total + block.length > totalLimit && snippets.length) break;
    snippets.push(block);
    total += block.length;
  }

  if (!snippets.length) return null;
  return `Use the following conversation attachments when relevant:\n\n${snippets.join("\n\n")}`;
}
