// src/mcp/servers/brevo.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as dotenv from "dotenv";
dotenv.config();

const server = new McpServer({ name: "brevo-mcp", version: "1.0.0" });

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";
const BASE = "https://api.brevo.com/v3";

/** Core HTTP wrapper */
async function brevoFetch<T>(
  path: string,
  method: HttpMethod,
  apiKey: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    method,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": apiKey
    },
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    let payload: any = text;
    try { payload = JSON.parse(text); } catch {}
    throw new Error(`HTTP ${res.status} ${res.statusText} ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

/** Helper: get API key from args or env */
function requireApiKey(apiKey?: string) {
  const k = apiKey || process.env.BREVO_API_KEY;
  if (!k) throw new Error("Missing Brevo API key. Set BREVO_API_KEY env or pass apiKey in arguments.");
  return k;
}

/** ---------------------- Tools ---------------------- */

/** Account info */
server.registerTool(
  "brevo.account",
  {
    title: "Get Brevo account info",
    description: "Returns your account, plan, and credits info.",
    inputSchema: { apiKey: z.string().optional() }
  },
  async ({ apiKey }) => {
    const key = requireApiKey(apiKey);
    const data = await brevoFetch<any>("/account", "GET", key);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** List templates */
server.registerTool(
  "brevo.listTemplates",
  {
    title: "List transactional email templates",
    description: "GET /v3/smtp/templates with filters.",
    inputSchema: {
      apiKey: z.string().optional(),
      templateStatus: z.boolean().default(false),
      limit: z.number().default(50),
      offset: z.number().default(0),
      sort: z.enum(["asc","desc"]).default("desc")
    }
  },
  async ({ apiKey, templateStatus, limit, offset, sort }) => {
    const key = requireApiKey(apiKey);
    const data = await brevoFetch<any>("/smtp/templates", "GET", key, undefined, {
      templateStatus, limit, offset, sort
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** Render preview of a transactional template */
server.registerTool(
  "brevo.previewTemplate",
  {
    title: "Preview transactional template render",
    description: "POST /v3/smtp/template/preview — returns rendered HTML with params.",
    inputSchema: {
      apiKey: z.string().optional(),
      templateId: z.number().int(),
      params: z.record(z.string(), z.unknown()).optional()
    }
  },
  async ({ apiKey, templateId, params }) => {
    const key = requireApiKey(apiKey);
    const data = await brevoFetch<any>("/smtp/template/preview", "POST", key, { templateId, params });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** Send email (template or raw) */
const EmailRecipient = z.object({ email: z.string().email(), name: z.string().optional() });
const Attachment = z.object({
  name: z.string().optional(),           // required if content is used
  url: z.string().url().optional(),      // absolute URL
  content: z.string().optional(),        // base64
  type: z.string().optional()            // mime (optional)
});

server.registerTool(
  "brevo.sendEmail",
  {
    title: "Send transactional email",
    description: "POST /v3/smtp/email. Use templateId+params OR subject+htmlContent.",
    inputSchema: {
      apiKey: z.string().optional(),
      sender: z.object({ email: z.string().email(), name: z.string().optional() }),
      to: z.array(EmailRecipient).min(1),
      cc: z.array(EmailRecipient).optional(),
      bcc: z.array(EmailRecipient).optional(),

      // Either templateId+params OR subject/htmlContent
      templateId: z.number().int().optional(),
      params: z.record(z.string(), z.unknown()).optional(),

      subject: z.string().optional(),
      htmlContent: z.string().optional(),
      textContent: z.string().optional(),

      replyTo: z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      tags: z.array(z.string()).optional(),
      attachments: z.array(Attachment).optional()
    }
  },
  async (args) => {
    const key = requireApiKey(args.apiKey);

    const usingTemplate = !!args.templateId;
    if (!usingTemplate && (!args.subject || !args.htmlContent)) {
      throw new Error("Provide either templateId (+params) OR subject + htmlContent.");
    }

    const payload: any = {
      sender: args.sender,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      replyTo: args.replyTo,
      headers: args.headers,
      tags: args.tags,
      attachments: args.attachments,
    };

    if (usingTemplate) {
      payload.templateId = args.templateId;
      if (args.params) payload.params = args.params;
      // Brevo note: if templateId is used, attachments generally must be by URL; base64 may be ignored. :contentReference[oaicite:1]{index=1}
    } else {
      payload.subject = args.subject;
      payload.htmlContent = args.htmlContent;
      if (args.textContent) payload.textContent = args.textContent;
    }

    const res = await brevoFetch<any>("/smtp/email", "POST", key, payload);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  }
);

/** Create a contact */
server.registerTool(
  "brevo.createContact",
  {
    title: "Create contact",
    description: "POST /v3/contacts — email or phone in attributes.SMS, optional listIds.",
    inputSchema: {
      apiKey: z.string().optional(),
      email: z.string().email().optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
      listIds: z.array(z.number().int()).optional(),
      updateEnabled: z.boolean().default(true)
    }
  },
  async ({ apiKey, email, attributes, listIds, updateEnabled }) => {
    const key = requireApiKey(apiKey);
    const body: any = { email, attributes, listIds, updateEnabled };
    const res = await brevoFetch<any>("/contacts", "POST", key, body);
    return { content: [{ type: "text", text: JSON.stringify(res) }] };
  }
);

/** Get contacts */
server.registerTool(
  "brevo.getContacts",
  {
    title: "Get contacts",
    description: "GET /v3/contacts with pagination (and optional modifiedSince).",
    inputSchema: {
      apiKey: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
      sort: z.enum(["asc","desc"]).default("desc"),
      modifiedSince: z.string().datetime().optional()
    }
  },
  async ({ apiKey, limit, offset, sort, modifiedSince }) => {
    const key = requireApiKey(apiKey);
    const data = await brevoFetch<any>("/contacts", "GET", key, undefined, { limit, offset, sort, modifiedSince });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** Get lists */
server.registerTool(
  "brevo.getLists",
  {
    title: "Get contact lists",
    description: "GET /v3/contacts/lists",
    inputSchema: {
      apiKey: z.string().optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
      sort: z.enum(["asc","desc"]).default("desc")
    }
  },
  async ({ apiKey, limit, offset, sort }) => {
    const key = requireApiKey(apiKey);
    const data = await brevoFetch<any>("/contacts/lists", "GET", key, undefined, { limit, offset, sort });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** Add contacts to a list */
server.registerTool(
  "brevo.addContactToList",
  {
    title: "Add existing contacts to a list",
    description: "POST /v3/contacts/lists/{listId}/contacts/add — pass emails, ids or extIds.",
    inputSchema: {
      apiKey: z.string().optional(),
      listId: z.number().int(),
      emails: z.array(z.string().email()).optional(),
      ids: z.array(z.number().int()).optional(),
      extIds: z.array(z.string()).optional()
    }
  },
  async ({ apiKey, listId, emails, ids, extIds }) => {
    const key = requireApiKey(apiKey);
    const body: any = { emails, ids, extIds };
    const data = await brevoFetch<any>(`/contacts/lists/${listId}/contacts/add`, "POST", key, body);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  }
);

/** Boot stdio */
const transport = new StdioServerTransport();
await server.connect(transport);
