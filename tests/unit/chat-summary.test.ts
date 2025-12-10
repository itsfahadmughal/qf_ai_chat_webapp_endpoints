import { describe, it, expect } from "vitest";
import { buildSummaryMessage } from "../../src/routes/chat.js";

const repeat = (text: string, times: number) => new Array(times).fill(text).join("");

describe("buildSummaryMessage", () => {
  it("returns null when there are no messages with content", () => {
    expect(buildSummaryMessage([])).toBeNull();
    expect(
      buildSummaryMessage([{ role: "user", content: "     " }, { role: "assistant", content: "\n" }])
    ).toBeNull();
  });

  it("generates labeled bullets for each message", () => {
    const summary = buildSummaryMessage([
      { role: "user", content: "  Hello   there " },
      { role: "assistant", content: "Sure, how can I help?" }
    ]);
    expect(summary).toBeTruthy();
    expect(summary).toContain("Summary of earlier conversation:");
    expect(summary).toContain("- User: Hello there");
    expect(summary).toContain("- Assistant: Sure, how can I help?");
  });

  it("truncates individual messages and appends ellipsis when needed", () => {
    const longContent = repeat("abc", 200); // > SUMMARY_PER_MESSAGE_LIMIT
    const summary = buildSummaryMessage([{ role: "system", content: longContent }]);
    expect(summary).toContain("- System: ");
    expect(summary?.endsWith("...") ?? false).toBe(true);
  });
});
