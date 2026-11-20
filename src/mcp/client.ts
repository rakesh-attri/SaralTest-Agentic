import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { classifyError } from '../core/classifyError.js';
import { HardStopError, QAError, type HardStopReason } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import type { AuditLog } from '../security/audit.js';
import type { Redactor } from '../security/redact.js';
import type { ToolAllowList, ToolClass } from './allowList.js';
import {
  CallToolResult,
  ListToolsResult,
  McpJson,
  resultText,
  type ServerConfig,
  type ToolDescriptor,
} from './boundary/schemas.js';

/** Who is acting — recorded in every audit entry. */
export interface CallContext {
  runId: string;
  orgId: string;
  user: string;
  persona: string;
  approvalId?: string;
  /** Salesforce object / record touched, if known (for the audit trail). */
  object?: string;
  recordId?: string;
}

export interface MutationRequest {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  ctx: CallContext;
}
export type MutationDecision =
  { allowed: true; approvalId?: string } | { allowed: false; reason: string; hardStop?: HardStopReason };

/**
 * Decides whether a `mutate` tool call may run (org profile + policy + approvals). Phase 0 ships a deny-all default;
 * Phase 2 plugs in org-profile enforcement. Secure by default: no guard → no mutations.
 */
export type MutationGuard = (req: MutationRequest) => Promise<MutationDecision>;
export const denyAllMutations: MutationGuard = () =>
  Promise.resolve({ allowed: false, reason: 'no mutation guard configured (org-profile enforcement is Phase 2)' });

export interface AllowedTool {
  server: string;
  name: string;
  class: Exclude<ToolClass, 'blocked' | 'unlisted'>;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ServerHealth {
  server: string;
  ok: boolean;
  durationMs: number;
  tools: string[];
  error?: string;
  kind?: string;
}

export type TransportFactory = (name: string, cfg: ServerConfig) => Transport;

/** Default transports. stdio uses cross-spawn (resolves `npx.cmd` on Windows) and a minimal inherited env. */
export const defaultTransportFactory: TransportFactory = (_name, cfg) => {
  if ('url' in cfg) {
    const url = new URL(cfg.url);
    const init = cfg.headers ? { requestInit: { headers: cfg.headers } } : {};
    return new StreamableHTTPClientTransport(url, init);
  }
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    // Only the SDK's safe default env + explicit server env: our API keys are not handed to MCP servers.
    env: { ...getDefaultEnvironment(), ...cfg.env },
    ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
    stderr: 'pipe',
  });
};

export async function loadMcpJson(root: string): Promise<McpJson> {
  const file = join(root, '.mcp.json');
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    throw new QAError('TOOL_UNAVAILABLE', `.mcp.json not found at ${file} (copy .mcp.example.json)`);
  }
  const parsed = McpJson.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new QAError(
      'TOOL_UNAVAILABLE',
      `.mcp.json is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface McpHubOptions {
  servers: Record<string, ServerConfig>;
  allowList: ToolAllowList;
  audit?: AuditLog;
  redactor: Redactor;
  logger?: Logger;
  mutationGuard?: MutationGuard;
  transportFactory?: TransportFactory;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

/**
 * Runtime MCP client (PLAN.md §7d). Exposes only allow-listed tools tagged observe/mutate; refuses blocked or
 * unlisted tools; routes every mutation through the guard and the audit log; parses every result with Zod.
 */
export class McpHub {
  private readonly clients = new Map<string, Client>();
  private readonly toolCache = new Map<string, ToolDescriptor[]>();

  constructor(private readonly opts: McpHubOptions) {}

  serverNames(): string[] {
    return Object.keys(this.opts.servers);
  }

  private async client(server: string): Promise<Client> {
    const existing = this.clients.get(server);
    if (existing) return existing;
    const cfg = this.opts.servers[server];
    if (!cfg) throw new QAError('TOOL_UNAVAILABLE', `MCP server "${server}" is not configured in .mcp.json`);
    const transport = (this.opts.transportFactory ?? defaultTransportFactory)(server, cfg);
    const client = new Client({ name: 'sf-qa-agent', version: '0.0.1' });
    const timeout = this.opts.connectTimeoutMs ?? 60_000;
    try {
      await client.connect(transport, { timeout });
    } catch (err) {
      await client.close().catch(() => undefined);
      const c = classifyError(err);
      throw new QAError(
        c.kind === 'UNKNOWN' ? 'TOOL_UNAVAILABLE' : c.kind,
        `MCP ${server}: connect failed — ${c.message}`,
        {
          server,
          ...c.detail,
        },
      );
    }
    this.clients.set(server, client);
    return client;
  }

  /** Every tool the server offers (unfiltered — for doctor / classification only, never handed to agents). */
  async listServerTools(server: string): Promise<ToolDescriptor[]> {
    const cached = this.toolCache.get(server);
    if (cached) return cached;
    const c = await this.client(server);
    const tools: ToolDescriptor[] = [];
    let cursor: string | undefined;
    do {
      const page = ListToolsResult.parse(
        await c.listTools(cursor ? { cursor } : {}, { timeout: this.opts.callTimeoutMs ?? 60_000 }),
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    this.toolCache.set(server, tools);
    return tools;
  }

  /** Allow-listed tools only, tagged observe/mutate. This is what agents receive. */
  async tools(server: string): Promise<AllowedTool[]> {
    const all = await this.listServerTools(server);
    const out: AllowedTool[] = [];
    for (const t of all) {
      const cls = this.opts.allowList.classify(server, t.name);
      if (cls !== 'observe' && cls !== 'mutate') continue;
      out.push({
        server,
        name: t.name,
        class: cls,
        ...(t.description ? { description: t.description } : {}),
        ...(t.inputSchema ? { inputSchema: t.inputSchema } : {}),
      });
    }
    return out;
  }

  async health(server: string): Promise<ServerHealth> {
    const started = Date.now();
    try {
      const tools = await this.listServerTools(server);
      return { server, ok: true, durationMs: Date.now() - started, tools: tools.map((t) => t.name).sort() };
    } catch (err) {
      const c = classifyError(err);
      return { server, ok: false, durationMs: Date.now() - started, tools: [], error: c.message, kind: c.kind };
    }
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<{ result: CallToolResult; text: string; class: 'observe' | 'mutate' }> {
    const cls = this.opts.allowList.classify(server, tool);
    const auditBase = {
      runId: ctx.runId,
      orgId: ctx.orgId,
      user: ctx.user,
      persona: ctx.persona,
      tool: `${server}.${tool}`,
      ...(ctx.object ? { object: ctx.object } : {}),
      ...(ctx.recordId ? { recordId: ctx.recordId } : {}),
    };

    if (cls === 'blocked' || cls === 'unlisted') {
      this.opts.audit?.append({ ...auditBase, action: 'mutate', outcome: 'REFUSED', before: { args } });
      this.opts.logger?.warn({ server, tool, cls }, 'MCP tool refused by allow-list');
      throw new QAError('TOOL_UNAVAILABLE', `MCP tool ${server}.${tool} is ${cls} by config/mcp-tools.yaml`, {
        server,
        tool,
        refused: cls,
      });
    }

    let approvalId = ctx.approvalId;
    if (cls === 'mutate') {
      const decision = await (this.opts.mutationGuard ?? denyAllMutations)({ server, tool, args, ctx });
      if (!decision.allowed) {
        this.opts.audit?.append({ ...auditBase, action: 'mutate', outcome: 'REFUSED', before: { args } });
        if (decision.hardStop) throw new HardStopError(decision.hardStop, decision.reason);
        throw new QAError('TOOL_UNAVAILABLE', `mutation ${server}.${tool} refused: ${decision.reason}`, {
          server,
          tool,
          refused: 'policy',
        });
      }
      approvalId = decision.approvalId ?? approvalId;
      // Write-ahead: the intent is on disk before the call goes out.
      this.opts.audit?.append({
        ...auditBase,
        action: 'mutate',
        outcome: 'ALLOWED',
        before: { args },
        ...(approvalId ? { approvalId } : {}),
      });
    }

    const c = await this.client(server);
    let result: CallToolResult;
    try {
      result = CallToolResult.parse(
        await c.callTool({ name: tool, arguments: args }, undefined, { timeout: this.opts.callTimeoutMs ?? 120_000 }),
      );
    } catch (err) {
      if (cls === 'mutate') {
        this.opts.audit?.append({ ...auditBase, action: 'mutate', outcome: 'FAILED', after: { error: String(err) } });
      }
      throw err;
    }
    const text = resultText(result);
    if (cls === 'mutate') {
      this.opts.audit?.append({
        ...auditBase,
        action: 'mutate',
        outcome: result.isError ? 'FAILED' : 'SUCCEEDED',
        after: result.structuredContent ?? { text },
        ...(approvalId ? { approvalId } : {}),
      });
    }
    if (result.isError) {
      const k = classifyError(new Error(text)).kind;
      throw new QAError(
        k === 'UNKNOWN' ? 'UNKNOWN' : k,
        `MCP ${server}.${tool} returned an error: ${this.opts.redactor.redactText(text).slice(0, 500)}`,
        {
          server,
          tool,
        },
      );
    }
    return { result, text, class: cls };
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
    this.toolCache.clear();
  }
}
