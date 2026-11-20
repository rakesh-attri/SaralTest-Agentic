import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { projectPaths } from '../config/loader.js';
import { nullLogger } from '../core/logger.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { McpHub } from '../mcp/client.js';
import { McpToolsConfig } from '../config/schemas.js';
import { Redactor } from '../security/redact.js';
import type { ExecResult, Runner } from '../util/exec.js';
import { createFakeServer } from '../../tests/fixtures/mcp-fake-server.mjs';
import { makeTempProject } from '../../tests/helpers/tempProject.js';
import { exitCodeFor, formatReport, runDoctor, type DoctorReport } from './runDoctor.js';
import type { DoctorDeps, DoctorOptions } from './types.js';

const GOOGLE_KEY = 'fake-google-key-1234567890';
const ONLINE: DoctorOptions = { live: false, offline: false, includeOAuth: false, ci: false };

const okRun: Runner = (cmd, args) => {
  const key = `${cmd} ${args.join(' ')}`;
  const table: Record<string, ExecResult> = {
    'pnpm --version': { code: 0, stdout: '12.0.0\n', stderr: '' },
    'uv --version': { code: 0, stdout: 'uv 0.13.7\n', stderr: '' },
    'uv python find 3.12': { code: 0, stdout: 'C:\\Python312\\python.exe\n', stderr: '' },
    'sf --version': { code: 0, stdout: '@salesforce/cli/2.159.7\n', stderr: '' },
    'sf org list --json': { code: 0, stdout: JSON.stringify({ result: { nonScratchOrgs: [] } }), stderr: '' },
  };
  return Promise.resolve(table[key] ?? { code: 1, stdout: '', stderr: `unexpected ${key}` });
};

/** fetch that serves Google list-models and passes localhost (fixture) through; anything else is refused. */
function fakeFetch(models: string[]): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === '127.0.0.1') return fetch(input, init);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const headers = new Headers(init?.headers);
      if (headers.get('x-goog-api-key') !== GOOGLE_KEY) return new Response('{}', { status: 403 });
      if (url.searchParams.has('key')) throw new Error('API key must never be in the URL');
      return Response.json({
        models: models.map((id) => ({
          name: `models/${id}`,
          supportedGenerationMethods: id.includes('embedding') ? ['embedContent'] : ['generateContent'],
        })),
      });
    }
    if (url.hostname.endsWith('langfuse.com')) return new Response('{}', { status: 200 });
    throw new Error(`unexpected network call in unit test: ${url.host}`);
  };
}

function deps(over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    run: okRun,
    fetch: fakeFetch(['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-embedding-2']),
    probeBrowser: () => Promise.resolve(undefined),
    ...over,
  };
}

const byId = (r: DoctorReport, id: string) => r.results.find((x) => x.id === id);

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});
const project = (opts: Parameters<typeof makeTempProject>[0] = {}): string => {
  const r = makeTempProject({
    env: {
      GOOGLE_API_KEY: GOOGLE_KEY,
      LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
      LANGFUSE_SECRET_KEY: 'sk-lf-test',
      LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
    },
    ...opts,
  });
  roots.push(r);
  return r;
};

describe('qa doctor', () => {
  it('fresh project: placeholders are WARN with real-model suggestions, nothing FAILs', async () => {
    const root = project();
    const report = await runDoctor({ paths: projectPaths(root), options: ONLINE, logger: nullLogger(), deps: deps() });
    expect(report.counts.red, formatReport(report)).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
    const models = byId(report, 'models');
    expect(models?.status).toBe('yellow');
    expect(models?.details?.join('\n')).toMatch(
      /Suggested from models listed for your key .*reasoning=gemini-2\.5-pro.*coder=gemini-3\.8-flash/,
    );
    expect(byId(report, 'fixture')?.status).toBe('green');
    expect(byId(report, 'skills')?.status).toBe('green');
    expect(byId(report, 'salesforce')?.summary).toMatch(/expected until Phase 2/);
    expect(report.savedTo && existsSync(report.savedTo)).toBe(true);
    expect(report.savedTo?.startsWith(join(root, 'runs'))).toBe(true);
  });

  it('a configured model id the key cannot use is a FAIL (exit 1)', async () => {
    const root = project();
    const file = join(root, 'config', 'models.yaml');
    const doc = parse(readFileSync(file, 'utf8')) as {
      roles: Record<string, { model: string; fallback?: unknown }>;
      embeddings: { model: string };
    };
    doc.roles['reasoning']!.model = 'gemini-2.5-pro';
    delete doc.roles['reasoning']!.fallback;
    doc.roles['coder']!.model = 'gemini-3.8-flash';
    doc.roles['fast']!.model = 'gemini-does-not-exist';
    doc.roles['judge']!.model = 'gemini-2.5-pro';
    doc.embeddings.model = 'gemini-embedding-2';
    writeFileSync(file, stringify(doc));
    const report = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      deps: deps(),
      only: ['models'],
    });
    expect(byId(report, 'models')?.status).toBe('red');
    expect(byId(report, 'models')?.details?.join('\n')).toMatch(
      /fast: google\/gemini-does-not-exist → model id not available/,
    );
    expect(exitCodeFor(report)).toBe(1);
  });

  it('browsers: fallback works → WARN; nothing works → FAIL', async () => {
    const root = project();
    const warn = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      only: ['browsers'],
      deps: deps({ probeBrowser: (b) => Promise.resolve(b === 'msedge' ? undefined : 'not installed') }),
    });
    expect(byId(warn, 'browsers')?.status).toBe('yellow');
    const fail = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      only: ['browsers'],
      deps: deps({ probeBrowser: () => Promise.resolve('not installed') }),
    });
    expect(byId(fail, 'browsers')?.status).toBe('red');
    expect(byId(fail, 'browsers')?.fix).toBe('pnpm exec playwright install chromium');
  });

  it('MCP: unclassified tools → WARN; OAuth servers skipped and deprecated v1 endpoint flagged', async () => {
    const root = project({
      mcp: {
        mcpServers: {
          fake: { command: 'unused', args: [] },
          'atlassian-rovo': { command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/mcp'] },
        },
      },
    });
    const allow = new ToolAllowList(
      McpToolsConfig.parse({
        fake: { observe: ['get_record', 'failing_tool'], mutate: ['create_record'], blocked: ['deploy_metadata'] },
      }),
    );
    const report = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      only: ['mcp'],
      deps: deps({
        mcpHub: (servers) =>
          new McpHub({
            servers,
            allowList: allow,
            redactor: new Redactor(),
            transportFactory: () => {
              const { server } = createFakeServer();
              const [c, s] = InMemoryTransport.createLinkedPair();
              void server.connect(s);
              return c;
            },
          }),
      }),
    });
    const fake = byId(report, 'mcp:fake');
    expect(fake?.status).toBe('yellow');
    // The doctor builds its own allow-list from config, so all fake tools are unclassified there:
    expect(fake?.details?.join('\n')).toMatch(/unclassified \(refused until classified\)/);
    const rovo = byId(report, 'mcp:atlassian-rovo');
    expect(rovo?.status).toBe('yellow');
    expect(rovo?.details?.join('\n')).toMatch(/deprecated/);
    expect(rovo?.fix).toMatch(/v2\/mcp/);
  });

  it('a crashing check becomes a FAIL row; the doctor itself never throws', async () => {
    const root = project();
    const report = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      only: ['pnpm', 'node'],
      deps: deps({ run: () => Promise.reject(new Error('spawn exploded')) }),
    });
    expect(byId(report, 'pnpm')).toMatchObject({ status: 'red', summary: 'check failed: spawn exploded' });
    expect(byId(report, 'node')?.status).toBe('green');
  });

  it('never prints secret values, even inside error text', async () => {
    const root = project();
    const report = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      only: ['pnpm'],
      deps: deps({ run: () => Promise.resolve({ code: 1, stdout: '', stderr: `boom ${GOOGLE_KEY}` }) }),
    });
    const text = JSON.stringify(report) + formatReport(report);
    expect(text).not.toContain(GOOGLE_KEY);
    expect(text).toContain('[REDACTED]');
  });

  it('--offline skips network probes with an explanation', async () => {
    const root = project();
    const report = await runDoctor({
      paths: projectPaths(root),
      options: { ...ONLINE, offline: true },
      logger: nullLogger(),
      only: ['jira', 'tracing', 'models'],
      deps: deps({ fetch: () => Promise.reject(new Error('network used in offline mode')) }),
    });
    expect(report.counts.red).toBe(0);
    expect(byId(report, 'tracing')?.details?.join('\n')).toMatch(/skipped \(--offline\)/);
  });

  it('report text is plain ASCII tags with a summary line', async () => {
    const root = project();
    const report = await runDoctor({
      paths: projectPaths(root),
      options: ONLINE,
      logger: nullLogger(),
      deps: deps(),
      only: ['node'],
    });
    const text = formatReport(report);
    expect(text).toMatch(/^\[ OK \] Node\.js/m);
    expect(text).toMatch(/Summary: 1 OK, 0 WARN, 0 FAIL/);
  });
});
