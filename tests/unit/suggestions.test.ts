import { describe, it, expect } from "vitest";
import {
  getComposerSuggestions,
  getPostReplySuggestions,
  resolveSuggestion
} from "../../src/suggestions/engine.js";

describe("suggestions engine", () => {
  it("filters composer suggestions by category and limit", () => {
    const writingSuggestions = getComposerSuggestions("en", {
      category: "writing",
      limit: 2
    });
    expect(writingSuggestions.length).toBeLessThanOrEqual(2);
    expect(writingSuggestions.every((s) => s.category === "writing")).toBe(true);
  });

  it("searches composer suggestions by label/template text", () => {
    const results = getComposerSuggestions("en", { q: "unit tests" });
    expect(results.some((s) => s.key === "unit_tests")).toBe(true);
  });

  it("respects limit and order for post-reply suggestions", () => {
    const suggestions = getPostReplySuggestions("Thanks!", "de", 2);
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].key).toBe("shorten_after");
  });

  it("resolves suggestion templates with provided variables", () => {
    const template = {
      key: "custom",
      label: "Custom",
      template: "Hello {{TEXT}} -> {{LANG}}",
      requires: ["TEXT", "LANG"]
    } as const;
    const resolved = resolveSuggestion(template, { TEXT: "World", LANG: "de" });
    expect(resolved).toBe("Hello World -> de");
  });
});
