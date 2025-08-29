import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { assertHotelAndProvider } from "../middleware/hotelGuard.js";

export async function promptRoutes(app: FastifyInstance) {
  // From “Save as Prompt” modal (title/body/tags/version/category)
  app.post("/prompts", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply); // just loads user+hotel and checks hotel active
    if (reply.sent) return;

    const body = z.object({
      title: z.string().min(1),
      body: z.string().min(1),
      categoryId: z.string().optional(),
      tags: z.array(z.string()).optional(),
      version: z.string().optional()
    }).parse(req.body);

    return prisma.prompt.create({
      data: {
        hotelId: user.hotelId,
        authorId: user.id,
        title: body.title,
        body: body.body,
        categoryId: body.categoryId ?? null,
        tags: body.tags ?? [],
        version: body.version ?? null
      }
    });
  });

  // List / filter library (hotel scoped)
  app.get("/prompts", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;

    const q = z.object({
      search: z.string().optional(),
      categoryId: z.string().optional(),
      archived: z.coerce.boolean().optional()
    }).parse(req.query);

    return prisma.prompt.findMany({
      where: {
        hotelId: user.hotelId,
        archived: q.archived ?? false,
        AND: q.search ? [{ OR: [
          { title: { contains: q.search, mode: "insensitive" } },
          { body:  { contains: q.search, mode: "insensitive" } },
          { tags:  { has: q.search } }
        ] }] : undefined,
        categoryId: q.categoryId ?? undefined
      },
      orderBy: { updatedAt: "desc" }
    });
  });

  app.get("/prompts/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params;
    return prisma.prompt.findFirst({ where: { id, hotelId: user.hotelId } });
  });

  app.patch("/prompts/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params;
    const body = z.object({
      title: z.string().optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      version: z.string().optional(),
      archived: z.boolean().optional(),
      categoryId: z.string().nullable().optional()
    }).parse(req.body);

    return prisma.prompt.update({
      where: { id },
      data: body
    });
  });

  app.delete("/prompts/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params;
    await prisma.prompt.delete({ where: { id } });
    return { ok: true };
  });
}