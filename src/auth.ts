import jwt from "@fastify/jwt";
import type { FastifyInstance } from "fastify";
import { env } from "./env.js";

export async function registerJWT(app: FastifyInstance) {
  await app.register(jwt, { secret: env.JWT_SECRET });
  app.decorate("authenticate", async function (req: any, reply: any) {
    try {
      await req.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
}

// Type augmentation (helps TS when using app.authenticate)
declare module "fastify" {
  interface FastifyInstance { authenticate: any }
  interface FastifyRequest {
    user: { id: string; email: string }
  }
}
