// src/suggestions/engine.ts
export type Suggestion = {
  key: string;
  label: string;
  template: string;
  requires?: Array<"TEXT" | "LANG">;
  category?: "writing" | "translate" | "summarize" | "brainstorm" | "planning" | "coding" | "data";
  icon?: string; // optional UI hint, e.g. "💡"
};

const composerBase: Suggestion[] = [
  // Writing / editing
  { key: "rewrite_persuasive", label: "Make this email more persuasive", template: "Rewrite the following email to be more persuasive while staying truthful:\n\n{{TEXT}}", requires: ["TEXT"], category: "writing", icon: "💡" },
  { key: "rewrite_friendly", label: "Rewrite this text to sound more friendly", template: "Rewrite the following text to sound friendlier and warmer, without losing key details:\n\n{{TEXT}}", requires: ["TEXT"], category: "writing", icon: "💬" },
  { key: "improve_grammar", label: "Fix grammar and clarity", template: "Edit the following to improve grammar, clarity, and flow while preserving meaning:\n\n{{TEXT}}", requires: ["TEXT"], category: "writing", icon: "📝" },
  { key: "shorten", label: "Make it shorter", template: "Rewrite the following to be ~40% shorter without losing key meaning:\n\n{{TEXT}}", requires: ["TEXT"], category: "writing", icon: "✂️" },
  { key: "bulletize", label: "Turn into bullet points", template: "Convert the following into clear, concise bullet points:\n\n{{TEXT}}", requires: ["TEXT"], category: "summarize", icon: "•" },
  { key: "outline", label: "Create an outline", template: "Create a clean, hierarchical outline for the following topic or draft:\n\n{{TEXT}}", requires: ["TEXT"], category: "planning", icon: "🧭" },

  // Summarize / explain
  { key: "summarize", label: "Summarize this", template: "Summarize the following in 5–7 sentences for a general audience:\n\n{{TEXT}}", requires: ["TEXT"], category: "summarize", icon: "🔎" },
  { key: "explain_simple", label: "Explain like I’m five", template: "Explain the following in very simple terms, using examples:\n\n{{TEXT}}", requires: ["TEXT"], category: "summarize", icon: "👶" },

  // Brainstorm / ideate
  { key: "brainstorm", label: "Brainstorm ideas", template: "Brainstorm 10 creative ideas for the following goal. Make them concrete and varied:\n\n{{TEXT}}", requires: ["TEXT"], category: "brainstorm", icon: "✨" },
  { key: "email_variants", label: "Draft 3 email versions", template: "Write three alternative versions of the following email, each with a distinct tone (friendly, concise, formal):\n\n{{TEXT}}", requires: ["TEXT"], category: "writing", icon: "📧" },

  // Translate
  { key: "translate_generic", label: "Translate to…", template: "Translate the following into {{LANG}}. Keep names and code unchanged:\n\n{{TEXT}}", requires: ["TEXT", "LANG"], category: "translate", icon: "🌐" },
  { key: "translate_fr", label: "Translate to French", template: "Translate the following into French. Keep names and code unchanged:\n\n{{TEXT}}", requires: ["TEXT"], category: "translate", icon: "🇫🇷" },

  // Planning / productivity
  { key: "agenda", label: "Draft a meeting agenda", template: "Create a 30-minute meeting agenda based on these notes/goals:\n\n{{TEXT}}", requires: ["TEXT"], category: "planning", icon: "📅" },
  { key: "tasks", label: "Turn notes into tasks", template: "Turn the following notes into actionable tasks with owners (generic) and due dates (T+7d if missing):\n\n{{TEXT}}", requires: ["TEXT"], category: "planning", icon: "✅" },

  // Coding / technical
  { key: "explain_error", label: "Explain this error", template: "Explain the following error, most likely causes, and fixes (with examples):\n\n{{TEXT}}", requires: ["TEXT"], category: "coding", icon: "🛠️" },
  { key: "review_code", label: "Review this code", template: "Review the following code for clarity, correctness, and style. Suggest improvements:\n\n{{TEXT}}", requires: ["TEXT"], category: "coding", icon: "🔍" },
  { key: "unit_tests", label: "Write unit tests", template: "Write Jest unit tests for the following code. Include edge cases:\n\n{{TEXT}}", requires: ["TEXT"], category: "coding", icon: "🧪" },

  // Data / SQL
  { key: "sql_from_req", label: "Write SQL from a request", template: "Given this requirement, write a SQL query (PostgreSQL) and explain it briefly:\n\n{{TEXT}}", requires: ["TEXT"], category: "data", icon: "🗄️" }
];

export function getComposerSuggestions(locale: string = "en", opts?: { category?: Suggestion["category"]; limit?: number; q?: string }) {
  let list = [...composerBase];
  if (opts?.category) list = list.filter(s => s.category === opts.category);
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    list = list.filter(s => s.label.toLowerCase().includes(q) || s.template.toLowerCase().includes(q));
  }
  if (opts?.limit && opts.limit > 0) list = list.slice(0, opts.limit);
  return list;
}

// Suggestions after an assistant reply (kept compact)
export function getPostReplySuggestions(lastAssistant: string, locale: string = "en", limit: number = 3): Suggestion[] {
  const base: Suggestion[] = [
    { key: "shorten_after", label: "Make it shorter", template: "Rewrite the following to be 30–40% shorter:\n\n{{TEXT}}", requires: ["TEXT"], category: "writing" },
    { key: "bulletize_after", label: "Convert to bullet points", template: "Convert the following into bullet points:\n\n{{TEXT}}", requires: ["TEXT"], category: "summarize" },
    { key: "translate_after", label: "Translate to…", template: "Translate the following into {{LANG}}:\n\n{{TEXT}}", requires: ["TEXT", "LANG"], category: "translate" }
  ];
  return base.slice(0, limit);
}

export function resolveSuggestion(s: Suggestion, vars: Record<string, string>): string {
  let out = s.template;
  for (const k of s.requires ?? []) out = out.replaceAll(`{{${k}}}`, vars[k] ?? "");
  return out;
}