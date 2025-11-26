import { makeOpenAICompatibleProvider } from "./openaiCompatible.js";
import { makeClaudeProvider } from "./claude.js";

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
  ),
  claude: makeClaudeProvider(
    "claude",
    process.env.CLAUDE_API_KEY || "",
    process.env.CLAUDE_BASE_URL || "https://api.anthropic.com/v1"
  )
} as const;
