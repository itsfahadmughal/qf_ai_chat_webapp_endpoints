import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerJWT } from "../../src/auth.js";
import {
  prismaMock,
  resetTestState,
  createHotel,
  createUser
} from "./mockPrisma.js";

vi.mock("../../src/db.js", () => ({
  prisma: prismaMock
}));

let app: FastifyInstance;
let token: string;
let hotelId: string;

async function buildServer() {
  const server = Fastify();
  await server.register(cors, { origin: true });
  await server.register(multipart);
  await registerJWT(server);
  const { promptRoutes } = await import("../../src/routes/prompts.js");
  await promptRoutes(server);
  await server.ready();
  return server;
}

describe("prompts e2e", () => {
  beforeEach(async () => {
    resetTestState();
    const hotel = createHotel({ name: "Prompt Hotel" });
    const user = createUser({ email: "author@example.com", hotelId: hotel.id, role: "author" });
    hotelId = hotel.id;
    app = await buildServer();
    token = app.jwt.sign({ id: user.id, email: user.email, role: "author" });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("creates and lists prompt categories", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/prompt-categories",
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "FAQ" }
    });
    expect(createRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: "GET",
      url: "/prompt-categories",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(listRes.statusCode).toBe(200);
    const categories = listRes.json();
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe("FAQ");
  });

  it("creates a prompt and returns it in listings", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/prompts",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Welcome email",
        body: "Draft a warm welcome email for new guests"
      }
    });
    expect(createRes.statusCode).toBe(200);
    const prompt = createRes.json();
    expect(prompt.title).toBe("Welcome email");

    const listRes = await app.inject({
      method: "GET",
      url: "/prompts",
      headers: { authorization: `Bearer ${token}` }
    });
    const prompts = listRes.json();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].title).toBe("Welcome email");
  });
});
