import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QAError } from '../core/errors.js';
import type { Approval } from '../core/schemas/data.js';
import type { JiraCommentDraft } from '../core/schemas/execution.js';
import { decide } from '../security/orgPolicy.js';
import { AuditLog } from '../security/audit.js';
import { Redactor } from '../security/redact.js';
import {
  commentSubject,
  COMMENT_TOOL,
  publicationGuard,
  publishJiraComment,
  sha256,
  toAdf,
  type McpCaller,
} from './jiraComment.js';

const reasonOf = (d: { allowed: boolean; reason?: string }): string => (d.allowed ? '' : (d.reason ?? ''));
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'qa jira '));
  roots.push(d);
  return d;
};

const TEXT = '**SF QA automated run r1** — LIVE\n\n- Executed 7: 7 passed\n- Test data: cleanup CLEAN.';
const draft: JiraCommentDraft = {
  storyKey: 'SF-219',
  runId: 'r1',
  text: TEXT,
  sha256: sha256(TEXT),
  createdAt: '2026-11-26T10:00:00.000Z',
};
const approval: Approval = {
  id: 'AP-0123456789ab',
  checkpoint: 'publish-run-comment',
  subject: commentSubject('SF-219', sha256(TEXT)),
  orgId: '00DdN00000uQ5dKUAS',
  approvedBy: 'QA operator',
  approvedAt: '2026-11-26T10:01:00.000Z',
};
const ctx = { runId: 'r1', orgId: '00DdN00000uQ5dKUAS', user: 'sf-qa-agent', persona: 'reporter' };
const env = { JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_EMAIL: 'qa@example.invalid', JIRA_API_TOKEN: 'tok' };

function setup() {
  const dir = tmp();
  const audit = new AuditLog(join(dir, 'audit.jsonl'), new Redactor());
  const lines = (): { tool: string; outcome: string }[] =>
    readFileSync(join(dir, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { tool: string; outcome: string });
  return { dir, audit, lines, ledgerFile: join(dir, 'publications.jsonl') };
}

describe('JIRA run comment publication', () => {
  it('refuses without an approval of this exact text (nothing sent)', async () => {
    const s = setup();
    let calls = 0;
    const mcp: McpCaller = { callTool: () => (calls++, Promise.resolve({ text: '', class: 'mutate' as const })) };
    await expect(
      publishJiraComment({ draft, approval: undefined, mcp, env, audit: s.audit, ctx, ledgerFile: s.ledgerFile }),
    ).rejects.toThrow(/not approved/);
    const other = { ...approval, subject: commentSubject('SF-219', 'f'.repeat(64)) };
    await expect(
      publishJiraComment({ draft, approval: other, mcp, env, audit: s.audit, ctx, ledgerFile: s.ledgerFile }),
    ).rejects.toBeInstanceOf(QAError);
    expect(calls).toBe(0);
  });

  it('the MCP guard allows only add mode, the approved story and the approved body', async () => {
    const g = publicationGuard({ storyKey: 'SF-219', approval, text: TEXT });
    const req = (args: Record<string, unknown>, tool = COMMENT_TOOL) =>
      g({ server: 'atlassian-rovo', tool, args, ctx });
    expect((await req({ issueIdOrKey: 'SF-219', commentBody: TEXT })).allowed).toBe(true);
    expect(reasonOf(await req({ issueIdOrKey: 'SF-219', commentBody: TEXT, commentId: '1' }))).toMatch(/add mode only/);
    expect((await req({ issueIdOrKey: 'SF-1', commentBody: TEXT })).allowed).toBe(false);
    expect((await req({ issueIdOrKey: 'SF-219', commentBody: `${TEXT} edited` })).allowed).toBe(false);
    expect((await req({ issueIdOrKey: 'SF-219', commentBody: TEXT }, 'createJiraIssue')).allowed).toBe(false);
    const none = publicationGuard({ storyKey: 'SF-219', approval: undefined, text: TEXT });
    expect(
      (
        await none({
          server: 'atlassian-rovo',
          tool: COMMENT_TOOL,
          args: { issueIdOrKey: 'SF-219', commentBody: TEXT },
          ctx,
        })
      ).allowed,
    ).toBe(false);
  });

  it('MCP first; the same text is never posted twice', async () => {
    const s = setup();
    const sent: Record<string, unknown>[] = [];
    const mcp: McpCaller = {
      callTool: (_s, tool, args) => {
        sent.push({ tool, ...args });
        return Promise.resolve({ text: '{"commentId":"10042"}', class: 'mutate' as const });
      },
    };
    const r = await publishJiraComment({ draft, approval, mcp, env, audit: s.audit, ctx, ledgerFile: s.ledgerFile });
    expect(r).toEqual({ via: 'mcp', commentId: '10042' });
    expect(sent[0]).toMatchObject({
      tool: COMMENT_TOOL,
      issueIdOrKey: 'SF-219',
      commentBody: TEXT,
      cloudId: 'example.atlassian.net',
    });
    expect(sent[0]).not.toHaveProperty('commentId');
    await expect(
      publishJiraComment({ draft, approval, mcp, env, audit: s.audit, ctx, ledgerFile: s.ledgerFile }),
    ).rejects.toThrow(/already posted/);
  });

  it('MCP unavailable → JIRA REST with ADF, audited write-ahead (ALLOWED → SUCCEEDED)', async () => {
    const s = setup();
    const mcp: McpCaller = {
      callTool: () => Promise.reject(new QAError('TOOL_UNAVAILABLE', 'MCP atlassian-rovo: connect failed')),
    };
    let body: unknown;
    const fetchFn = ((_url: string, init?: RequestInit) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      return Promise.resolve(new Response(JSON.stringify({ id: '10077' }), { status: 201 }));
    }) as typeof fetch;
    const r = await publishJiraComment({
      draft,
      approval,
      mcp,
      env,
      audit: s.audit,
      ctx,
      ledgerFile: s.ledgerFile,
      fetch: fetchFn,
    });
    expect(r).toMatchObject({ via: 'rest', commentId: '10077' });
    expect(r.mcpError).toMatch(/TOOL_UNAVAILABLE/);
    expect(JSON.stringify(body)).toContain('bulletList');
    expect(s.lines().map((l) => `${l.tool}:${l.outcome}`)).toEqual([
      'jira-rest.addComment:ALLOWED',
      'jira-rest.addComment:SUCCEEDED',
    ]);
  });

  it('a guard refusal on the MCP path is final (no REST fallback around a refusal)', async () => {
    const s = setup();
    const mcp: McpCaller = {
      callTool: () => Promise.reject(new QAError('TOOL_UNAVAILABLE', 'mutation atlassian-rovo.x refused: nope')),
    };
    await expect(
      publishJiraComment({ draft, approval, mcp, env, audit: s.audit, ctx, ledgerFile: s.ledgerFile }),
    ).rejects.toThrow(/refused/);
  });

  it('ADF keeps paragraphs and bullet lists; the org-profile guard never publishes', () => {
    const adf = toAdf('Title **bold**\n\n- one\n- two\nend') as { content: { type: string }[] };
    expect(adf.content.map((c) => c.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
    const d = decide(
      {
        orgs: {
          orgs: [
            {
              orgId: '00DdN00000uQ5dKUAS',
              alias: 'qa-prod',
              profile: 'dedicated-qa-prod',
              instanceUrl: 'https://x.my.salesforce.com',
              release: 'r',
              runTagField: null,
              environment: 'LIVE',
            },
          ],
          profiles: { 'dedicated-qa-prod': { mutations: 'all-record-data' } },
        },
        verifiedOrgIds: () => new Set(['00DdN00000uQ5dKUAS']),
      },
      { server: 'atlassian-rovo', tool: COMMENT_TOOL, args: {}, ctx },
    );
    expect(d.allowed).toBe(false);
    expect(reasonOf(d)).toMatch(/publishes outside Salesforce/);
  });
});
