// src/mcp/servers/energy.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod"; // Use zod v3 (pinned), not v4
import ModbusRTU from "modbus-serial";

const server = new McpServer({ name: "energy-mcp", version: "1.2.0" });

type ModbusClient = any;
const ModbusCtor: any = (ModbusRTU as any);

async function withModbus<T>(
  host: string,
  port: number,
  unitId: number,
  fn: (c: ModbusClient) => Promise<T>
) {
  const client: ModbusClient = new ModbusCtor();
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    const result = await fn(client);
    return result;
  } finally {
    try { client.close(); } catch {}
  }
}
/** Addressing modes */
const Addressing = z.enum(["zeroBased", "oneBased", "legacy4x", "legacy3x"]);
function normalizeAddress(addr: number, addressing: z.infer<typeof Addressing> = "zeroBased") {
  switch (addressing) {
    case "zeroBased": return addr;
    case "oneBased":  return addr - 1;       // 1 -> 0
    case "legacy4x":  return addr - 40001;   // 40001 -> 0 (Holding)
    case "legacy3x":  return addr - 30001;   // 30001 -> 0 (Input)
    default:          return addr;
  }
}

/** Decoding formats */
const Format = z.enum([
  "int16", "uint16",
  "int32be", "int32le",
  "uint32be", "uint32le",
  "float32be", "float32le"
]);

function toSigned16(v: number) { return v > 0x7FFF ? v - 0x10000 : v; }
function toSigned32(v: number) { return v > 0x7FFFFFFF ? v - 0x100000000 : v; }

/** Decode an array of 16-bit register values to requested format */
function decode(data: number[], format?: z.infer<typeof Format>, scale: number = 1): number[] {
  if (!format || format === "int16") {
    return data.map(v => toSigned16(v) * scale);
  }
  if (format === "uint16") {
    return data.map(v => (v >>> 0) * scale);
  }

  // 32-bit formats: consume 2 registers per value
  const out: number[] = [];
  for (let i = 0; i + 1 < data.length; i += 2) {
    const hi = data[i] & 0xFFFF;
    const lo = data[i + 1] & 0xFFFF;

    if (format === "int32be" || format === "int32le" || format === "uint32be" || format === "uint32le") {
      let n: number;
      if (format.endsWith("be")) n = ((hi << 16) | lo) >>> 0;   // big-endian words
      else                       n = ((lo << 16) | hi) >>> 0;   // little-endian words

      if (format.startsWith("int32")) out.push(toSigned32(n) * scale);
      else out.push((n >>> 0) * scale);
      continue;
    }

    if (format === "float32be" || format === "float32le") {
      const buf = new ArrayBuffer(4);
      const view = new DataView(buf);
      if (format === "float32be") { view.setUint16(0, hi, false); view.setUint16(2, lo, false); out.push(view.getFloat32(0, false) * scale); }
      else                        { view.setUint16(0, lo, true);  view.setUint16(2, hi, true);  out.push(view.getFloat32(0, true)  * scale); }
      continue;
    }
  }
  return out;
}

/** Common options schema for read tools */
const CommonReadShape = {
  host: z.string(),
  port: z.number().default(502),
  unitId: z.number().default(1),
  address: z.number().min(0),
  length: z.number().min(1).max(125),
  addressing: Addressing.optional(),      // default handled in code
  format: Format.optional(),              // if omitted → int16
  scale: z.number().default(1).optional() // multiply decoded numbers
};

// --- FC3: Read Holding Registers ---
server.registerTool(
  "energy.readHoldingRegisters",
  {
    title: "Read Holding Registers (FC3)",
    description: "Reads 16-bit holding registers with optional decoding and addressing conversions.",
    inputSchema: CommonReadShape
  },
  async ({ host, port, unitId, address, length, addressing = "zeroBased", format, scale = 1 }) => {
    const eff = normalizeAddress(address, addressing);
    const resp = await withModbus(host, port, unitId, async (c) => c.readHoldingRegisters(eff, length));
    const raw = resp.data as number[];
    const decoded = decode(raw, format, scale);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ fc: 3, unitId, address, eff, length, addressing, format: format || "int16", scale, raw, decoded })
      }]
    };
  }
);

// --- FC4: Read Input Registers ---
server.registerTool(
  "energy.readInputRegisters",
  {
    title: "Read Input Registers (FC4)",
    description: "Reads 16-bit input registers with optional decoding and addressing conversions.",
    inputSchema: CommonReadShape
  },
  async ({ host, port, unitId, address, length, addressing = "zeroBased", format, scale = 1 }) => {
    const eff = normalizeAddress(address, addressing);
    const resp = await withModbus(host, port, unitId, async (c: any) => c.readInputRegisters(eff, length));
    const raw = resp.data as number[];
    const decoded = decode(raw, format, scale);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ fc: 4, unitId, address, eff, length, addressing, format: format || "int16", scale, raw, decoded })
      }]
    };
  }
);

// --- FC6: Write Single Register ---
server.registerTool(
  "energy.writeSingleRegister",
  {
    title: "Write Single Register (FC6)",
    description: "Writes a single 16-bit holding register.",
    inputSchema: {
      host: z.string(),
      port: z.number().default(502),
      unitId: z.number().default(1),
      address: z.number().min(0),
      value: z.number().min(0).max(0xFFFF),
      addressing: Addressing.optional()
    }
  },
  async ({ host, port, unitId, address, value, addressing = "zeroBased" }) => {
    const eff = normalizeAddress(address, addressing);
    await withModbus(host, port, unitId, async (c) => c.writeRegister(eff, value));
    return { content: [{ type: "text", text: JSON.stringify({ fc: 6, unitId, address, eff, value, ok: true }) }] };
  }
);

// (Optional) Coils/Discrete Inputs could be added similarly

const transport = new StdioServerTransport();
await server.connect(transport);