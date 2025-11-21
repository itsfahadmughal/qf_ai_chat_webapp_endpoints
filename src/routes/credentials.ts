import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { encryptSecret } from "../crypto/secrets.js";

const ProviderEnum = z.enum(["openai","deepseek","perplexity"]);

export async function credentialRoutes(app: FastifyInstance) {
  // PUT set/rotate key for a hotel+provider
  app.put("/hotels/:id/providers/:provider/credentials", async (req: any, reply) => {
    const { id, provider } = req.params as { id: string; provider: z.infer<typeof ProviderEnum> };
    const body = z.object({
      apiKey: z.string().min(8),
      baseUrl: z.string().url().optional(),
      label: z.string().optional()
    }).parse(req.body ?? {});

    // ensure hotel exists
    const hotel = await prisma.hotel.findUnique({ where: { id } });
    if (!hotel) return reply.code(404).send({ error: "Hotel not found" });

    const { encKey, iv, tag } = encryptSecret(body.apiKey);
    const encKeyUint = new Uint8Array(encKey);
    const ivUint = new Uint8Array(iv);
    const tagUint = new Uint8Array(tag);
    const last4 = body.apiKey.slice(-4);

    const saved = await prisma.hotelProviderCredential.upsert({
      where: { hotelId_provider: { hotelId: id, provider: provider as any } },
      create: {
        hotelId: id,
        provider: provider as any,
        encKey: encKeyUint,
        iv: ivUint,
        tag: tagUint,
        baseUrl: body.baseUrl,
        label: body.label,
        last4,
        isActive: true
      },
      update: {
        encKey: encKeyUint,
        iv: ivUint,
        tag: tagUint,
        baseUrl: body.baseUrl,
        label: body.label,
        last4,
        isActive: true
      }
    });

    // never return the raw key
    return {
      ok: true,
      provider: provider,
      last4: saved.last4,
      label: saved.label ?? null,
      baseUrl: saved.baseUrl ?? null,
      updatedAt: saved.updatedAt
    };
  });

  // GET metadata only (no key)
  app.get("/hotels/:id/providers/:provider/credentials", async (req: any, reply) => {
    const { id, provider } = req.params as { id: string; provider: z.infer<typeof ProviderEnum> };
    const cred = await prisma.hotelProviderCredential.findUnique({
      where: { hotelId_provider: { hotelId: id, provider: provider as any } }
    });
    if (!cred) return reply.code(404).send({ error: "No credential set" });
    return {
      provider,
      hasKey: true,
      last4: cred.last4,
      label: cred.label ?? null,
      baseUrl: cred.baseUrl ?? null,
      isActive: cred.isActive,
      updatedAt: cred.updatedAt
    };
  });

  // DELETE (revoke/disable) the key
  app.delete("/hotels/:id/providers/:provider/credentials", async (req: any, reply) => {
    const { id, provider } = req.params as { id: string; provider: z.infer<typeof ProviderEnum> };
    // soft-disable so we keep audit/rotation history
    const cred = await prisma.hotelProviderCredential.update({
      where: { hotelId_provider: { hotelId: id, provider: provider as any } },
      data: { isActive: false }
    }).catch(() => null);

    if (!cred) return reply.code(404).send({ error: "No credential to disable" });
    return { ok: true };
  });
}
