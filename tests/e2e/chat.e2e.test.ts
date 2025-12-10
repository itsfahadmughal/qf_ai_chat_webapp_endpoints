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
  createMessageRecord,
  createVectorStore,
  testState
} from "./mockPrisma.js";

const mockChat = vi.fn(async () => ({
  content: "Mock assistant reply",
  usage: { total_tokens: 42 }
}));
const mockSearchVectorStore = vi.fn(async () => [
  {
    content: [{ text: { value: "Important hotel policy" } }],
    score: 0.92
  }
]);
const mockGetHotelOpenAIClient = vi.fn(async () => ({}));

vi.mock("../../src/db.js", () => ({
  prisma: prismaMock
}));
vi.mock("../../src/lib/fineTuning.js", () => ({
  scheduleFineTuneUpload: vi.fn().mockResolvedValue(null)
}));
vi.mock("../../src/lib/training/examples.js", () => ({
  upsertConversationSummaryExample: vi.fn().mockResolvedValue(null)
}));
vi.mock("../../src/lib/training/vectorStore.js", () => ({
  syncTrainingExamplesToVectorStore: vi.fn().mockResolvedValue(null)
}));
vi.mock("../../src/lib/openai.js", () => ({
  getHotelOpenAIClient: mockGetHotelOpenAIClient,
  searchVectorStore: mockSearchVectorStore
}));
vi.mock("../../src/providers/index.js", () => ({
  Providers: {
    openai: { chat: mockChat },
    deepseek: { chat: mockChat },
    perplexity: { chat: mockChat },
    claude: { chat: mockChat }
  }
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
  const { chatRoutes } = await import("../../src/routes/chat.js");
  await chatRoutes(server);
  await server.ready();
  return server;
}

describe("chat e2e", () => {
  beforeEach(async () => {
    resetTestState();
    const hotel = createHotel({ name: "Demo Hotel" });
    const user = createUser({ email: "agent@example.com", hotelId: hotel.id });
    hotelId = hotel.id;
    userId = user.id;
    app = await buildServer();
    userToken = app.jwt.sign({ id: user.id, email: user.email });
    mockChat.mockClear();
    mockSearchVectorStore.mockClear();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("creates a new conversation and stores messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        messages: [{ role: "user", content: "Hello assistant" }],
        knowledge: { enabled: false }
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toBeDefined();
    expect(body.content).toBe("Mock assistant reply");
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(testState.conversations).toHaveLength(1);
    const storedMessages = testState.messages.filter((m) => m.conversationId === body.conversationId);
    expect(storedMessages.some((m) => m.role === "assistant" && m.content === "Mock assistant reply")).toBe(true);
  });

  it("continues an existing conversation", async () => {
    const conversation = createConversationRecord({
      hotelId,
      userId,
      title: "Existing",
      provider: "openai",
      model: "gpt-4o-mini"
    });
    createMessageRecord({
      conversationId: conversation.id,
      role: "user",
      content: "Earlier question"
    });

    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        conversationId: conversation.id,
        messages: [{ role: "user", content: "Continue thread" }],
        knowledge: { enabled: false }
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.conversationId).toBe(conversation.id);
    expect(mockChat).toHaveBeenCalledTimes(1);
    const storedMessages = testState.messages.filter((m) => m.conversationId === conversation.id);
    // prior user message + new user message + assistant reply + summary memory message
    expect(storedMessages).toHaveLength(4);
  });

  it("deletes a conversation through chat routes", async () => {
    const chatRes = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        messages: [{ role: "user", content: "start" }],
        knowledge: { enabled: false }
      }
    });
    expect(chatRes.statusCode).toBe(200);
    const { conversationId } = chatRes.json();
    expect(testState.conversations.find((c) => c.id === conversationId)).toBeDefined();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/conversations/${conversationId}`,
      headers: { authorization: `Bearer ${userToken}` }
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(testState.conversations.find((c) => c.id === conversationId)).toBeUndefined();
    expect(testState.messages.some((m) => m.conversationId === conversationId)).toBe(false);
  });

  it("injects knowledge base context when enabled", async () => {
    const store = createVectorStore({ hotelId, openaiId: "vs_123" });
    const res = await app.inject({
      method: "POST",
      url: "/chat",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        messages: [{ role: "user", content: "Where is breakfast served?" }],
        knowledge: { enabled: true }
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.knowledge).toEqual({ vectorStoreId: store.id, chunkCount: 1 });
    expect(mockSearchVectorStore).toHaveBeenCalled();
  });
});
