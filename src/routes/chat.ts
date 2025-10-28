// src/routes/chat.ts
import type { FastifyInstance } from "fastify";
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

const prismaAny = prisma as any;

type ProviderName = "openai" | "deepseek" | "perplexity";

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
    case "perplexity":
      return msgs.map(mapToolToSystem);
    default:
      return msgs;
  }
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
      chosenProvider = (["openai", "deepseek", "perplexity"] as const).find(canUse);
    }
    if (!chosenProvider) return reply.code(403).send({ error: "No provider available (hotel or user disabled all)" });

    // 6) Choose model
    const perUserModel =
      chosenProvider === "openai"
        ? prefs?.modelOpenAI
        : chosenProvider === "deepseek"
        ? prefs?.modelDeepseek
        : prefs?.modelPerplexity;

    const hotelDefault =
      toggles.find(t => (t.provider as ProviderName) === chosenProvider)?.defaultModel || undefined;

    const continuingSameProvider =
      !!existingConv && (provider == null || existingConv.provider === chosenProvider);

    const chosenModel =
      model ||
      (continuingSameProvider ? existingConv?.model : undefined) ||
      perUserModel ||
      hotelDefault ||
      (chosenProvider === "openai"
        ? process.env.OPENAI_MODEL
        : chosenProvider === "deepseek"
        ? process.env.DEEPSEEK_MODEL
        : process.env.PERPLEXITY_MODEL) ||
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
    let messagesForLLM = [...messages];
    let knowledgeContextForDB: string | undefined;
    let knowledgeUsage: { vectorStoreId: string; chunkCount: number } | undefined;

    if (knowledge?.enabled) {
      if ((chosenProvider as ProviderName) !== "openai") {
        return reply.code(400).send({ error: "vector_store_not_supported_for_provider" });
      }

      const storeRecord = knowledge.vectorStoreId
        ? await prisma.hotelVectorStore.findFirst({
            where: { id: knowledge.vectorStoreId, hotelId: hotelIdForPolicy }
          })
        : await prisma.hotelVectorStore.findFirst({
            where: { hotelId: hotelIdForPolicy, isDefault: true }
          }) ||
          (await prisma.hotelVectorStore.findFirst({
            where: { hotelId: hotelIdForPolicy },
            orderBy: { createdAt: "asc" }
          }));

      if (!storeRecord) {
        return reply.code(400).send({ error: "vector_store_unavailable" });
      }

      const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
      if (!latestUserMessage) {
        return reply.code(400).send({ error: "no_user_message_for_retrieval" });
      }

      let openaiClient;
      try {
        openaiClient = await getHotelOpenAIClient(hotelIdForPolicy);
      } catch (err: any) {
        return reply.code(400).send({ error: "openai_credential_missing", details: String(err?.message ?? err) });
      }

      try {
        const matches = await searchVectorStore(openaiClient, {
          vectorStoreId: storeRecord.openaiId,
          query: latestUserMessage.content,
          maxResults: knowledge.topK ?? 5
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
          messagesForLLM.unshift({ role: "system", content: contextMessage });
          knowledgeContextForDB = contextMessage;
          knowledgeUsage = { vectorStoreId: storeRecord.id, chunkCount: chunks.length };
        }
      } catch (err: any) {
        req.log.error({ err }, "vector store query failed");
        return reply.code(500).send({ error: "vector_store_query_failed", details: String(err?.message ?? err) });
      }
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
      const adapted: ChatMessage[] = messagesForLLM.map(m => ({
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
    if (knowledgeContextForDB) inbound.push({ role: "system", content: knowledgeContextForDB });
    if (inbound.length) {
      await prisma.message.createMany({
        data: inbound.map(m => ({
          role: m.role,
          content: m.content,
          conversationId: conv.id
        }))
      });
    }

    // Store the assistant reply and return IDs
    const assistantMessage = await prisma.message.create({
      data: { role: "assistant", content: result.content, conversationId: conv.id }
    });

    const nextSuggestions = getPostReplySuggestions(result.content || "", "en", 3);

    return {
      conversationId: conv.id,
      assistantMessageId: assistantMessage.id,
      provider: chosenProvider,
      model: chosenModel,
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
