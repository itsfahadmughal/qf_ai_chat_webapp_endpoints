// src/lib/byok.ts
import { prisma } from "../db.js";
import { decryptSecret } from "../crypto/secrets.js";

type Args = Record<string, unknown>;

export async function injectBrevoKeyIfNeeded(
  userId: string,
  serverId: string,
  incoming: Args
): Promise<Args> {
  const args: Args = { ...(incoming ?? {}) };

  // already provided -> nothing to do
  if (args.apiKey) return args;

  // find user + hotel
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { hotelId: true } });
  if (!me?.hotelId) throw new Error("User has no hotelId");

  // ensure server belongs to same hotel and is active (optional but recommended)
  const srv = await prisma.mCPServer.findFirst({ where: { id: serverId, hotelId: me.hotelId, isActive: true } });
  if (!srv) throw new Error("MCP server not found for this hotel or inactive");

  // detect brevo server (prefer srv.kind if you have it)
  const isBrevo = (srv.kind?.toLowerCase() ?? srv.name?.toLowerCase() ?? "").includes("brevo");
  if (!isBrevo) return args;

  // hotel BYOK credential
  const cred = await prisma.hotelProviderCredential.findUnique({
    where: { hotelId_provider: { hotelId: me.hotelId, provider: "brevo" as any } }
  });

  if (cred?.isActive) {
    const apiKey = decryptSecret(
      cred.encKey as unknown as Buffer,
      cred.iv as unknown as Buffer,
      cred.tag as unknown as Buffer
    );
    args.apiKey = apiKey;
    if (!args.baseUrl && cred.baseUrl) args.baseUrl = cred.baseUrl;
  }

  // env fallback
  if (!args.apiKey && process.env.BREVO_API_KEY) {
    args.apiKey = process.env.BREVO_API_KEY;
    if (!args.baseUrl) args.baseUrl = "https://api.brevo.com/v3";
  }

  return args;
}
