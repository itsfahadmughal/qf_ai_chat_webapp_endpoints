import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const prismaAny = prisma as any;

const ListUsersQuery = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  departmentId: z.string().optional(),
  activeOnly: z.coerce.boolean().optional()
});

const UpdateUserParams = z.object({
  id: z.string().min(1)
});

const UpdateUserBody = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  email: z.string().email().optional(),
  role: z.enum(["author", "reader"]).optional(),
  isActive: z.boolean().optional(),
  departmentId: z.string().nullable().optional()
});

const DeleteUserBody = z.object({
  hotelId: z.string().min(1, "hotelId is required")
});

export async function userRoutes(app: FastifyInstance) {
  app.get("/users", async (req: any, reply) => {
    const query = ListUsersQuery.parse(req.query ?? {});

    const hotel = await prismaAny.hotel.findUnique({
      where: { id: query.hotelId },
      select: { id: true, isActive: true }
    });
    if (!hotel) {
      return reply.code(404).send({ error: "hotel_not_found" });
    }

    const where = {
      hotelId: query.hotelId,
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.activeOnly ? { isActive: true } : {})
    };

    const users = await prismaAny.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        hotelId: true,
        departmentId: true,
        createdAt: true,
        hotel: { select: { name: true } },
        department: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" }
    });

    return users.map((user) => ({
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      hotel: {
        id: user.hotelId,
        name: user.hotel?.name ?? null
      },
      department: user.department
        ? {
            id: user.department.id,
            name: user.department.name
          }
        : null
    }));
  });

  const updateUserHandler = async (req: any, reply: any) => {
    const { id } = UpdateUserParams.parse(req.params ?? {});
    const body = UpdateUserBody.parse(req.body ?? {});

    const hotel = await prismaAny.hotel.findUnique({
      where: { id: body.hotelId },
      select: { id: true, isActive: true }
    });
    if (!hotel) {
      return reply.code(404).send({ error: "hotel_not_found" });
    }

    const existing = await prismaAny.user.findFirst({
      where: { id, hotelId: body.hotelId },
      select: { id: true, hotelId: true }
    });
    if (!existing) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    let departmentIdToSet: string | null | undefined = body.departmentId;
    if (body.departmentId !== undefined) {
      if (body.departmentId === null) {
        departmentIdToSet = null;
      } else {
        const dept = await prismaAny.department.findFirst({
          where: { id: body.departmentId, hotelId: body.hotelId }
        });
        if (!dept) {
          return reply
            .code(400)
            .send({ error: "invalid_department", details: "Department does not belong to provided hotel" });
        }
        departmentIdToSet = body.departmentId;
      }
    }

    const updated = await prismaAny.user.update({
      where: { id },
      data: {
        ...(body.email ? { email: body.email } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(typeof body.isActive === "boolean" ? { isActive: body.isActive } : {}),
        ...(departmentIdToSet !== undefined ? { departmentId: departmentIdToSet } : {})
      },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        hotelId: true,
        departmentId: true,
        createdAt: true,
        hotel: { select: { name: true } },
        department: { select: { id: true, name: true } }
      }
    });

    return {
      id: updated.id,
      email: updated.email,
      role: updated.role,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      hotel: {
        id: updated.hotelId,
        name: updated.hotel?.name ?? null
      },
      department: updated.department
        ? {
            id: updated.department.id,
            name: updated.department.name
          }
        : null
    };
  };

  app.put("/users/:id", updateUserHandler);
  app.patch("/users/:id", updateUserHandler);

  app.delete("/users/:id", async (req: any, reply) => {
    const { id } = UpdateUserParams.parse(req.params ?? {});
    const body = DeleteUserBody.parse(req.body ?? {});

    const hotel = await prismaAny.hotel.findUnique({
      where: { id: body.hotelId },
      select: { id: true }
    });
    if (!hotel) {
      return reply.code(404).send({ error: "hotel_not_found" });
    }

    const existing = await prismaAny.user.findFirst({
      where: { id, hotelId: body.hotelId },
      select: { id: true }
    });
    if (!existing) {
      return reply.code(404).send({ error: "user_not_found" });
    }

    try {
      await prismaAny.user.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === "P2003") {
        return reply
          .code(409)
          .send({ error: "user_delete_conflict", details: "User still has related records and cannot be deleted." });
      }
      throw err;
    }

    return { ok: true };
  });
}
