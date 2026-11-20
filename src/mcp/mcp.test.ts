import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyError } from '../core/classifyError.js';
import { HardStopError } from '../core/errors.js';
import { McpToolsConfig } from '../config/schemas.js';
import { requireConfig, projectPaths } from '../config/loader.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import { ToolAllowList } from './allowList.js';
import { McpHub, type CallContext, type MutationGuard } from './client.js';
import { createFakeServer } from '../../tests/fixtures/mcp-fake-server.mjs';

const fixtureServerPath = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'mcp-fake-server.mjs');

const allow = new ToolAllowList(
  McpToolsConfig.parse({
    fake: { observe: ['get_record', 'failing_tool'], mutate: ['create_record'], blocked: ['deploy_metadata'] },
  }),
);
const ctx: CallContext = { runId: 'run-mcp', orgId: '00DFIXTURE00000001', user: 'qa', persona: 'system-admin' };

interface Fake {
  server: { connect: (t: unknown) => Promise<void> };
  calls: string[];
}

describe('ToolAllowList', () => {
  it('classifies observe / mutate / blocked / unlisted', () => {
    expect(allow.classify('fake', 'get_record')).toBe('observe');
    expect(allow.classify('fake', 'create_record')).toBe('mutate');
    expect(allow.classify('fake', 'deploy_metadata')).toBe('blocked');
    expect(allow.classify('fake', 'mystery_tool')).toBe('unlisted');
    expect(allow.classify('other', 'get_record')).toBe('unlisted');
    expect(allow.unclassified('fake', ['get_record', 'mystery_tool'])).toEqual(['mystery_tool']);
    expect(allow.stale('fake', ['get_record'])).toEqual(['failing_tool', 'create_record']);
  });

  it('repo config blocks Playwright evaluate / run_code_unsafe (PLAN.md §7d)', async () => {
    const repoAllow = new ToolAllowList(
      await requireConfig('mcp-tools', projectPaths(join(import.meta.dirname, '..', '..'))),
    );
    expect(repoAllow.classify('playwright', 'browser_evaluate')).toBe('blocked');
    expect(repoAllow.classify('playwright', 'browser_run_code_unsafe')).toBe('blocked');
    expect(repoAllow.classify('playwright', 'browser_snapshot')).toBe('observe');
    expect(repoAllow.classify('playwright', 'browser_click')).toBe('mutate');
  });
});

describe('McpHub (in-memory MCP server)', () => {
  let dir: string;
  let fake: Fake;
  let audit: AuditLog;
  const hub = (guard?: MutationGuard): McpHub =>
    new McpHub({
      servers: { fake: { command: 'unused', args: [] } },
      allowList: allow,
      audit,
      redactor: new Redactor(),
      ...(guard ? { mutationGuard: guard } : {}),
      transportFactory: () => {
        const [clientT, serverT] = InMemoryTransport.createLinkedPair();
        void fake.server.connect(serverT);
        return clientT;
      },
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa mcp '));
    fake = createFakeServer() as Fake;
    audit = new AuditLog(join(dir, 'audit.jsonl'), new Redactor());
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('health lists the real tools; tools() exposes only allow-listed ones, tagged', async () => {
    const h = hub();
    const health = await h.health('fake');
    expect(health.ok).toBe(true);
    expect(health.tools).toEqual(['create_record', 'deploy_metadata', 'failing_tool', 'get_record', 'mystery_tool']);
    const exposed = await h.tools('fake');
    expect(exposed.map((t) => `${t.name}:${t.class}`).sort()).toEqual([
      'create_record:mutate',
      'failing_tool:observe',
      'get_record:observe',
    ]);
    await h.close();
  });

  it('observe calls run without audit entries', async () => {
    const h = hub();
    const r = await h.callTool('fake', 'get_record', { id: '001' }, ctx);
    expect(r.class).toBe('observe');
    expect(JSON.parse(r.text)).toEqual({ tool: 'get_record', args: { id: '001' } });
    expect(audit.read()).toHaveLength(0);
    await h.close();
  });

  it.each(['deploy_metadata', 'mystery_tool'])(
    'refuses %s (blocked/unlisted) and never calls the server',
    async (t) => {
      const h = hub();
      const err = await h.callTool('fake', t, {}, ctx).catch((e: unknown) => e);
      expect(classifyError(err).kind).toBe('TOOL_UNAVAILABLE');
      expect(fake.calls).not.toContain(t);
      expect(audit.read().map((a) => a.outcome)).toEqual(['REFUSED']);
      await h.close();
    },
  );

  it('mutations are denied by default (secure until Phase 2 org profiles)', async () => {
    const h = hub();
    const err = await h.callTool('fake', 'create_record', { Name: 'x' }, ctx).catch((e: unknown) => e);
    expect(String(err)).toMatch(/no mutation guard configured/);
    expect(fake.calls).toHaveLength(0);
    expect(audit.read()[0]?.outcome).toBe('REFUSED');
    await h.close();
  });

  it('allowed mutations are audit-logged write-ahead and after, with approval id', async () => {
    const h = hub(() => Promise.resolve({ allowed: true, approvalId: 'appr-1' }));
    const r = await h.callTool('fake', 'create_record', { LastName: 'Doe' }, { ...ctx, object: 'Contact' });
    expect(r.class).toBe('mutate');
    const entries = audit.read();
    expect(entries.map((e) => e.outcome)).toEqual(['ALLOWED', 'SUCCEEDED']);
    expect(entries.every((e) => e.approvalId === 'appr-1' && e.object === 'Contact')).toBe(true);
    expect(entries[0]?.before).toEqual({ args: { LastName: '<NAME_1>' } });
    await h.close();
  });

  it('a guard can turn a forbidden mutation into a hard stop', async () => {
    const h = hub(() =>
      Promise.resolve({ allowed: false, reason: 'metadata deploy', hardStop: 'METADATA_WRITE' as const }),
    );
    await expect(h.callTool('fake', 'create_record', {}, ctx)).rejects.toBeInstanceOf(HardStopError);
    await h.close();
  });

  it('tool error results become classified, redacted errors', async () => {
    const h = hub();
    const err = await h.callTool('fake', 'failing_tool', {}, ctx).catch((e: unknown) => e);
    expect(classifyError(err).kind).toBe('AUTH');
    expect(String(err)).toContain('<EMAIL_1>');
    expect(String(err)).not.toContain('jane@acme.example');
    await h.close();
  });

  it('unknown server → TOOL_UNAVAILABLE, health reports instead of throwing', async () => {
    const h = hub();
    const health = await h.health('nope');
    expect(health).toMatchObject({ ok: false, kind: 'TOOL_UNAVAILABLE' });
  });
});

describe('McpHub (real stdio process, cwd with spaces)', () => {
  it('spawns a stdio server via cross-spawn and lists its tools', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'qa mcp stdio '));
    const h = new McpHub({
      servers: { fake: { command: process.execPath, args: [fixtureServerPath], cwd } },
      allowList: allow,
      redactor: new Redactor(),
      connectTimeoutMs: 20_000,
    });
    const health = await h.health('fake');
    expect(health.error).toBeUndefined();
    expect(health.tools).toContain('get_record');
    const r = await h.callTool('fake', 'get_record', { id: 'x' }, ctx);
    expect(r.text).toContain('get_record');
    await h.close();
    await rm(cwd, { recursive: true, force: true });
  });

  it('a command that does not exist → TOOL_UNAVAILABLE', async () => {
    const h = new McpHub({
      servers: { ghost: { command: 'definitely-not-a-real-command-xyz', args: [] } },
      allowList: allow,
      redactor: new Redactor(),
      connectTimeoutMs: 5_000,
    });
    const health = await h.health('ghost');
    expect(health.ok).toBe(false);
    expect(health.kind).toBe('TOOL_UNAVAILABLE');
  });
});
