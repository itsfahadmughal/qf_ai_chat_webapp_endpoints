// src/routes/chat.ts
import type { FastifyInstance } from "fastify";
import { FineTuneModelStatus, Provider as PrismaProvider } from "@prisma/client";
import { prisma } from "../db.js";
import { z } from "zod";
import { Providers } from "../providers/index.js";
import { decryptSecret } from "../crypto/secrets.js";
import { getPostReplySuggestions } from "../suggestions/engine.js";
import { mcpManager } from "../mcp/manager.js";
import type { ChatMessage } from "../providers/types.js";
import { injectBrevoKeyIfNeeded } from "../lib/byok.js";
import { getHotelOpenAIClient, searchVectorStore } from "../lib/openai.js";
import { scheduleFineTuneUpload } from "../lib/fineTuning.js";
import { upsertConversationSummaryExample } from "../lib/training/examples.js";
import { syncTrainingExamplesToVectorStore } from "../lib/training/vectorStore.js";
import { ensureDefaultVectorStore } from "../lib/vectorStores.js";
import { buildAttachmentContext } from "../lib/conversationFiles.js";

const prismaAny = prisma as any;

type ProviderName = "openai" | "deepseek" | "perplexity" | "claude";

const MEMORY_MESSAGE_ROLE = "memory";
const MAX_RECENT_CONTEXT_MESSAGES = 8;
const SUMMARY_CHAR_LIMIT = 2000;
const SUMMARY_PER_MESSAGE_LIMIT = 280;

const ChatBody = z.object({
  conversationId: z.string().optional(),
  promptId: z.string().nullable().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).nonempty(),
  tool: z.object({
    serverId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()).default({})
  }).optional(),
  knowledge: z
    .object({
      enabled: z.boolean().optional(),
      vectorStoreId: z.string().optional(),
      topK: z.coerce.number().int().min(1).max(20).optional()
    })
    .optional()
});

/** Adapt messages for a provider that doesn't accept role: "tool".
 *  We mapped "tool" -> "system" so OpenAI/Deepseek/Perplexity won't reject the payload.
 */
function adaptMessagesForProvider(
  provider: ProviderName,
  msgs: Array<{ role: string; content: string }>
) {
  const mapToolToSystem = (m: { role: string; content: string }) =>
    m.role === "tool" ? { role: "system", content: m.content } : m;

  switch (provider) {
    case "openai":
    case "deepseek":
      return msgs.map(mapToolToSystem);
    case "perplexity":
      return normalizePerplexityMessages(msgs);
    default:
      return msgs;
  }
}

function normalizePerplexityMessages(msgs: Array<{ role: string; content: string }>) {
  const systemMessages = msgs.filter((m) => m.role === "system");
  const others = msgs.filter((m) => m.role !== "system");

  const normalized: Array<{ role: string; content: string }> = [];
  let lastRole: "assistant" | "user" | null = null;

  for (const msg of others) {
    if (msg.role === "tool") {
      const content = msg.content || "";
      if (lastRole === "assistant" && normalized.length) {
        normalized[normalized.length - 1].content += `\n\n[Tool]\n${content}`;
      } else {
        normalized.push({ role: "assistant", content: `Tool output:\n${content}` });
        lastRole = "assistant";
      }
      continue;
    }
    if (msg.role === "assistant") {
      if (lastRole === "assistant" && normalized.length) {
        normalized[normalized.length - 1].content += `\n\n${msg.content}`;
        continue;
      }
      normalized.push(msg);
      lastRole = "assistant";
      continue;
    }
    if (msg.role === "user") {
      if (lastRole === "user" && normalized.length) {
        normalized[normalized.length - 1].content += `\n\n${msg.content}`;
        continue;
      }
      normalized.push(msg);
      lastRole = "user";
      continue;
    }
    normalized.push({ role: "user", content: msg.content });
    lastRole = "user";
  }

  return [...systemMessages, ...normalized];
}

function normalizeSummaryText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function roleLabel(role: string) {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "system":
      return "System";
    case "tool":
      return "Tool";
    default:
      return role;
  }
}

function buildSummaryMessage(
  messages: Array<{ role: string; content: string }>
): string | null {
  if (!messages.length) return null;

  const bullets: string[] = [];
  let total = "Summary of earlier conversation:".length;

  for (const msg of messages) {
    const snippet = normalizeSummaryText(msg.content).slice(0, SUMMARY_PER_MESSAGE_LIMIT);
    if (!snippet) continue;
    const needsEllipsis = normalizeSummaryText(msg.content).length > snippet.length;
    const line = `- ${roleLabel(msg.role)}: ${snippet}${needsEllipsis ? "..." : ""}`;
    const projectedTotal = total + (bullets.length ? 1 : 0) + line.length;
    if (projectedTotal > SUMMARY_CHAR_LIMIT) {
      const remaining = SUMMARY_CHAR_LIMIT - total - (bullets.length ? 1 : 0);
      if (remaining > 10) {
        bullets.push(`${line.slice(0, remaining).replace(/\s+$/,"")}...`);
      }
      break;
    }
    bullets.push(line);
    total += (bullets.length ? 1 : 0) + line.length;
  }

  if (!bullets.length) return null;
  return `Summary of earlier conversation:\n${bullets.join("\n")}`;
}

export async function chatRoutes(app: FastifyInstance) {
  app.post("/chat", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { conversationId, promptId: rawPromptId, provider, model, messages, tool, knowledge } = ChatBody.parse(req.body || {});
    if (!messages?.length) return reply.code(400).send({ error: "messages is required" });

    // 1) Load user (hotelId used for policy)
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, hotelId: true }
    });
    if (!user) return reply.code(401).send({ error: "User not found" });

    // 2) If continuing, verify ownership and load existing conversation
    const existingConv = conversationId
      ? await prismaAny.conversation.findFirst({
          where: { id: conversationId, userId: user.id },
          select: { id: true, provider: true, model: true, hotelId: true }
        })
      : null;
    if (conversationId && !existingConv) {
      return reply.code(404).send({ error: "Conversation not found" });
    }

    // 3) Hotel provider toggles (allowed set + hotel defaults)
    const hotelIdForPolicy = existingConv?.hotelId ?? user.hotelId;

    let promptId: string | null = null;
    if (!existingConv && rawPromptId) {
      const prompt = await prismaAny.prompt.findFirst({
        where: { id: rawPromptId, hotelId: hotelIdForPolicy },
        select: { id: true }
      });
      if (!prompt) {
        return reply.code(400).send({ error: "Invalid promptId for this hotel" });
      }
      promptId = prompt.id;
    }
    const toggles = await prisma.hotelProviderToggle.findMany({
      where: { hotelId: hotelIdForPolicy, isEnabled: true },
      select: { provider: true, defaultModel: true }
    });
    const hotelAllowed = new Set<ProviderName>(toggles.map(t => t.provider as ProviderName));

    // 4) User preferences (enabled subset + per-provider model + defaultProvider)
    const prefs = await prisma.userPreference.findUnique({ where: { userId: user.id } });
    const userEnabled = (prefs?.enabledProviders as ProviderName[] | null) ?? [];
    const userHasRestrictions = userEnabled.length > 0;
    const canUse = (p: ProviderName) => hotelAllowed.has(p) && (!userHasRestrictions || userEnabled.includes(p));

    // 5) Choose provider
    let chosenProvider: ProviderName | undefined = provider as ProviderName | undefined;
    if (chosenProvider) {
      if (!canUse(chosenProvider)) {
        return reply.code(403).send({
          error: hotelAllowed.has(chosenProvider)
            ? `Provider ${chosenProvider} is not enabled in user settings`
            : `Provider ${chosenProvider} is disabled for this hotel`
        });
      }
    } else if (existingConv && canUse(existingConv.provider as ProviderName)) {
      chosenProvider = existingConv.provider as ProviderName;
    } else if (prefs?.defaultProvider && canUse(prefs.defaultProvider as ProviderName)) {
      chosenProvider = prefs.defaultProvider as ProviderName;
    } else {
      chosenProvider = (["openai", "deepseek", "perplexity", "claude"] as const).find(canUse);
    }
    if (!chosenProvider) return reply.code(403).send({ error: "No provider available (hotel or user disabled all)" });

    const activeFineTuneModel =
      chosenProvider === "openai"
        ? await prisma.fineTuneModel.findFirst({
            where: {
              hotelId: hotelIdForPolicy,
              provider: PrismaProvider.openai,
              status: FineTuneModelStatus.active
            },
            orderBy: { activatedAt: "desc" }
          })
        : null;

    const persistedHistory: Array<{ role: string; content: string }> = [];
    let memoryMessage: { id: string; content: string } | null = null;
    if (existingConv) {
      const history = await prisma.message.findMany({
        where: { conversationId: existingConv.id },
        orderBy: { createdAt: "asc" }
      });
      for (const item of history) {
        if (item.role === MEMORY_MESSAGE_ROLE) {
          memoryMessage = { id: item.id, content: item.content };
          continue;
        }
        persistedHistory.push({ role: item.role, content: item.content });
      }
    }

    // 6) Choose model
    const perUserModel =
      chosenProvider === "openai"
        ? prefs?.modelOpenAI
        : chosenProvider === "deepseek"
        ? prefs?.modelDeepseek
        : chosenProvider === "perplexity"
        ? prefs?.modelPerplexity
        : prefs?.modelClaude;

    const hotelDefault =
      toggles.find(t => (t.provider as ProviderName) === chosenProvider)?.defaultModel || undefined;

    const continuingSameProvider =
      !!existingConv && (provider == null || existingConv.provider === chosenProvider);

    const fineTuneModelId = activeFineTuneModel?.modelId;

    const chosenModel =
      model ||
      (continuingSameProvider ? existingConv?.model : undefined) ||
      perUserModel ||
      fineTuneModelId ||
      hotelDefault ||
      (chosenProvider === "openai"
        ? process.env.OPENAI_MODEL
        : chosenProvider === "deepseek"
        ? process.env.DEEPSEEK_MODEL
        : chosenProvider === "perplexity"
        ? process.env.PERPLEXITY_MODEL
        : process.env.CLAUDE_MODEL) ||
      "gpt-4o-mini";

    // 7) BYOK: load per-hotel credential (optional)
    const cred = await prisma.hotelProviderCredential.findUnique({
      where: { hotelId_provider: { hotelId: hotelIdForPolicy, provider: chosenProvider as any } }
    });

    let apiKeyOverride: string | undefined;
    let baseURLOverride: string | undefined;

    if (cred && cred.isActive) {
      try {
        apiKeyOverride = decryptSecret(
          cred.encKey as unknown as Buffer,
          cred.iv as unknown as Buffer,
          cred.tag as unknown as Buffer
        );
        baseURLOverride = cred.baseUrl || undefined;
      } catch {
        return reply.code(500).send({ error: "Failed to decrypt provider credential" });
      }
    }

    // 7.5) Optional MCP tool execution (pre-LLM)
    // We'll add the tool result to the *chat context*, but send it to the provider as a "system" message (not "tool")
    const summaryForLLM = memoryMessage?.content?.trim();
    const systemContexts: string[] = [];
    if (summaryForLLM) systemContexts.push(summaryForLLM);
    let messagesForLLM: Array<{ role: string; content: string }> = [];
    let attachmentContextForDB: string | undefined;
    if (existingConv) {
      const attachments = await prisma.conversationFile.findMany({
        where: { conversationId: existingConv.id, extractedText: { not: null } },
        orderBy: { createdAt: "asc" },
        select: {
          originalName: true,
          mimeType: true,
          extractedText: true
        }
      });
      const attachmentContext = buildAttachmentContext(
        attachments as Array<{ originalName: string; mimeType: string; extractedText: string | null }>
      );
      if (attachmentContext) {
        systemContexts.push(attachmentContext);
        attachmentContextForDB = attachmentContext;
      }
    }
    let knowledgeContextForDB: string | undefined;
    let knowledgeUsage: { vectorStoreId: string; chunkCount: number } | undefined;
    let knowledgeConfig = knowledge ?? null;
    const knowledgeExplicitlyDisabled = knowledge?.enabled === false;
    const autoEnableKnowledge =
      !knowledgeExplicitlyDisabled &&
      (chosenProvider as ProviderName) === "openai" &&
      (!knowledgeConfig || knowledgeConfig.enabled === undefined);
    if (autoEnableKnowledge) {
      knowledgeConfig = { ...(knowledgeConfig ?? {}), enabled: true };
    }

    if (knowledgeConfig?.enabled) {
      if ((chosenProvider as ProviderName) !== "openai") {
        if (autoEnableKnowledge) {
          knowledgeConfig = null;
        } else {
          return reply.code(400).send({ error: "vector_store_not_supported_for_provider" });
        }
      }
    }

    if (knowledgeConfig?.enabled) {
      let storeRecord = knowledgeConfig.vectorStoreId
        ? await prisma.hotelVectorStore.findFirst({
            where: { id: knowledgeConfig.vectorStoreId, hotelId: hotelIdForPolicy }
          })
        : await prisma.hotelVectorStore.findFirst({
            where: { hotelId: hotelIdForPolicy, isDefault: true }
          }) ||
          (await prisma.hotelVectorStore.findFirst({
            where: { hotelId: hotelIdForPolicy },
            orderBy: { createdAt: "asc" }
          }));

      if (!storeRecord) {
        try {
          storeRecord = await ensureDefaultVectorStore(hotelIdForPolicy, req.log);
        } catch (err) {
          req.log.warn?.({ err, hotelId: hotelIdForPolicy }, "default vector store creation failed during chat");
        }
      }

      if (!storeRecord) {
        if (autoEnableKnowledge) {
          knowledgeConfig = null;
        } else {
          return reply.code(400).send({ error: "vector_store_unavailable" });
        }
      }

      if (knowledgeConfig?.enabled && storeRecord) {
        const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
        if (!latestUserMessage) {
          return reply.code(400).send({ error: "no_user_message_for_retrieval" });
        }

        let openaiClient;
        try {
          openaiClient = await getHotelOpenAIClient(hotelIdForPolicy);
        } catch (err: any) {
          if (autoEnableKnowledge) {
            knowledgeConfig = null;
            openaiClient = null;
          } else {
            return reply.code(400).send({ error: "openai_credential_missing", details: String(err?.message ?? err) });
          }
        }
        if (knowledgeConfig?.enabled && !openaiClient) {
          knowledgeConfig = null;
        }
        if (knowledgeConfig?.enabled && openaiClient) {
          try {
            const matches = await searchVectorStore(openaiClient, {
              vectorStoreId: storeRecord.openaiId,
              query: latestUserMessage.content,
              maxResults: knowledgeConfig.topK ?? 5
            });

            const chunks = matches
              .map((item: any, idx: number) => {
                const texts = (item?.content ?? [])
                  .map((c: any) => {
                    if (!c) return null;
                    if (typeof c === "string") return c.trim();
                    if (typeof c.text === "string") return c.text.trim();
                    if (typeof c.text?.value === "string") return c.text.value.trim();
                    return null;
                  })
                  .filter((txt: string | null): txt is string => !!txt);
                if (!texts.length) return null;
                const rawScore = (item as any)?.score;
                const score =
                  typeof rawScore === "number"
                    ? rawScore.toFixed(3)
                    : rawScore != null
                    ? String(rawScore)
                    : "n/a";
                return `Source ${idx + 1} (score ${score}):\n${texts.join("\n")}`;
              })
              .filter((chunk): chunk is string => typeof chunk === "string");

            if (chunks.length) {
              const contextMessage = `Use the retrieved knowledge when relevant.\n\n${chunks.join("\n\n")}`;
              systemContexts.push(contextMessage);
              knowledgeContextForDB = contextMessage;
              knowledgeUsage = { vectorStoreId: storeRecord.id, chunkCount: chunks.length };
            }
          } catch (err: any) {
            req.log.error({ err }, "vector store query failed");
            if (!autoEnableKnowledge) {
              return reply.code(500).send({ error: "vector_store_query_failed", details: String(err?.message ?? err) });
            }
          }
        }
      }
    }
    const historyWindow = persistedHistory.slice(
      Math.max(persistedHistory.length - MAX_RECENT_CONTEXT_MESSAGES, 0)
    );
    messagesForLLM = [...historyWindow, ...messages];
    if (systemContexts.length) {
      const systemMessages = systemContexts.map(content => ({ role: "system", content }));
      messagesForLLM = [...systemMessages, ...messagesForLLM];
    }
    let toolTextForDB: string | undefined; // stored in DB as role "tool"
    let toolContextForModel: string | undefined; // what the model actually sees

    if (tool) {
      const srv = await prisma.mCPServer.findFirst({
        where: { id: tool.serverId, hotelId: hotelIdForPolicy, isActive: true }
      });
      if (!srv) return reply.code(404).send({ error: "MCP server not found for this hotel" });

      let toolArgs: Record<string, unknown> = tool.args ?? {};
        if (tool.name.startsWith("brevo.") && !(toolArgs as any).apiKey) {
          const cred = await prisma.hotelProviderCredential.findUnique({
            where: { hotelId_provider: { hotelId: hotelIdForPolicy, provider: "brevo" as any } },
            select: { encKey: true, iv: true, tag: true, isActive: true }
          });
          if (!cred || !cred.isActive) {
            return reply.code(400).send({ error: "brevo_credential_missing", details: "No active Brevo credential for this hotel" });
          }
          const apiKey = decryptSecret(
            cred.encKey as unknown as Buffer,
            cred.iv as unknown as Buffer,
            cred.tag as unknown as Buffer
          );
          toolArgs = { ...toolArgs, apiKey };
        }
        
      const started = Date.now();
      try {
        const finalArgs = await injectBrevoKeyIfNeeded(user.id, srv.id, tool.args);
        const res = await mcpManager.callTool(tool.serverId, tool.name, finalArgs);
        const rawText = (res as any)?.content?.[0]?.text ?? "";
        // a label helps the model understand what it is seeing
        const labeled = `TOOL ${tool.name} RESULT:\n${rawText}`;
        // trim very large tool output (optional safety)
        const MAX_TOOL_CONTEXT = 8000;
        toolTextForDB = labeled;
        toolContextForModel = labeled.length > MAX_TOOL_CONTEXT ? labeled.slice(0, MAX_TOOL_CONTEXT) + "\n[truncated]" : labeled;

        // Push as role "tool" for *our* in-memory list; we'll adapt before sending
        messagesForLLM.push({ role: "system", content: toolContextForModel });

        // Log success
        await prisma.toolCallLog.create({
          data: {
            hotelId: hotelIdForPolicy,
            userId: user.id,
            conversationId: existingConv?.id ?? null,
            serverId: srv.id,
            toolName: tool.name,
            args: tool.args as any,
            result: (() => { try { return JSON.parse(rawText); } catch { return { text: rawText }; } })(),
            status: "ok",
            startedAt: new Date(started),
            finishedAt: new Date(),
            durationMs: Date.now() - started
          }
        });
      } catch (e: any) {
        await prisma.toolCallLog.create({
          data: {
            hotelId: hotelIdForPolicy,
            userId: user.id,
            conversationId: existingConv?.id ?? null,
            serverId: tool.serverId,
            toolName: tool.name,
            args: tool.args as any,
            error: String(e?.message ?? e),
            status: "error",
            startedAt: new Date(started),
            finishedAt: new Date(),
            durationMs: Date.now() - started
          }
        });
        return reply.code(500).send({ error: "tool_error", details: String(e?.message ?? e) });
      }
    }

    // 8) Call provider — map any "tool" role messages to "system" so OpenAI/others accept them
    const p = Providers[chosenProvider];
    let result;
    try {
      const normalizedMessages = adaptMessagesForProvider(chosenProvider as ProviderName, messagesForLLM);
      const adapted: ChatMessage[] = normalizedMessages.map(m => ({
        role: (m.role as "user" | "system" | "assistant" | "tool"),
        content: m.content
      }));
      result = await p.chat({
        model: chosenModel,
        messages: adapted,
        apiKey: apiKeyOverride,
        baseURL: baseURLOverride
      });
    } catch (e: any) {
      return reply.code(500).send({ error: `${chosenProvider} error`, details: String(e?.message ?? e) });
    }

    // 9) Persist conversation & messages
    const createdConversation = !existingConv;
    const conv = existingConv
      ? await prismaAny.conversation.update({
          where: { id: existingConv.id },
          data: { provider: chosenProvider as any, model: chosenModel, updatedAt: new Date() }
        })
      : await prismaAny.conversation.create({
          data: {
            title: messages?.[0]?.content?.slice(0, 60) || "New chat",
            provider: chosenProvider as any,
            model: chosenModel,
            promptId,
            user: { connect: { id: user.id } },
            hotel: { connect: { id: user.hotelId } }
          }
        });

    if (createdConversation) {
      scheduleFineTuneUpload(user.hotelId, req.log);
    }
    // Store inbound user + (optional) tool messages exactly as they happened
    const inbound = [...messages];
    if (toolTextForDB) inbound.push({ role: "tool", content: toolTextForDB });
    if (attachmentContextForDB) inbound.push({ role: "system", content: attachmentContextForDB });
    if (knowledgeContextForDB) inbound.push({ role: "system", content: knowledgeContextForDB });
    if (inbound.length) {
      await prisma.message.createMany({
        data: inbound.map(m => ({
          role: m.role,
          content: m.content,
          conversationId: conv.id,
          provider: chosenProvider as any,
          model: chosenModel
        }))
      });
    }

    // Store the assistant reply and return IDs
    const assistantMessage = await prisma.message.create({
      data: {
        role: "assistant",
        content: result.content,
        conversationId: conv.id,
        provider: chosenProvider as any,
        model: chosenModel
      }
    });

    const updatedHistory = [
      ...persistedHistory,
      ...inbound,
      { role: "assistant", content: result.content }
    ];
    const olderPortion = updatedHistory.slice(
      0,
      Math.max(0, updatedHistory.length - MAX_RECENT_CONTEXT_MESSAGES)
    );
    const summaryCandidate = olderPortion.length ? olderPortion : updatedHistory;
    const summaryText = buildSummaryMessage(summaryCandidate);
    if (summaryText) {
      if (memoryMessage) {
        await prisma.message.update({
          where: { id: memoryMessage.id },
          data: { content: summaryText }
        });
      } else {
        await prisma.message.create({
          data: {
            role: MEMORY_MESSAGE_ROLE,
            content: summaryText,
            conversationId: conv.id
          }
        });
      }
      try {
        await upsertConversationSummaryExample({
          hotelId: hotelIdForPolicy,
          conversationId: conv.id,
          summary: summaryText,
          title: conv.title ?? null
        });
        syncTrainingExamplesToVectorStore(hotelIdForPolicy).catch((err: any) => {
          req.log.warn({ err, hotelId: hotelIdForPolicy }, "conversation summary vector sync failed");
        });
      } catch (err) {
        req.log.warn({ err, conversationId: conv.id }, "conversation summary training example failed");
      }
    } else if (memoryMessage) {
      await prisma.message.delete({ where: { id: memoryMessage.id } });
    }

    const nextSuggestions = getPostReplySuggestions(result.content || "", "en", 3);

    return {
      conversationId: conv.id,
      assistantMessageId: assistantMessage.id,
      provider: chosenProvider,
      model: chosenModel,
      fineTuneModelId: fineTuneModelId ?? null,
      content: result.content,
      usage: result.usage,
      nextSuggestions,
      knowledge: knowledgeUsage ?? null
    };
  });

  // Archive a conversation
  app.patch("/conversations/:id/archive", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params;
    const owned = await prismaAny.conversation.findFirst({ where: { id, userId: req.user.id } });
    if (!owned) return reply.code(404).send({ error: "Not found" });
    return prismaAny.conversation.update({ where: { id }, data: { archived: true } });
  });

  // Delete a conversation
  app.delete("/conversations/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params;
    const owned = await prismaAny.conversation.findFirst({ where: { id, userId: req.user.id } });
    if (!owned) return reply.code(404).send({ error: "Not found" });
    await prisma.message.deleteMany({ where: { conversationId: id } });
    await prismaAny.conversation.delete({ where: { id } });
    return { ok: true };
  });

  // Export a conversation
  app.get("/conversations/:id/export", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params;
    const conv = await prismaAny.conversation.findFirst({ where: { id, userId: req.user.id } });
    if (!conv) return reply.code(404).send({ error: "Not found" });
    const msgs = await prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: "asc" }
    });
    return { conversation: conv, messages: msgs };
  });
}
