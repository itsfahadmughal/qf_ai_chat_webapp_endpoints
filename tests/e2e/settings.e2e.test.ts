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
  createUser,
  setProviderToggle
} from "./mockPrisma.js";

vi.mock("../../src/db.js", () => ({
  prisma: prismaMock
}));

let app: FastifyInstance;
let token: string;
let hotelId: string;
let userId: string;

async function buildServer() {
  const server = Fastify();
  await server.register(cors, { origin: true });
  await server.register(multipart);
  await registerJWT(server);
  const { settingsRoutes } = await import("../../src/routes/settings.js");
  await settingsRoutes(server);
  await server.ready();
  return server;
}

describe("settings/providers e2e", () => {
  beforeEach(async () => {
    resetTestState();
    const hotel = createHotel({ name: "Prefs Hotel" });
    const user = createUser({ email: "pref@example.com", hotelId: hotel.id });
    hotelId = hotel.id;
    userId = user.id;
    setProviderToggle(hotel.id, "deepseek", { isEnabled: true });
    setProviderToggle(hotel.id, "claude", { isEnabled: false });
    app = await buildServer();
    token = app.jwt.sign({ id: user.id, email: user.email });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("lists hotel-allowed providers and user preferences", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/settings/preferences",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hotelAllowed).toEqual([
      { provider: "openai", defaultModel: null },
      { provider: "deepseek", defaultModel: null }
    ]);
    expect(body.userPrefs.enabledProviders).toEqual([]);
  });

  it("updates enabled providers respecting hotel toggle", async () => {
    const update = await app.inject({
      method: "PUT",
      url: "/settings/preferences",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enabledProviders: ["openai", "deepseek"],
        defaultProvider: "deepseek",
        models: { deepseek: "deepseek-chat" },
        locale: "de"
      }
    });
    expect(update.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/settings/preferences",
      headers: { authorization: `Bearer ${token}` }
    });
    const body = res.json();
    expect(body.userPrefs.enabledProviders).toEqual(["openai", "deepseek"]);
    expect(body.userPrefs.defaultProvider).toBe("deepseek");
    expect(body.userPrefs.locale).toBe("de");
    expect(body.userPrefs.models.deepseek).toBe("deepseek-chat");
  });

  it("rejects enabling providers disabled by hotel", async () => {
    const update = await app.inject({
      method: "PUT",
      url: "/settings/preferences",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        enabledProviders: ["claude"]
      }
    });
    expect(update.statusCode).toBe(400);
    expect(update.json().error).toContain("disabled for this hotel");
  });
});
