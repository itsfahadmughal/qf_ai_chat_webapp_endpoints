import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { z } from "zod";

const prismaAny = prisma as any;

const ListDepartmentQuery = z.object({
  hotelId: z.string().min(1, "hotelId is required")
});

const CreateDepartmentBody = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  name: z.string().min(1),
  description: z.string().optional()
});

const UpdateDepartmentBody = z.object({
  hotelId: z.string().min(1, "hotelId is required"),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isActive: z.boolean().optional()
});

export async function departmentRoutes(app: FastifyInstance) {
  app.get("/departments", async (req: any, reply) => {
    const query = ListDepartmentQuery.parse(req.query ?? {});

    const hotel = await prismaAny.hotel.findUnique({
      where: { id: query.hotelId },
      select: { id: true, isActive: true }
    });
    if (!hotel) {
      return reply.code(404).send({ error: "hotel_not_found" });
    }

    return prismaAny.department.findMany({
      where: { hotelId: query.hotelId },
      orderBy: { name: "asc" }
    });
  });

  app.post("/departments", async (req: any, reply) => {
    const body = CreateDepartmentBody.parse(req.body ?? {});

    const hotel = await prismaAny.hotel.findUnique({
      where: { id: body.hotelId },
      select: { id: true, isActive: true }
    });
    if (!hotel) {
      return reply.code(404).send({ error: "hotel_not_found" });
    }
    if (!hotel.isActive) {
      return reply.code(403).send({ error: "hotel_inactive" });
    }

    const department = await prismaAny.department.create({
      data: {
        hotelId: body.hotelId,
        name: body.name,
        description: body.description ?? null
      }
    });

    return department;
  });

  app.patch("/departments/:id", async (req: any, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateDepartmentBody.parse(req.body ?? {});

    const existing = await prismaAny.department.findFirst({
      where: { id, hotelId: body.hotelId }
    });
    if (!existing) {
      return reply.code(404).send({ error: "department_not_found" });
    }

    const updated = await prismaAny.department.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });

    return updated;
  });
}
