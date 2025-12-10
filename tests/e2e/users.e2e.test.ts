import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  prismaMock,
  resetTestState,
  createHotel,
  createUser,
  createDepartment
} from "./mockPrisma.js";
import { userRoutes } from "../../src/routes/users.js";

vi.mock("../../src/db.js", () => ({
  prisma: prismaMock
}));

let app: FastifyInstance;
let hotelId: string;
let userId: string;
let deptId: string;

async function buildServer() {
  const server = Fastify();
  await server.register(cors, { origin: true });
  await server.register(multipart);
  await userRoutes(server);
  await server.ready();
  return server;
}

describe("users e2e", () => {
  beforeEach(async () => {
    resetTestState();
    const hotel = createHotel({ name: "User Hotel" });
    const dept = createDepartment({ hotelId: hotel.id, name: "Front Desk" });
    const user = createUser({ email: "staff@example.com", hotelId: hotel.id });
    hotelId = hotel.id;
    deptId = dept.id;
    userId = user.id;
    app = await buildServer();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("lists users for a hotel", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/users?hotelId=${hotelId}`
    });
    expect(res.statusCode).toBe(200);
    const users = res.json();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe("staff@example.com");
    expect(users[0].hotel.id).toBe(hotelId);
  });

  it("updates user role and department", async () => {
    const updateRes = await app.inject({
      method: "PUT",
      url: `/users/${userId}`,
      payload: {
        hotelId,
        role: "author",
        departmentId: deptId
      }
    });
    expect(updateRes.statusCode).toBe(200);
    const updated = updateRes.json();
    expect(updated.role).toBe("author");
    expect(updated.department?.id).toBe(deptId);
  });

  it("deletes a user", async () => {
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/users/${userId}`,
      payload: { hotelId }
    });
    expect(deleteRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: "GET",
      url: `/users?hotelId=${hotelId}`
    });
    expect(listRes.json()).toHaveLength(0);
  });
});
