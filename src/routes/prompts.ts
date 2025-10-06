// src/routes/prompts.ts
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";
import { assertHotelAndProvider } from "../middleware/hotelGuard.js";

export async function promptRoutes(app: FastifyInstance) {
  // Guard: only authors may create/update/delete prompts
  const ensureAuthor: preHandlerHookHandler = async (req: any, reply) => {
    const role = (req.user?.role ?? "reader") as "author" | "reader";
    if (role !== "author") {
      return reply.code(403).send({ error: "Only authors can modify prompts" });
    }
  };

  // CREATE (author-only)
  app.post(
    "/prompts",
    { preHandler: [app.authenticate as any, ensureAuthor] },
    async (req: any, reply) => {
      const { user } = await assertHotelAndProvider(req, reply); // loads user & checks hotel active
      if (reply.sent) return;

      const body = z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        categoryId: z.string().optional(),
        categoryName: z.string().optional(), 
        tags: z.array(z.string()).optional(),
        version: z.string().optional()
      }).parse(req.body);

      // Resolve category
      let resolvedCategoryId: string | null = null;
      if (body.categoryId) {
        const exists = await prisma.promptCategory.findFirst({
          where: { id: body.categoryId, hotelId: user.hotelId },
          select: { id: true }
        });
        if (!exists) {
          return reply.code(400).send({ error: "Invalid categoryId for this hotel" });
        }
        resolvedCategoryId = body.categoryId;
      } else if (body.categoryName) {
        const cat = await prisma.promptCategory.upsert({
          where: { hotelId_name: { hotelId: user.hotelId, name: body.categoryName } },
          update: {},
          create: { hotelId: user.hotelId, name: body.categoryName }
        });
        resolvedCategoryId = cat.id;
      }

      return prisma.prompt.create({
        data: {
          hotelId: user.hotelId,
          authorId: user.id,
          title: body.title,
          body: body.body,
          categoryId: resolvedCategoryId,
          tags: body.tags ?? [],
          version: body.version ?? null
        }
      });
    }
  );

  // LIST (both roles)
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
        AND: q.search
          ? [{
              OR: [
                { title: { contains: q.search, mode: "insensitive" } },
                { body:  { contains: q.search, mode: "insensitive" } },
                { tags:  { has: q.search } }
              ]
            }]
          : undefined,
        categoryId: q.categoryId ?? undefined
      },
      orderBy: { updatedAt: "desc" },
      include: { author: { select: { id: true, email: true } },
      category: { select: { id: true, name: true } } } 
    });
  });

  // GET (both roles)
  app.get("/prompts/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };

    const row = await prisma.prompt.findFirst({
      where: { id, hotelId: user.hotelId },
      include: { author: { select: { id: true, email: true } },
      category: { select: { id: true, name: true } } }
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    return row;
  });

  // UPDATE (author-only; scoped to same hotel)
  app.patch(
    "/prompts/:id",
    { preHandler: [app.authenticate as any, ensureAuthor] },
    async (req: any, reply) => {
      const { user } = await assertHotelAndProvider(req, reply);
      if (reply.sent) return;

      const { id } = req.params as { id: string };
      const body = z.object({
        title: z.string().optional(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        version: z.string().optional(),
        archived: z.boolean().optional(),
        categoryId: z.string().nullable().optional()
      }).parse(req.body);

      // ensure the prompt belongs to the same hotel
      const existing = await prisma.prompt.findFirst({
        where: { id, hotelId: user.hotelId }
      });
      if (!existing) return reply.code(404).send({ error: "Not found" });

      // (optional) If you want to restrict to the creator only, uncomment:
      if (existing.authorId !== user.id) return reply.code(403).send({ error: "Only the creator can update this prompt" });

      const updated = await prisma.prompt.update({ where: { id }, data: body });
      return updated;
    }
  );

  // DELETE (author-only; scoped to same hotel)
  app.delete(
    "/prompts/:id",
    { preHandler: [app.authenticate as any, ensureAuthor] },
    async (req: any, reply) => {
      const { user } = await assertHotelAndProvider(req, reply);
      if (reply.sent) return;

      const { id } = req.params as { id: string };

      const existing = await prisma.prompt.findFirst({
        where: { id, hotelId: user.hotelId }
      });
      if (!existing) return reply.code(404).send({ error: "Not found" });

      // (optional) restrict to creator only:
      if (existing.authorId !== user.id) return reply.code(403).send({ error: "Only the creator can delete this prompt" });

      await prisma.prompt.delete({ where: { id } });
      return { ok: true };
    }
  );

  app.get("/prompt-categories", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    return prisma.promptCategory.findMany({
      where: { hotelId: user.hotelId },
      orderBy: { name: "asc" }
    });
  });

  // Create category (author)
  app.post("/prompt-categories", { preHandler: [app.authenticate as any, ensureAuthor] }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const body = z.object({ name: z.string().min(1) }).parse(req.body ?? {});
    return prisma.promptCategory.upsert({
      where: { hotelId_name: { hotelId: user.hotelId, name: body.name } },
      update: {},
      create: { hotelId: user.hotelId, name: body.name }
    });
  });
}