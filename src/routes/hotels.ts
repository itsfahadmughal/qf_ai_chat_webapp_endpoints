import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";

export async function hotelRoutes(app: FastifyInstance) {
  // Create hotel
  app.post("/hotels", async (req, reply) => {
    const body = z.object({ name: z.string() }).parse(req.body);
    return prisma.hotel.create({ data: { name: body.name } });
  });

   app.get("/hotels", async (req: any) => {
    const q = z.object({ activeOnly: z.coerce.boolean().optional() })
                .parse(req.query ?? {});
      return prisma.hotel.findMany({
        where: q.activeOnly ? { isActive: true } : undefined,
        select: { id: true, name: true, isActive: true, createdAt: true},
        orderBy: { name: "asc" }
      });
    });

  // Toggle hotel active/deactive
  app.patch("/hotels/:id/active", async (req, reply) => {
    const { id } = req.params as any;
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    return prisma.hotel.update({ where: { id }, data: { isActive } });
  });

  // Per-hotel provider toggle & default model
  app.put("/hotels/:id/providers/:provider", async (req, reply) => {
    const { id, provider } = req.params as any;
    const { isEnabled, defaultModel } = z.object({
      isEnabled: z.boolean(),
      defaultModel: z.string().optional()
    }).parse(req.body);

    return prisma.hotelProviderToggle.upsert({
      where: { hotelId_provider: { hotelId: id, provider } },
      update: { isEnabled, defaultModel },
      create: { hotelId: id, provider, isEnabled, defaultModel }
    });
  });

  app.get("/hotels/:id/providers", async (req, reply) => {
    const { id } = req.params as any;
    return prisma.hotelProviderToggle.findMany({ where: { hotelId: id } });
  });
}
