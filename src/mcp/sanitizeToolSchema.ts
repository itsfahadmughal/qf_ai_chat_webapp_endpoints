// src/routes/mcp/utils/sanitizeToolSchema.ts
export function stripApiKeyFromSchema<T extends Record<string, any>>(schema: T): T {
  if (!schema || typeof schema !== "object") return schema;

  // Only touch JSON object schemas
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    // clone shallowly to avoid mutating the upstream result
    const next: any = { ...schema, properties: { ...schema.properties } };

    // 1) Remove the apiKey property (if present)
    if ("apiKey" in next.properties) delete next.properties.apiKey;

    // 2) Remove from `required` (if present)
    if (Array.isArray(next.required)) {
      next.required = next.required.filter((k: string) => k !== "apiKey");
      if (next.required.length === 0) delete next.required; // optional clean-up
    }

    return next;
  }

  // If you ever nest input schemas, recurse here as needed.
  return schema;
}

export function sanitizeToolsResponse(tools: any[]) {
  return tools.map((t) => {
    const tool = { ...t };
    if (tool.inputSchema) {
      tool.inputSchema = stripApiKeyFromSchema(tool.inputSchema);
    }
    return tool;
  });
}
