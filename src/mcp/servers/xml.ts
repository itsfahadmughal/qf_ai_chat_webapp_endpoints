import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod"; // v3.x (pin 3.23.8 in package.json if needed)
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import xpath from "xpath";

/** ----------------------------------------------------------------
 * Utilities
 * ---------------------------------------------------------------- */
const server = new McpServer({ name: "xml-mcp", version: "1.3.0" });

type CacheEntry = { text: string; expires: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(url: string, headers?: Record<string, string>) {
  return `${url}::${JSON.stringify(headers || {})}`;
}

async function fetchXmlText(
  url: string,
  headers?: Record<string, string>,
  maxBytes = 2_000_000,
  cacheTtlSec = 60,
  basicAuth?: { username: string; password: string }
) {
  const key = cacheKey(url, headers);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.text;

  const hdrs: Record<string, string> = { ...(headers || {}), Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8" };
  if (basicAuth) {
    const b64 = Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString("base64");
    hdrs["Authorization"] = `Basic ${b64}`;
  }

  const res = await fetch(url, { headers: hdrs });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  const ab = await res.arrayBuffer();
  if (ab.byteLength > maxBytes) throw new Error(`Response too large (> ${maxBytes} bytes)`);
  const text = new TextDecoder("utf-8").decode(ab);

  if (cacheTtlSec > 0) cache.set(key, { text, expires: now + cacheTtlSec * 1000 });
  return text;
}

function parseXml(text: string) {
  return new DOMParser({
    errorHandler: {
      warning: () => {},
      error: (e) => { throw new Error(String(e)); },
      fatalError: (e) => { throw new Error(String(e)); }
    }
  }).parseFromString(text, "text/xml");
}

function nodeToString(n: any): string {
  if (n == null) return "";
  if (typeof n === "number" || typeof n === "boolean") return String(n);
  if (n.nodeType === 2 && typeof n.value === "string") return n.value; // attribute
  if (typeof n.textContent === "string") return n.textContent;
  try { return new XMLSerializer().serializeToString(n); } catch { return String(n); }
}

/** Inspect namespaces on root (your feed shows none, but keep generic) */
function inspectNamespaces(doc: Document) {
  const root = (doc as any).documentElement;
  const ns: Record<string, string> = {};
  if (root && root.attributes) {
    for (let i = 0; i < root.attributes.length; i++) {
      const a = root.attributes[i];
      if (!a || !a.name) continue;
      if (a.name === "xmlns") ns["#default"] = a.value;
      else if (a.name.startsWith("xmlns:")) ns[a.name.substring(6)] = a.value;
    }
  }
  return { rootName: root?.nodeName ?? "", namespaces: ns };
}

/** Normalize tag names for matching (German-friendly) */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "a")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Get attribute by name (case-insensitive) */
function getAttr(node: any, name: string): string | undefined {
  if (!node?.attributes) return undefined;
  const target = norm(name.replace(/^@/, ""));
  for (let i = 0; i < node.attributes.length; i++) {
    const a = node.attributes[i];
    if (!a?.name) continue;
    if (norm(a.name) === target) return a.value?.trim();
  }
  return undefined;
}

/** Find first child element by exact name (case/umlaut-insensitive), else by contains */
function findChild(node: any, name: string): any | undefined {
  if (!node?.childNodes) return undefined;
  const want = norm(name);
  let loose: any | undefined;
  for (let i = 0; i < node.childNodes.length; i++) {
    const c = node.childNodes[i];
    if (c && c.nodeType === 1 && typeof c.nodeName === "string") {
      const have = norm(c.nodeName);
      if (have === want) return c;
      if (!loose && have.includes(want)) loose = c;
    }
  }
  return loose;
}

/** Resolve selector like "@id", "GastName", "Gast/Name" against a record node */
function selectValueBySelector(recordNode: any, selector: string): string | undefined {
  if (!selector) return undefined;
  if (selector.startsWith("@")) {
    return getAttr(recordNode, selector);
  }
  // nested path: Child/SubChild/...
  const parts = selector.split("/").filter(Boolean);
  let node: any = recordNode;
  for (const part of parts) {
    node = findChild(node, part);
    if (!node) return undefined;
  }
  // return text (first leaf text)
  const text = nodeToString(node);
  if (!text) return undefined;
  // If it's an element, take its textContent (serializeToString returned markup); else keep string
  if (node.nodeType === 1 && typeof node.textContent === "string") return node.textContent.trim();
  return String(text).trim();
}

/** ----------------------------------------------------------------
 * Tools
 * ---------------------------------------------------------------- */

/** Inspect: root + namespaces */
server.registerTool(
  "xml.inspect",
  {
    title: "Inspect XML Root & Namespaces",
    description: "Fetches XML and returns root element name and namespace map.",
    inputSchema: {
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, headers, maxBytes, cacheTtlSec, basicAuth }) => {
    const text = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(text);
    return { content: [{ type: "text", text: JSON.stringify(inspectNamespaces(doc)) }] };
  }
);

/** Fetch raw XML text */
server.registerTool(
  "xml.fetchText",
  {
    title: "Fetch XML Text",
    description: "Downloads XML and returns the raw XML string (truncated if huge).",
    inputSchema: {
      url: z.string().url(),
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      maxChars: z.number().default(100_000),
      cacheTtlSec: z.number().default(60),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, headers, maxBytes, maxChars, cacheTtlSec, basicAuth }) => {
    const text = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const out = text.length > maxChars ? text.slice(0, maxChars) + "\n[truncated]" : text;
    return { content: [{ type: "text", text: out }] };
  }
);

/** XPath query (XPath 1.0) */
server.registerTool(
  "xml.xpath",
  {
    title: "XPath Query",
    description: "Fetches XML and evaluates an XPath (XPath 1.0, no map over node-sets).",
    inputSchema: {
      url: z.string().url(),
      xpath: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      limit: z.number().default(1000),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, xpath: expr, headers, maxBytes, cacheTtlSec, limit, basicAuth }) => {
    const xml = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(xml);
    const sel = (xpath.select as any);
    const out = sel(expr, doc) as any;
    const arr = Array.isArray(out) ? out : [out];
    const values = arr.slice(0, limit).map(nodeToString);
    return { content: [{ type: "text", text: JSON.stringify({ count: values.length, values }) }] };
  }
);

/** List immediate child element names of the first node matching `base` */
server.registerTool(
  "xml.childNames",
  {
    title: "List child element names",
    description: "Selects the first node from `base` and returns its immediate child element names.",
    inputSchema: {
      url: z.string().url(),
      base: z.string(), // e.g. "/Zimmerreservierungen/*[1]"
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, base, headers, maxBytes, cacheTtlSec, basicAuth }) => {
    const xml = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(xml);
    const sel = (xpath.select as any);
    const nodes = sel(base, doc) as any[];
    const node = Array.isArray(nodes) ? nodes[0] : nodes;
    if (!node) return { content: [{ type: "text", text: JSON.stringify({ count: 0, names: [] }) }] };
    const names: string[] = [];
    for (let i = 0; i < node.childNodes.length; i++) {
      const c = node.childNodes[i];
      if (c && c.nodeType === 1 && typeof c.nodeName === "string") names.push(c.nodeName);
    }
    return { content: [{ type: "text", text: JSON.stringify({ count: names.length, names }) }] };
  }
);

/** Return the first record's XML markup */
server.registerTool(
  "xml.firstRecord",
  {
    title: "First record XML",
    description: "Serializes the first node from `base` and returns its XML.",
    inputSchema: {
      url: z.string().url(),
      base: z.string(), // e.g. "/Zimmerreservierungen/*[1]"
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, base, headers, maxBytes, cacheTtlSec, basicAuth }) => {
    const xml = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(xml);
    const sel = (xpath.select as any);
    const nodes = sel(base, doc) as any[];
    const node = Array.isArray(nodes) ? nodes[0] : nodes;
    if (!node) return { content: [{ type: "text", text: "Not found" }] };
    const text = new XMLSerializer().serializeToString(node);
    return { content: [{ type: "text", text }] };
  }
);

/** XPath-driven extract (you provide explicit field XPaths) */
server.registerTool(
  "xml.extract",
  {
    title: "Extract Table From Repeating Nodes",
    description: "Select a base node set via XPath, then extract fields via relative XPath expressions.",
    inputSchema: {
      url: z.string().url(),
      base: z.string(),
      fields: z.record(z.string(), z.string()),
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      limit: z.number().default(500),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, base, fields, headers, maxBytes, cacheTtlSec, limit, basicAuth }) => {
    const xml = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(xml);
    const sel = (xpath.select as any);

    const baseNodes = sel(base, doc) as any[];
    const take = (Array.isArray(baseNodes) ? baseNodes : [baseNodes]).slice(0, limit);

    const rows = take.map((node) => {
      const obj: Record<string, string> = {};
      for (const [key, rel] of Object.entries(fields)) {
        const found = sel(rel, node) as any[];
        if (Array.isArray(found) && found.length > 0) obj[key] = nodeToString(found[0]).trim();
        else if (found) obj[key] = nodeToString(found).trim();
        else obj[key] = "";
      }
      return obj;
    });

    return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, rows }) }] };
  }
);

/** Heuristic extract for your no-namespace ASA feed (Zimmerreservierungen) */
server.registerTool(
  "xml.extractAuto",
  {
    title: "Extract (Auto map common German fields)",
    description:
      "For feeds like Zimmerreservierungen (no namespaces). Selects base nodes and auto-maps common fields (Gast, Anreise, Abreise, Zimmer, etc.). You can override/extend columns.",
    inputSchema: {
      url: z.string().url(),
      base: z.string().default("/Zimmerreservierungen/*"),
      columns: z.record(z.string(), z.array(z.string())).optional(), // { guest: ["Gast/Name","GastName","Gast"], ... }
      headers: z.record(z.string(), z.string()).optional(),
      maxBytes: z.number().default(2_000_000),
      cacheTtlSec: z.number().default(60),
      limit: z.number().default(200),
      basicAuth: z.object({ username: z.string(), password: z.string() }).optional()
    }
  },
  async ({ url, base, columns, headers, maxBytes, cacheTtlSec, limit, basicAuth }) => {
    const defaults: Record<string, string[]> = {
      id: ["@id", "@nummer", "@reservierungsnummer", "Reservierungsnummer", "ReservierungID", "ID"],
      guest: ["Gast/Name", "GastName", "Gast", "Name"],
      checkIn: ["Anreise", "AnreiseDatum", "CheckIn", "Checkin"],
      checkOut: ["Abreise", "AbreiseDatum", "CheckOut", "Checkout"],
      room: ["Zimmer", "ZimmerNummer", "Zimmernummer", "Raum"],
      status: ["Status", "Reservierungsstatus", "Buchungsstatus"]
    };
    const cols = columns ? { ...defaults, ...columns } : defaults;

    const xml = await fetchXmlText(url, headers, maxBytes, cacheTtlSec, basicAuth);
    const doc = parseXml(xml);
    const sel = (xpath.select as any);

    const baseNodes = sel(base, doc) as any[];
    const recs = (Array.isArray(baseNodes) ? baseNodes : [baseNodes]).slice(0, limit);

    const rows = recs.map((rec) => {
      const obj: Record<string, string> = {};
      for (const [outName, candidates] of Object.entries(cols)) {
        let v: string | undefined;
        for (const cand of candidates) {
          v = selectValueBySelector(rec, cand);
          if (v != null && v !== "") break;
        }
        obj[outName] = v ?? "";
      }
      return obj;
    });

    return { content: [{ type: "text", text: JSON.stringify({ count: rows.length, rows }) }] };
  }
);

/** Boot stdio */
const transport = new StdioServerTransport();
await server.connect(transport);
