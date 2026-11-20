/**
 * MCP boundary (CLAUDE.md rule 1): everything that crosses from an MCP server or `.mcp.json` into our code is parsed
 * here with Zod before use. This is the only folder where `any` is tolerated by lint.
 */
import { z } from 'zod';

export const StdioServer = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
export const HttpServer = z.object({
  type: z.literal('http'), // streamable HTTP; legacy SSE is deprecated and not supported
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});
export const ServerConfig = z.union([HttpServer, StdioServer]);
export type ServerConfig = z.infer<typeof ServerConfig>;

export const McpJson = z.looseObject({ mcpServers: z.record(z.string(), ServerConfig) });
export type McpJson = z.infer<typeof McpJson>;

export const ToolDescriptor = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.looseObject({}).optional(),
  annotations: z
    .looseObject({ readOnlyHint: z.boolean().optional(), destructiveHint: z.boolean().optional() })
    .optional(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const ListToolsResult = z.looseObject({
  tools: z.array(ToolDescriptor),
  nextCursor: z.string().optional(),
});

const ContentBlock = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('image'), mimeType: z.string(), data: z.string() }),
  z.looseObject({ type: z.string() }),
]);

export const CallToolResult = z.looseObject({
  content: z.array(ContentBlock).default([]),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});
export type CallToolResult = z.infer<typeof CallToolResult>;

/** Plain text of a tool result (images are dropped: no screenshots leave via this path). */
export function resultText(r: CallToolResult): string {
  return r.content.map((c) => ('text' in c && typeof c.text === 'string' ? c.text : `[${c.type} omitted]`)).join('\n');
}
