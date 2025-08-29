export type ChatMessage = { role: "system"|"user"|"assistant"|"tool"; content: string };

export interface LLMProvider {
  name: "openai" | "deepseek" | "perplexity";
  chat(opts: {
    model: string;
    messages: ChatMessage[];
    apiKey?: string;
    baseURL?: string;
  }): Promise<{ content: string; usage?: any }>;
}
