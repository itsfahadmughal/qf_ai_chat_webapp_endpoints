import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalWithPrisma = globalThis as typeof globalThis & {
  __PRISMA_OVERRIDE__?: PrismaClient;
};

if (!globalWithPrisma.__PRISMA_OVERRIDE__) {
  const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL (or DIRECT_URL) must be set to initialize PrismaClient.");
  }

  const pool = new Pool({
    connectionString
  });
  const adapter = new PrismaPg(pool);
  globalWithPrisma.__PRISMA_OVERRIDE__ = new PrismaClient({ adapter });
}

export const prisma = globalWithPrisma.__PRISMA_OVERRIDE__!;
