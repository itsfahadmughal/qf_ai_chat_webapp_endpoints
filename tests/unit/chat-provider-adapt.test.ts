import { describe, expect, it } from "vitest";
import { adaptMessagesForProvider } from "../../src/routes/chat.js";

const baseMessages = [
  { role: "system", content: "s" },
  { role: "assistant", content: "a1" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "u1" },
  { role: "tool", content: "tool output" }
];

describe("adaptMessagesForProvider", () => {
  it("maps tool messages to system for OpenAI-compatible providers", () => {
    const adapted = adaptMessagesForProvider("openai", [{ role: "tool", content: "calc" }]);
    expect(adapted).toEqual([{ role: "system", content: "calc" }]);
  });

  it("normalizes Perplexity messages, merging consecutive roles", () => {
    const adapted = adaptMessagesForProvider("perplexity", baseMessages);

    expect(adapted[0]).toEqual({ role: "system", content: "s" });
    expect(adapted[1]).toEqual({ role: "assistant", content: "a1\n\na2" });
    expect(adapted[2]).toEqual({ role: "user", content: "u1" });
    expect(adapted[3].role).toBe("assistant");
    expect(adapted[3].content).toContain("Tool output:");
  });

  it("leaves other providers untouched", () => {
    const adapted = adaptMessagesForProvider("claude", baseMessages);
    expect(adapted).toStrictEqual(baseMessages);
  });
});
