import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    user: { id: string; role: "author" | "reader" };
  }
}
