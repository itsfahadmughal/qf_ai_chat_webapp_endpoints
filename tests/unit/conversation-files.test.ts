import { describe, expect, it } from "vitest";
import { isAllowedFile, buildAttachmentContext } from "../../src/lib/conversationFiles.js";

describe("conversation file helpers", () => {
  it("validates file eligibility by extension or mime", () => {
    expect(isAllowedFile("report.pdf")).toBe(true);
    expect(isAllowedFile("unknown.bin", "application/pdf")).toBe(true);
    expect(isAllowedFile("script.exe")).toBe(false);
  });

  it("builds attachment context with per-file truncation", () => {
    const ctx = buildAttachmentContext(
      [
        {
          originalName: "deck.pdf",
          mimeType: "application/pdf",
          extractedText: "a".repeat(100)
        },
        {
          originalName: "notes.txt",
          mimeType: "text/plain",
          extractedText: "b".repeat(50)
        }
      ],
      { perFileLimit: 60, totalLimit: 500 }
    );

    expect(ctx).toMatch(/Attachment: deck\.pdf/);
    expect(ctx).toMatch(/Attachment: notes\.txt/);
    expect(ctx?.includes("a".repeat(60))).toBe(true);
    expect(ctx?.includes("...")).toBe(true);
  });

  it("returns null when no files have extracted text", () => {
    const ctx = buildAttachmentContext([
      { originalName: "empty.txt", mimeType: "text/plain", extractedText: "" },
      { originalName: "nil.pdf", mimeType: "application/pdf", extractedText: null }
    ]);
    expect(ctx).toBeNull();
  });
});
