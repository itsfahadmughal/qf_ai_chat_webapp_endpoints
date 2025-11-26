import type { ChatMessage, LLMProvider } from "./types.js";

type ClaudeMessage = {
  role: "assistant" | "user";
  content: string | Array<{ type: "text"; text: string }>;
};

function buildClaudeMessages(messages: ChatMessage[]) {
  const systemParts: string[] = [];
  const claudeMessages: ClaudeMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      // Anthropic doesn't have a tool role; stuff it into the assistant stream.
      claudeMessages.push({
        role: "assistant",
        content: message.content
      });
      continue;
    }
    claudeMessages.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    });
  }

  const system = systemParts.length ? systemParts.join("\n\n") : undefined;
  return { claudeMessages, system };
}

export function makeClaudeProvider(
  name: LLMProvider["name"],
  defaultApiKey: string,
  defaultBaseUrl: string
): LLMProvider {
  return {
    name,
    async chat({
      model,
      messages,
      apiKey,
      baseURL
    }: {
      model: string;
      messages: ChatMessage[];
      apiKey?: string;
      baseURL?: string;
    }) {
      const key = apiKey || defaultApiKey;
      if (!key) {
        throw new Error("Claude API key not configured.");
      }
      const url = (baseURL || defaultBaseUrl || "https://api.anthropic.com/v1").replace(/\/$/, "");
      const { claudeMessages, system } = buildClaudeMessages(messages);

      const payload = {
        model,
        system,
        messages: claudeMessages.map(msg => ({
          role: msg.role,
          content:
            typeof msg.content === "string"
              ? [{ type: "text", text: msg.content }]
              : msg.content
        })),
        max_tokens: 1024
      };

      const response = await fetch(`${url}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }

      const json = await response.json();
      const text =
        json?.content
          ?.map((block: any) =>
            block?.text ??
            (Array.isArray(block?.content)
              ? block.content.map((part: any) => part?.text ?? "").join(" ")
              : "")
          )
          .join("\n")
          .trim() ?? "";

      return {
        content: text,
        usage: json?.usage
      };
    }
  };
}
