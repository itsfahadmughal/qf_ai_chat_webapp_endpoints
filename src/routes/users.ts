import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const ListUsersQuery = z.object({
  hotelId: z.string().optional(),
  activeOnly: z.coerce.boolean().optional()
});

export async function userRoutes(app: FastifyInstance) {
  app.get("/users", { preHandler: app.authenticate }, async (req: any) => {
    const query = ListUsersQuery.parse(req.query ?? {});

    const where = {
      ...(query.hotelId ? { hotelId: query.hotelId } : {}),
      ...(query.activeOnly ? { isActive: true } : {})
    };

    const users = await prisma.user.findMany({
      where: Object.keys(where).length ? where : undefined,
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        hotelId: true,
        createdAt: true,
        hotel: { select: { name: true } }
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
      }
    }));
  });
}
