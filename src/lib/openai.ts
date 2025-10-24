import OpenAI from "openai";
import { env } from "../env.js";
import { prisma } from "../db.js";
import { decryptSecret } from "../crypto/secrets.js";

// Shared OpenAI client configured via environment variables (fallback/global operations).
export const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL
});

export type OpenAIConfig = {
  apiKey: string | null;
  baseURL?: string;
};

export async function resolveHotelOpenAIConfig(hotelId: string): Promise<OpenAIConfig> {
  const cred = await prisma.hotelProviderCredential.findUnique({
    where: { hotelId_provider: { hotelId, provider: "openai" } }
  });

  if (cred && cred.isActive) {
    const apiKey = decryptSecret(
      cred.encKey as unknown as Buffer,
      cred.iv as unknown as Buffer,
      cred.tag as unknown as Buffer
    );
    return {
      apiKey,
      baseURL: cred.baseUrl || env.OPENAI_BASE_URL
    };
  }

  return {
    apiKey: env.OPENAI_API_KEY || null,
    baseURL: env.OPENAI_BASE_URL
  };
}

export async function getHotelOpenAIClient(hotelId: string): Promise<OpenAI> {
  const cfg = await resolveHotelOpenAIConfig(hotelId);
  if (!cfg.apiKey) {
    throw new Error("OpenAI API key not configured for this hotel.");
  }
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL
  });
}

type VectorStoresApi = {
  create: (body: any, options?: any) => Promise<any>;
  retrieve: (id: string, options?: any) => Promise<any>;
  update?: (id: string, body: any, options?: any) => Promise<any>;
  del?: (id: string, options?: any) => Promise<any>;
  delete?: (id: string, options?: any) => Promise<any>;
  list?: (params?: any, options?: any) => Promise<any>;
  files?: any;
  fileBatches?: any;
  search?: (id: string, body: any, options?: any) => Promise<any>;
  query?: (id: string, body: any, options?: any) => Promise<any>;
};

function normalizeVectorStores(client: OpenAI): VectorStoresApi {
  const vs =
    ((client as any).vectorStores as VectorStoresApi | undefined) ??
    ((client as any).beta?.vectorStores as VectorStoresApi | undefined);
  if (!vs?.create) {
    throw new Error("OpenAI vector store API not available in the installed SDK version.");
  }
  return vs;
}

async function pageToArray(page: any): Promise<any[]> {
  if (!page) return [];
  if (Array.isArray(page)) return page;
  if (Array.isArray(page.data)) return page.data;
  const out: any[] = [];
  const maybeAsync = (page as any)[Symbol.asyncIterator];
  if (typeof maybeAsync === "function") {
    for await (const item of page as any) out.push(item);
    return out;
  }
  const iter = (page as any)[Symbol.iterator];
  if (typeof iter === "function") {
    for (const item of page as any) out.push(item);
    return out;
  }
  return out;
}

export async function searchVectorStore(
  client: OpenAI,
  opts: { vectorStoreId: string; query: string; maxResults?: number }
): Promise<any[]> {
  const vs = normalizeVectorStores(client);
  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 50);
  if (typeof vs.search === "function") {
    const page = await vs.search(opts.vectorStoreId, {
      query: opts.query,
      max_num_results: maxResults
    });
    return await pageToArray(page);
  }
  if (typeof vs.query === "function") {
    const res = await vs.query(opts.vectorStoreId, {
      query: opts.query,
      top_k: maxResults
    });
    if (Array.isArray(res?.data)) return res.data;
    return [];
  }
  throw new Error("OpenAI vector store search not supported by current SDK.");
}

export function getVectorStoresApi(client: OpenAI): VectorStoresApi {
  return normalizeVectorStores(client);
}
