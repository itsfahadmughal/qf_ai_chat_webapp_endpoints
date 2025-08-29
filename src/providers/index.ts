import { makeOpenAICompatibleProvider } from "./openaiCompatible.js";

export const Providers = {
  openai: makeOpenAICompatibleProvider(
    "openai",
    process.env.OPENAI_API_KEY || "",
    process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"
  ),
  deepseek: makeOpenAICompatibleProvider(
    "deepseek",
    process.env.DEEPSEEK_API_KEY || "",
    process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"
  ),
  perplexity: makeOpenAICompatibleProvider(
    "perplexity",
    process.env.PERPLEXITY_API_KEY || "",
    process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai"
  )
} as const;