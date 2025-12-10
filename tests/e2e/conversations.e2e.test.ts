import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { registerJWT } from "../../src/auth.js";
import {
  prismaMock,
  resetTestState,
  createHotel,
  createUser,
  createConversationRecord,
  createMessageRecord
} from "./mockPrisma.js";

vi.mock("../../src/db.js", () => ({
  prisma: prismaMock
}));
vi.mock("../../src/lib/fineTuning.js", () => ({
  scheduleFineTuneUpload: vi.fn().mockResolvedValue(null)
}));

let app: FastifyInstance;
let userToken: string;
let userId: string;
let hotelId: string;

async function buildServer() {
  const server = Fastify();
  await server.register(cors, { origin: true });
  await server.register(multipart);
  await registerJWT(server);
  const { conversationRoutes } = await import("../../src/routes/conversations.js");
  await conversationRoutes(server);
  await server.ready();
  return server;
}

describe("conversations e2e", () => {
  beforeEach(async () => {
    resetTestState();
    const hotel = createHotel({ name: "Test Hotel" });
    const user = createUser({ email: "tester@example.com", hotelId: hotel.id });
    hotelId = hotel.id;
    userId = user.id;
    app = await buildServer();
    userToken = app.jwt.sign({ id: user.id, email: user.email });
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("creates and lists conversations for the authenticated user", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: {
        authorization: `Bearer ${userToken}`
      },
      payload: {
        title: "My first chat"
      }
    });

    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json();
    expect(created.title).toBe("My first chat");
    expect(created.userId).toBe(userId);

    const listResponse = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: {
        authorization: `Bearer ${userToken}`
      }
    });

    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("updates a conversation title", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: "Original title" }
    });
    const conversation = createRes.json();

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/conversations/${conversation.id}/title`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: "Renamed conversation" }
    });

    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json();
    expect(patched.conversation.title).toBe("Renamed conversation");

    const listRes = await app.inject({
      method: "GET",
      url: "/conversations",
      headers: { authorization: `Bearer ${userToken}` }
    });
    const list = listRes.json();
    expect(list[0].title).toBe("Renamed conversation");
  });

  it("rejects title update when user does not own conversation", async () => {
    const otherUser = createUser({ email: "other@example.com", hotelId });
    const foreignConversation = createConversationRecord({
      title: "Foreign",
      hotelId,
      userId: otherUser.id
    });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/conversations/${foreignConversation.id}/title`,
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: "Should fail" }
    });

    expect(patchRes.statusCode).toBe(404);
  });

  it("returns ordered messages for a conversation", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/conversations",
      headers: { authorization: `Bearer ${userToken}` },
      payload: { title: "Thread" }
    });
    const conversation = createRes.json();
    createMessageRecord({
      conversationId: conversation.id,
      role: "user",
      content: "Hello!"
    });
    createMessageRecord({
      conversationId: conversation.id,
      role: "assistant",
      content: "Hey there",
      provider: "openai",
      model: "gpt-4o-mini"
    });

    const res = await app.inject({
      method: "GET",
      url: `/conversations/${conversation.id}/messages`,
      headers: { authorization: `Bearer ${userToken}` }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversation.id).toBe(conversation.id);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].content).toBe("Hello!");
    expect(body.messages[1].role).toBe("assistant");
  });

});
