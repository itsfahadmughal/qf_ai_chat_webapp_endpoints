import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../db.js";

export async function assertHotelAndProvider(
  req: FastifyRequest & { user?: { id: string } },
  reply: FastifyReply,
  provider?: "openai"|"deepseek"|"perplexity"|"claude"
) {
  // Load user + hotel once
  const user = await prisma.user.findUnique({
    where: { id: (req as any).user.id },
    include: { hotel: true }
  });
  if (!user?.hotel) return reply.code(403).send({ error: "No hotel assigned" });
  if (!user.hotel.isActive) return reply.code(403).send({ error: "Hotel is deactivated" });

  if (provider) {
    const toggle = await prisma.hotelProviderToggle.findUnique({
      where: { hotelId_provider: { hotelId: user.hotelId, provider } }
    });
    if (toggle && !toggle.isEnabled) {
      return reply.code(403).send({ error: `Provider ${provider} is disabled for this hotel` });
    }
  }

  return { user, hotel: user.hotel };
}
