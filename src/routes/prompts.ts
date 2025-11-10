// src/routes/prompts.ts
import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { TrainingExampleSource, TrainingVectorStatus } from "@prisma/client";
import { prisma } from "../db.js";
import { z } from "zod";
import { assertHotelAndProvider } from "../middleware/hotelGuard.js";

const PromptFeedbackBody = z.object({
  feedbackScore: z.number().min(0).max(100),
  reaction: z.enum(["like", "dislike", "none"]).optional()
});

const PromptExportQuery = z.object({
  format: z.enum(["json", "jsonl", "word"]).default("json")
});

const TrackPromptUsageBody = z.object({
  count: z.coerce.number().int().min(1).max(1000).default(1),
  source: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  metadata: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional(),
  usedById: z.string().optional()
});

const MostUsedPromptsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

const prismaAny = prisma as any;

type PromptFeedbackStats = {
  feedbackCount: number;
  likeCount: number;
  dislikeCount: number;
  averageScore: number;
};

async function fetchPromptFeedbackStats(promptIds: string[]) {
  if (!promptIds.length) return new Map<string, PromptFeedbackStats>();
  const rows = await (prisma as any).promptFeedback.findMany({
    where: { promptId: { in: promptIds } },
    select: { promptId: true, feedbackScore: true, reaction: true }
  });

  const map = new Map<
    string,
    PromptFeedbackStats & {
      totalScore: number;
    }
  >();

  for (const row of rows) {
    if (!map.has(row.promptId)) {
      map.set(row.promptId, {
        feedbackCount: 0,
        likeCount: 0,
        dislikeCount: 0,
        averageScore: 0,
        totalScore: 0
      });
    }
    const stats = map.get(row.promptId)!;
    stats.feedbackCount += 1;
    stats.totalScore += row.feedbackScore;
    if (row.reaction === "like") stats.likeCount += 1;
    if (row.reaction === "dislike") stats.dislikeCount += 1;
  }

  const finalMap = new Map<string, PromptFeedbackStats>();
  for (const [promptId, stats] of map.entries()) {
    const average = stats.feedbackCount ? Number((stats.totalScore / stats.feedbackCount).toFixed(2)) : 0;
    finalMap.set(promptId, {
      feedbackCount: stats.feedbackCount,
      likeCount: stats.likeCount,
      dislikeCount: stats.dislikeCount,
      averageScore: average
    });
  }
  return finalMap;
}

function resolveUsageTag(stats?: PromptFeedbackStats) {
  if (!stats || stats.feedbackCount === 0) return "saved";
  if (stats.likeCount > stats.dislikeCount) return "mostly used";
  return "rarely used";
}

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

      const body = z
        .object({
          title: z.string().min(1),
          body: z.string().min(1),
          categoryId: z.string().optional(),
          categoryName: z.string().optional(),
          tags: z.array(z.string()).optional(),
          version: z.string().optional(),
          assignedUserId: z.union([z.string(), z.array(z.string())]).optional(),
          assignedUserIds: z.array(z.string()).optional(),
          departmentId: z.string().optional()
        })
        .parse(req.body);

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

      const assignedUserIdsInput =
        body.assignedUserIds !== undefined
          ? body.assignedUserIds
          : body.assignedUserId !== undefined
            ? Array.isArray(body.assignedUserId)
              ? body.assignedUserId
              : [body.assignedUserId]
            : undefined;

      const assignedUserIds: string[] = [];
      if (assignedUserIdsInput?.length) {
        const uniqueIds = Array.from(new Set(assignedUserIdsInput));
        const found = await prisma.user.findMany({
          where: { id: { in: uniqueIds }, hotelId: user.hotelId },
          select: { id: true }
        });
        if (found.length !== uniqueIds.length) {
          return reply.code(400).send({ error: "Invalid assigned user IDs for this hotel" });
        }
        assignedUserIds.push(...found.map((f) => f.id));
      }

      let departmentId: string | null = null;
      if (body.departmentId) {
        const dept = await prismaAny.department.findFirst({
          where: { id: body.departmentId, hotelId: user.hotelId },
          select: { id: true }
        });
        if (!dept) {
          return reply.code(400).send({ error: "Invalid departmentId for this hotel" });
        }
        departmentId = dept.id;
      }

      return prismaAny.prompt.create({
        data: {
          hotelId: user.hotelId,
          authorId: user.id,
          title: body.title,
          body: body.body,
          categoryId: resolvedCategoryId,
          tags: body.tags ?? [],
          version: body.version ?? null,
          departmentId,
          assignedUsers: assignedUserIds.length
            ? {
                connect: assignedUserIds.map((id) => ({ id }))
              }
            : undefined
        },
        include: {
          assignedUsers: { select: { id: true, email: true } }
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

    const prompts = await prismaAny.prompt.findMany({
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
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      } 
    });
    const promptRecords = prompts as any[];

    const statsMap = await fetchPromptFeedbackStats(promptRecords.map((p: any) => p.id));

    return promptRecords.map((prompt: any) => {
      const stats = statsMap.get(prompt.id);
      return {
        ...prompt,
        feedbackCount: stats?.feedbackCount ?? 0,
        usageTag: resolveUsageTag(stats)
      };
    });
  });

  app.get("/prompts/by-user/:userId", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { userId } = req.params as { userId: string };

    const assignee = await prisma.user.findFirst({
      where: { id: userId, hotelId: user.hotelId },
      select: { id: true }
    });
    if (!assignee) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    const promptRecords = (await prismaAny.prompt.findMany({
      where: {
        hotelId: user.hotelId,
        assignedUsers: { some: { id: userId } },
        archived: false
      },
      orderBy: { updatedAt: "desc" },
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      }
    })) as any[];

    const statsMap = await fetchPromptFeedbackStats(promptRecords.map((p: any) => p.id));

    return promptRecords.map((prompt: any) => {
      const stats = statsMap.get(prompt.id);
      return {
        ...prompt,
        feedbackCount: stats?.feedbackCount ?? 0,
        usageTag: resolveUsageTag(stats)
      };
    });
  });

  app.get("/prompts/by-department/:departmentId", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { departmentId } = req.params as { departmentId: string };

    const department = await prismaAny.department.findFirst({
      where: { id: departmentId, hotelId: user.hotelId },
      select: { id: true }
    });
    if (!department) {
      return reply.code(404).send({ error: "department_not_found" });
    }

    const promptRecords = (await prismaAny.prompt.findMany({
      where: {
        hotelId: user.hotelId,
        departmentId,
        archived: false
      },
      orderBy: { updatedAt: "desc" },
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      }
    })) as any[];

    const statsMap = await fetchPromptFeedbackStats(promptRecords.map((p: any) => p.id));

    return promptRecords.map((prompt: any) => {
      const stats = statsMap.get(prompt.id);
      return {
        ...prompt,
        feedbackCount: stats?.feedbackCount ?? 0,
        usageTag: resolveUsageTag(stats)
      };
    });
  });

  // Prompts by category
  app.get("/prompts/category/:categoryId", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { categoryId } = req.params as { categoryId: string };

    const prompts = await prismaAny.prompt.findMany({
      where: { hotelId: user.hotelId, categoryId, archived: false },
      orderBy: { updatedAt: "desc" },
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      }
    });

    const promptRecords = prompts as any[];
    const statsMap = await fetchPromptFeedbackStats(promptRecords.map((p: any) => p.id));

    return promptRecords.map((prompt: any) => {
      const stats = statsMap.get(prompt.id);
      return {
        ...prompt,
        feedbackCount: stats?.feedbackCount ?? 0,
        usageTag: resolveUsageTag(stats)
      };
    });
  });

  // GET single prompt (both roles)
  app.get("/prompts/:id", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };

    const row = await prismaAny.prompt.findFirst({
      where: { id, hotelId: user.hotelId },
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      }
    });
    if (!row) return reply.code(404).send({ error: "Not found" });
    return row;
  });

  // Track prompt usage manually
  app.post("/prompts/:id/usage", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const body = TrackPromptUsageBody.parse(req.body ?? {});

    const prompt = await prisma.prompt.findFirst({
      where: { id, hotelId: user.hotelId },
      select: { id: true, hotelId: true }
    });
    if (!prompt) {
      return reply.code(404).send({ error: "prompt_not_found" });
    }

    let usedById: string | null = null;
    if (body.usedById) {
      const allowedUser = await prisma.user.findFirst({
        where: { id: body.usedById, hotelId: user.hotelId },
        select: { id: true }
      });
      if (!allowedUser) {
        return reply.code(400).send({ error: "invalid_user", details: "usedById must belong to the same hotel" });
      }
      usedById = allowedUser.id;
    } else {
      usedById = user.id;
    }

    const usage = await prisma.promptUsage.create({
      data: {
        promptId: prompt.id,
        hotelId: prompt.hotelId,
        usedById,
        source: body.source || null,
        notes: body.notes || null,
        count: body.count,
        metadata: body.metadata ?? null
      }
    });

    return {
      id: usage.id,
      promptId: usage.promptId,
      hotelId: usage.hotelId,
      usedById: usage.usedById,
      count: usage.count,
      source: usage.source,
      notes: usage.notes,
      metadata: usage.metadata,
      createdAt: usage.createdAt
    };
  });

  // UPDATE (author-only; scoped to same hotel)
  app.patch(
    "/prompts/:id",
    { preHandler: [app.authenticate as any, ensureAuthor] },
    async (req: any, reply) => {
      const { user } = await assertHotelAndProvider(req, reply);
      if (reply.sent) return;

      const { id } = req.params as { id: string };
      const body = z
        .object({
          title: z.string().min(1).optional(),
          body: z.string().min(1).optional(),
          tags: z.array(z.string()).optional(),
          version: z.string().optional(),
          archived: z.boolean().optional(),
          categoryId: z.string().nullable().optional(),
          assignedUserId: z.union([z.string(), z.array(z.string())]).nullable().optional(),
          assignedUserIds: z.array(z.string()).nullable().optional(),
          departmentId: z.string().nullable().optional()
        })
        .parse(req.body ?? {});

      // ensure the prompt belongs to the same hotel
      const existing = await prismaAny.prompt.findFirst({
        where: { id, hotelId: user.hotelId }
      });
      if (!existing) return reply.code(404).send({ error: "Not found" });

      // (optional) If you want to restrict to the creator only, uncomment:
      if (existing.authorId !== user.id) return reply.code(403).send({ error: "Only the creator can update this prompt" });

      const data: Record<string, any> = {};

      if (body.title !== undefined) data.title = body.title;
      if (body.body !== undefined) data.body = body.body;
      if (body.tags !== undefined) data.tags = body.tags;
      if (body.version !== undefined) data.version = body.version;
      if (body.archived !== undefined) data.archived = body.archived;

      if (body.categoryId !== undefined) {
        if (body.categoryId === null) {
          data.categoryId = null;
        } else {
          const category = await prisma.promptCategory.findFirst({
            where: { id: body.categoryId, hotelId: user.hotelId },
            select: { id: true }
          });
          if (!category) {
            return reply.code(400).send({ error: "Invalid categoryId for this hotel" });
          }
          data.categoryId = category.id;
        }
      }

      const assignedUsersInput =
        body.assignedUserIds !== undefined
          ? body.assignedUserIds
          : body.assignedUserId !== undefined
            ? body.assignedUserId === null
              ? null
              : Array.isArray(body.assignedUserId)
                ? body.assignedUserId
                : [body.assignedUserId]
            : undefined;

      let assignedUsersUpdate: { set: Array<{ id: string }> } | undefined;
      if (assignedUsersInput !== undefined) {
        if (assignedUsersInput === null) {
          assignedUsersUpdate = { set: [] };
        } else {
          const uniqueIds = Array.from(new Set(assignedUsersInput));
          if (!uniqueIds.length) {
            assignedUsersUpdate = { set: [] };
          } else {
            const found = await prisma.user.findMany({
              where: { id: { in: uniqueIds }, hotelId: user.hotelId },
              select: { id: true }
            });
            if (found.length !== uniqueIds.length) {
              return reply.code(400).send({ error: "Invalid assigned user IDs for this hotel" });
            }
            assignedUsersUpdate = {
              set: found.map((f) => ({ id: f.id }))
            };
          }
        }
      }

      if (body.departmentId !== undefined) {
        if (body.departmentId === null) {
          data.departmentId = null;
        } else {
          const dept = await prismaAny.department.findFirst({
            where: { id: body.departmentId, hotelId: user.hotelId },
            select: { id: true }
          });
          if (!dept) {
            return reply.code(400).send({ error: "Invalid departmentId for this hotel" });
          }
          data.departmentId = dept.id;
        }
      }

      const hasAssignedUsersUpdate = assignedUsersUpdate !== undefined;

      if (!Object.keys(data).length && !hasAssignedUsersUpdate) {
        return reply.code(400).send({ error: "No fields to update" });
      }

      const updated = await prismaAny.prompt.update({
        where: { id },
        data: {
          ...data,
          ...(hasAssignedUsersUpdate ? { assignedUsers: assignedUsersUpdate } : {})
        },
        include: {
          author: { select: { id: true, email: true } },
          category: { select: { id: true, name: true } },
          assignedUsers: { select: { id: true, email: true } },
          department: { select: { id: true, name: true } }
        }
      });
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

      const existing = await prismaAny.prompt.findFirst({
        where: { id, hotelId: user.hotelId }
      });
      if (!existing) return reply.code(404).send({ error: "Not found" });

      // (optional) restrict to creator only:
      if (existing.authorId !== user.id) return reply.code(403).send({ error: "Only the creator can delete this prompt" });

      await prismaAny.prompt.delete({ where: { id } });
      return { ok: true };
    }
  );

  const savePromptFeedback = async (req: any, reply: any) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };
    const body = PromptFeedbackBody.parse(req.body ?? {});

    const prompt = await prismaAny.prompt.findFirst({
      where: { id, hotelId: user.hotelId, archived: false },
      select: { id: true }
    });
    if (!prompt) return reply.code(404).send({ error: "Prompt not found" });

    const feedbackScore = Math.round(body.feedbackScore);
    const reaction = body.reaction === "none" ? null : body.reaction ?? null;

    const saved = await (prisma as any).promptFeedback.upsert({
      where: { promptId_userId: { promptId: id, userId: user.id } },
      update: { feedbackScore, reaction },
      create: { promptId: id, userId: user.id, feedbackScore, reaction }
    });

    const aggregates = await prisma.promptFeedback.aggregate({
      where: { promptId: id },
      _avg: { feedbackScore: true },
      _count: { id: true }
    });

    const qualityScore = aggregates._avg.feedbackScore ?? null;
    const feedbackCount = aggregates._count.id;

    await prisma.prompt.update({
      where: { id },
      data: {
        qualityScore,
        feedbackCount,
        lastFeedbackAt: new Date()
      }
    });

    if (qualityScore !== null && qualityScore >= 60) {
      const promptRecord = await prisma.prompt.findUnique({
        where: { id },
        select: { id: true, title: true, body: true, hotelId: true }
      });
      if (promptRecord) {
        await prisma.trainingExample.upsert({
          where: { promptId: promptRecord.id },
          update: {
            inputText: promptRecord.title ?? "",
            outputText: promptRecord.body,
            score: qualityScore,
            metadata: { promptId: promptRecord.id, title: promptRecord.title },
            vectorStatus: TrainingVectorStatus.pending
          },
          create: {
            hotelId: promptRecord.hotelId,
            source: TrainingExampleSource.prompt,
            promptId: promptRecord.id,
            inputText: promptRecord.title ?? "",
            outputText: promptRecord.body,
            score: qualityScore,
            metadata: { promptId: promptRecord.id, title: promptRecord.title }
          }
        });
      }
    } else {
      await prisma.trainingExample.deleteMany({ where: { promptId: id } });
    }

    return {
      ok: true,
      promptId: saved.promptId,
      feedbackScore: saved.feedbackScore,
      reaction: saved.reaction ?? null
    };
  };

  // Reader feedback (create/update)
  app.post("/prompts/:id/feedback", { preHandler: app.authenticate }, savePromptFeedback);
  app.put("/prompts/:id/feedback", { preHandler: app.authenticate }, savePromptFeedback);

  app.get("/prompts/:id/feedback/me", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { id } = req.params as { id: string };

    const prompt = await prismaAny.prompt.findFirst({
      where: { id, hotelId: user.hotelId },
      select: { id: true }
    });
    if (!prompt) return reply.code(404).send({ error: "Prompt not found" });

    const feedback = await (prisma as any).promptFeedback.findFirst({
      where: { promptId: id, userId: user.id }
    });

    return feedback
      ? {
          promptId: feedback.promptId,
          feedbackScore: feedback.feedbackScore,
          reaction: feedback.reaction ?? null,
          updatedAt: feedback.updatedAt
        }
      : { promptId: id, feedbackScore: null, reaction: null, updatedAt: null };
  });

  async function listAuthorFeedbacks(req: any, reply: any, promptId?: string) {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;

    const hasPromptId = Boolean(promptId?.trim());
    const normalizedId = hasPromptId ? promptId!.trim() : "";

    let prompt: { id: string; title: string } | null = null;
    if (hasPromptId) {
      prompt = await prismaAny.prompt.findFirst({
        where: { id: normalizedId, hotelId: user.hotelId, authorId: user.id },
        select: { id: true, title: true }
      });
      if (!prompt) {
        reply.code(404).send({ error: "Prompt not found" });
        return;
      }
    }

    const feedbacks = await (prisma as any).promptFeedback.findMany({
      where: hasPromptId
        ? { promptId: normalizedId, prompt: { authorId: user.id } }
        : { prompt: { hotelId: user.hotelId, authorId: user.id } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        feedbackScore: true,
        reaction: true,
        createdAt: true,
        prompt: { select: { id: true, title: true } },
        user: { select: { id: true, email: true, role: true } }
      }
    });

    return {
      prompt,
      feedbacks: feedbacks.map((fb: any) =>
        hasPromptId
          ? {
              id: fb.id,
              feedbackScore: fb.feedbackScore,
              reaction: fb.reaction ?? null,
              createdAt: fb.createdAt,
              user: fb.user
            }
          : {
              id: fb.id,
              feedbackScore: fb.feedbackScore,
              reaction: fb.reaction ?? null,
              createdAt: fb.createdAt,
              user: fb.user,
              prompt: fb.prompt
            }
      )
    };
  }

  app.get("/prompts/:id/feedbacks", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { id } = req.params as { id: string };
    return listAuthorFeedbacks(req, reply, id);
  });

  app.get("/prompts/feedbacks", { preHandler: app.authenticate }, async (req: any, reply) => {
    return listAuthorFeedbacks(req, reply);
  });

  app.get("/prompts/most-used", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const query = MostUsedPromptsQuery.parse(req.query ?? {});

    const grouped = await prisma.promptUsage.groupBy({
      by: ["promptId"],
      where: { hotelId: user.hotelId },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: query.limit
    });

    if (!grouped.length) {
      return { prompts: [] };
    }

    const promptIds = grouped.map((entry) => entry.promptId);
    const prompts = await prismaAny.prompt.findMany({
      where: { id: { in: promptIds } },
      include: {
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } }
      }
    });
    const promptMap = new Map(prompts.map((prompt: any) => [prompt.id, prompt]));
    const feedbackStats = await fetchPromptFeedbackStats(promptIds);

    const results = grouped
      .map((entry) => {
        const prompt = promptMap.get(entry.promptId);
        if (!prompt) return null;
        const stats = feedbackStats.get(entry.promptId);
        return {
          id: prompt.id,
          title: prompt.title,
          usageCount: entry._sum?.count ?? 0,
          feedbackCount: stats?.feedbackCount ?? 0,
          usageTag: resolveUsageTag(stats),
          author: prompt.author,
          category: prompt.category,
          department: prompt.department,
          assignedUsers: prompt.assignedUsers,
          updatedAt: prompt.updatedAt,
          createdAt: prompt.createdAt,
          tags: prompt.tags
        };
      })
      .filter(Boolean);

    return { prompts: results };
  });

  // Usage summary (mostly used / saved / rarely used)
  app.get("/prompts/usage-summary", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;

    const prompts = await prismaAny.prompt.findMany({
      where: { hotelId: user.hotelId, archived: false },
      select: { id: true, title: true }
    });
    if (!prompts.length) {
      return { mostlyUsed: [], saved: [], rarelyUsed: [] };
    }

    const statsMap = await fetchPromptFeedbackStats(prompts.map((p) => p.id));

    type Summary = {
      promptId: string;
      title: string;
      feedbackCount: number;
      likeCount: number;
      dislikeCount: number;
      averageScore: number;
    };

    const buckets = {
      mostly: [] as Summary[],
      saved: [] as Summary[],
      rarely: [] as Summary[]
    };

    for (const prompt of prompts) {
      const stats = statsMap.get(prompt.id) ?? {
        feedbackCount: 0,
        likeCount: 0,
        dislikeCount: 0,
        averageScore: 0
      };
      const summary: Summary = {
        promptId: prompt.id,
        title: prompt.title,
        feedbackCount: stats.feedbackCount,
        likeCount: stats.likeCount,
        dislikeCount: stats.dislikeCount,
        averageScore: stats.averageScore
      };
      const usageTag = resolveUsageTag(stats);
      if (usageTag === "mostly used") buckets.mostly.push(summary);
      else if (usageTag === "saved") buckets.saved.push(summary);
      else buckets.rarely.push(summary);
    }

    return {
      mostlyUsed: buckets.mostly,
      saved: buckets.saved,
      rarelyUsed: buckets.rarely
    };
  });

  // Author prompt stats
  app.get("/prompts/authors/stats", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;

    const prompts = await prismaAny.prompt.findMany({
      where: { hotelId: user.hotelId, archived: false },
      select: { id: true, authorId: true, title: true }
    });
    if (!prompts.length) {
      return {
        totalPrompts: 0,
        uniqueAuthors: 0,
        averageFeedbackScore: 0,
        totalFeedbackCount: 0,
        topRatedPrompt: null
      };
    }

    const promptIds = prompts.map((p) => p.id);
    const feedbacks = await (prisma as any).promptFeedback.findMany({
      where: { promptId: { in: promptIds } },
      select: { promptId: true, feedbackScore: true }
    });

    const uniqueAuthors = new Set(prompts.map((p) => p.authorId));
    let totalFeedback = 0;
    let totalScore = 0;
    let topPromptId: string | null = null;
    let topPromptScore = -Infinity;

    const promptScoreMap = new Map<string, { total: number; count: number }>();
    for (const fb of feedbacks) {
      totalFeedback += 1;
      totalScore += fb.feedbackScore;
      if (!promptScoreMap.has(fb.promptId)) promptScoreMap.set(fb.promptId, { total: 0, count: 0 });
      const aggregate = promptScoreMap.get(fb.promptId)!;
      aggregate.total += fb.feedbackScore;
      aggregate.count += 1;
    }

    for (const [promptId, aggregate] of promptScoreMap.entries()) {
      const average = aggregate.count ? aggregate.total / aggregate.count : 0;
      if (average > topPromptScore) {
        topPromptScore = average;
        topPromptId = promptId;
      }
    }

    const topPrompt = topPromptId
      ? prompts.find((p) => p.id === topPromptId)
      : null;

    return {
      totalPrompts: prompts.length,
      uniqueAuthors: uniqueAuthors.size,
      totalFeedbackCount: totalFeedback,
      averageFeedbackScore: totalFeedback ? Number((totalScore / totalFeedback).toFixed(2)) : 0,
      topRatedPrompt: topPrompt
        ? {
            id: topPrompt.id,
            title: topPrompt.title,
            averageScore: Number(topPromptScore.toFixed(2))
          }
        : null
    };
  });

  // Export prompts with feedback
  app.get("/prompts/export", { preHandler: app.authenticate }, async (req: any, reply) => {
    const { user } = await assertHotelAndProvider(req, reply);
    if (reply.sent) return;
    const { format } = PromptExportQuery.parse(req.query ?? {});

    const prompts = await prismaAny.prompt.findMany({
      where: { hotelId: user.hotelId },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        body: true,
        tags: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        author: { select: { id: true, email: true } },
        category: { select: { id: true, name: true } },
        assignedUsers: { select: { id: true, email: true } },
        department: { select: { id: true, name: true } }
      }
    });

    if (!prompts.length) {
      return reply.code(404).send({ error: "No prompts found" });
    }

    const feedbackRows = await (prisma as any).promptFeedback.findMany({
      where: { promptId: { in: prompts.map((p) => p.id) } },
      select: {
        promptId: true,
        feedbackScore: true,
        reaction: true,
        createdAt: true,
        user: { select: { id: true, email: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    const feedbackMap = new Map<string, Array<any>>();
    for (const fb of feedbackRows) {
      if (!feedbackMap.has(fb.promptId)) feedbackMap.set(fb.promptId, []);
      feedbackMap.get(fb.promptId)!.push({
        userId: fb.user.id,
        userEmail: fb.user.email,
        feedbackScore: fb.feedbackScore,
        reaction: fb.reaction ?? null,
        createdAt: fb.createdAt
      });
    }

    const records = prompts.map((prompt) => {
      const promptFeedback = feedbackMap.get(prompt.id) ?? [];
      const totalScore = promptFeedback.reduce((sum, f) => sum + f.feedbackScore, 0);
      const averageScore = promptFeedback.length ? Number((totalScore / promptFeedback.length).toFixed(2)) : 0;
      return {
        id: prompt.id,
        title: prompt.title,
        body: prompt.body,
        tags: prompt.tags,
        version: prompt.version,
        author: prompt.author,
        category: prompt.category,
        assignedUsers: prompt.assignedUsers,
        department: prompt.department,
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
        feedback: {
          count: promptFeedback.length,
          averageScore,
          entries: promptFeedback
        }
      };
    });

    const filenameBase = `prompts-${new Date().toISOString().slice(0, 10)}`;
    if (format === "json") {
      reply
        .header("Content-Type", "application/json")
        .header("Content-Disposition", `attachment; filename="${filenameBase}.json"`);
      return records;
    }

    if (format === "jsonl") {
      const jsonl = records.map((item) => JSON.stringify(item)).join("\n");
      reply
        .header("Content-Type", "application/jsonl")
        .header("Content-Disposition", `attachment; filename="${filenameBase}.jsonl"`);
      return jsonl;
    }

    const wordDoc = buildWordDocument(records);
    reply
      .header("Content-Type", "application/msword")
      .header("Content-Disposition", `attachment; filename="${filenameBase}.doc"`);
    return wordDoc;
  });

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

function buildWordDocument(records: Array<any>) {
  const esc = (value: any) =>
    String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  let html =
    '<html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;} h2{margin-top:24px;} table{border-collapse:collapse;width:100%;} td,th{border:1px solid #ddd;padding:6px;font-size:12px;}</style></head><body>';
  for (const prompt of records) {
    html += `<h2>${esc(prompt.title)}</h2>`;
    html += `<p><strong>ID:</strong> ${esc(prompt.id)}</p>`;
    html += `<p><strong>Author:</strong> ${esc(prompt.author?.email ?? "Unknown")}</p>`;
    html += `<p><strong>Category:</strong> ${esc(prompt.category?.name ?? "None")}</p>`;
    html += `<p><strong>Tags:</strong> ${esc(Array.isArray(prompt.tags) ? prompt.tags.join(", ") : "")}</p>`;
    html += `<p><strong>Version:</strong> ${esc(prompt.version ?? "")}</p>`;
    html += `<p><strong>Body:</strong><br>${esc(prompt.body)}</p>`;
    html += `<p><strong>Feedback Count:</strong> ${prompt.feedback.count} | <strong>Average Score:</strong> ${prompt.feedback.averageScore}</p>`;
    if (prompt.feedback.entries.length) {
      html += "<table><thead><tr><th>User</th><th>Score</th><th>Reaction</th><th>Date</th></tr></thead><tbody>";
      for (const entry of prompt.feedback.entries) {
        html += `<tr><td>${esc(entry.userEmail)}</td><td>${entry.feedbackScore}</td><td>${esc(entry.reaction ?? "-")}</td><td>${esc(
          new Date(entry.createdAt).toISOString()
        )}</td></tr>`;
      }
      html += "</tbody></table>";
    } else {
      html += "<p>No feedback yet.</p>";
    }
  }
  html += "</body></html>";
  return html;
}
