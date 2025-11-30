// src/routes/settings.ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";

const ProviderEnum = z.enum(["openai", "deepseek", "perplexity", "claude"]);

const UpdateSchema = z.object({
  enabledProviders: z.array(ProviderEnum).optional(),   // e.g. ["openai","deepseek"]
  defaultProvider: ProviderEnum.nullable().optional(),  // must be in enabledProviders (if provided)
  models: z.object({
    openai: z.string().optional(),
    deepseek: z.string().optional(),
    perplexity: z.string().optional(),
    claude: z.string().optional()
  }).optional(),
  locale: z.string().optional()
});

export async function settingsRoutes(app: FastifyInstance) {
  // GET: user prefs + hotel-allowed providers (so UI knows what can be toggled)
  app.get("/settings/preferences", { preHandler: app.authenticate }, async (req: any) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return { error: "User not found" };

    const [toggles, prefs] = await Promise.all([
      prisma.hotelProviderToggle.findMany({
        where: { hotelId: user.hotelId },
        select: { provider: true, isEnabled: true, defaultModel: true }
      }),
      prisma.userPreference.findUnique({ where: { userId: user.id } })
    ]);

    const hotelAllowed = toggles
      .filter(t => t.isEnabled)
      .map(t => ({ provider: t.provider, defaultModel: t.defaultModel || null }));

    return {
      hotelAllowed, // what the hotel permits
      userPrefs: {
        enabledProviders: prefs?.enabledProviders ?? [],
        defaultProvider: prefs?.defaultProvider ?? null,
        models: {
          openai: prefs?.modelOpenAI ?? null,
          deepseek: prefs?.modelDeepseek ?? null,
          perplexity: prefs?.modelPerplexity ?? null,
          claude: prefs?.modelClaude ?? null
        },
        locale: prefs?.locale ?? null
      }
    };
  });

  // PUT: set which providers the user enables + default + per-provider model
  app.put("/settings/preferences", { preHandler: app.authenticate }, async (req: any, reply) => {
    const body = UpdateSchema.parse(req.body ?? {});
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return reply.code(404).send({ error: "User not found" });

    // hotel-allowed set
    const allowed = new Set(
      (await prisma.hotelProviderToggle.findMany({
        where: { hotelId: user.hotelId, isEnabled: true },
        select: { provider: true }
      })).map(t => t.provider)
    );

    // validate enabledProviders ⊆ allowed
    const enabled = body.enabledProviders ?? [];
    for (const p of enabled) {
      if (!allowed.has(p)) {
        return reply.code(400).send({ error: `Provider ${p} is disabled for this hotel` });
      }
    }

    // validate defaultProvider
    if (body.defaultProvider != null) {
      if (enabled.length > 0 && !enabled.includes(body.defaultProvider)) {
        return reply.code(400).send({ error: `defaultProvider must be in enabledProviders` });
      }
      if (!allowed.has(body.defaultProvider)) {
        return reply.code(400).send({ error: `defaultProvider ${body.defaultProvider} not allowed by hotel` });
      }
    }

    const saved = await prisma.userPreference.upsert({
      where: { userId: user.id },
      update: {
        enabledProviders: enabled,
        defaultProvider: body.defaultProvider ?? null,
        modelOpenAI: body.models?.openai,
        modelDeepseek: body.models?.deepseek,
        modelPerplexity: body.models?.perplexity,
        modelClaude: body.models?.claude,
        locale: body.locale
      },
      create: {
        userId: user.id,
        enabledProviders: enabled,
        defaultProvider: body.defaultProvider ?? null,
        modelOpenAI: body.models?.openai,
        modelDeepseek: body.models?.deepseek,
        modelPerplexity: body.models?.perplexity,
        modelClaude: body.models?.claude,
        locale: body.locale
      }
    });

    return { ok: true, saved };
  });
}
