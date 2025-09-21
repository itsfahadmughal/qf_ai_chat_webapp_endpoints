import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prisma } from "../db.js";

type ClientEntry = { client: Client; transport: StdioClientTransport };

function isDisconnectError(e: unknown): boolean {
  const m = String((e as any)?.message ?? e ?? "");
  return (
    m.includes("not connected") ||
    m.includes("closed") ||
    m.includes("EPIPE") ||
    m.includes("ECONNRESET") ||
    m.includes("write EPIPE") ||
    m.includes("read ENOTCONN")
  );
}

class MCPManager {
  private byId = new Map<string, ClientEntry>();

  private async spawnFromDb(serverId: string) {
    const server = await prisma.mCPServer.findUnique({ where: { id: serverId } });
    if (!server || !server.isActive) throw new Error("MCP server not found or inactive");
    if (server.transport !== "stdio" || !server.command) {
      throw new Error("Only stdio transport supported in this build");
    }

    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args ?? []
    });

    const client = new Client({ name: "chat-api", version: "1.0.0" });
    await client.connect(transport);

    // Optional: warm-up to ensure it’s actually alive
    try { await client.listTools(); } catch (e) {
      try { await transport.close?.(); } catch {}
      throw e;
    }

    this.byId.set(serverId, { client, transport });
    return client;
  }

  private markDead(serverId: string) {
    const entry = this.byId.get(serverId);
    if (entry) {
      try { entry.transport.close?.(); } catch {}
      this.byId.delete(serverId);
    }
  }

  private async getClient(serverId: string) {
    const entry = this.byId.get(serverId);
    if (entry) return entry.client;
    return this.spawnFromDb(serverId);
  }

  // Wrap a call with 1 automatic respawn attempt
  private async withClient<T>(serverId: string, fn: (c: Client) => Promise<T>): Promise<T> {
    let client = await this.getClient(serverId);
    try {
      return await fn(client);
    } catch (e) {
      if (!isDisconnectError(e)) throw e;
      // respawn once
      this.markDead(serverId);
      client = await this.getClient(serverId);
      return await fn(client);
    }
  }

  async listTools(serverId: string) {
    return this.withClient(serverId, (c) => c.listTools());
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>) {
    return this.withClient(serverId, (c) => c.callTool({ name, arguments: args }));
  }

  async close(serverId: string) { this.markDead(serverId); }
}

export const mcpManager = new MCPManager();