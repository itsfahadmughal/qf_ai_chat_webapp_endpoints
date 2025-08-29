import { LLMProvider, ChatMessage } from "./types.js";

export function makeOpenAICompatibleProvider(
  name: LLMProvider["name"],
  defaultApiKey: string,
  defaultBaseURL: string
): LLMProvider {
  return {
    name,
    async chat({ model, messages, apiKey, baseURL }: { model: string; messages: ChatMessage[]; apiKey?: string; baseURL?: string }) {
      const key = apiKey || defaultApiKey;
      const url = (baseURL || defaultBaseURL).replace(/\/$/, "");
      const res = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model, messages, stream: false })
      });
      if (!res.ok) throw new Error(await res.text());
      const json = await res.json();
      return { content: json?.choices?.[0]?.message?.content ?? "", usage: json?.usage };
    }
  };
}