// JIRA run comment (Phase 5, reporting skill "JIRA comment"): a short, code-rendered summary of an execution run,
// posted to the story only after a human approved that exact text (checkpoint `publish-run-comment`, approval bound to
// the text's sha256). Rovo MCP first (`addOrEditJiraIssueComment` in add mode — never with a commentId), JIRA REST as
// the fallback. Both paths are audited write-ahead (ALLOWED → SUCCEEDED / FAILED). The text holds no record ids, names,
// emails, error payloads or logs; the redactor must leave it unchanged or publication is refused.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QAError } from '../core/errors.js';
import { JiraCommentDraft } from '../core/schemas/execution.js';
import type { Approval } from '../core/schemas/data.js';
import { classifyError } from '../core/classifyError.js';
import type { CallContext, MutationGuard } from '../mcp/client.js';
import type { AuditLog } from '../security/audit.js';
import type { Redactor } from '../security/redact.js';
import { environmentLabel } from './format.js';
import { releaseConfidence, type ReportData } from './execution.js';

export const PUBLISH_CHECKPOINT = 'publish-run-comment';
export const COMMENT_TOOL = 'addOrEditJiraIssueComment';
export const commentSubject = (storyKey: string, sha256: string): string => `jira-comment:${storyKey}@${sha256}`;

/** What the failure showed, in plain words, without record data (observation only — no cause is claimed). */
const failureKind = (reason: string, error: string): string =>
  /toHaveURL/.test(error) && /lightning\/r\/Account\//.test(error) && /Contact/.test(error)
    ? 'after Save the page stayed on the Account record; the test expects the new Contact record page'
    : /timed out/i.test(reason)
      ? 'timed out'
      : /^failed: .*expect/i.test(reason)
        ? 'assertion failed'
        : 'failed';

/** The comment text (markdown, as Rovo MCP takes it). Deterministic: same run → same text → same sha256. */
export function renderJiraComment(d: ReportData): string {
  const s = d.summary;
  const rc = releaseConfidence(d);
  const ran = d.results.filter((r) => d.gate.some((g) => g.decision === 'EXECUTE' && g.caseId === r.caseId));
  const title = (id: string): string => d.design?.cases.find((c) => c.id === id)?.title ?? '';
  const count = (k: string): number => d.gate.filter((g) => g.decision === k).length;
  const notApproved = (status: string): number =>
    d.gate.filter((g) => g.decision === 'NOT_APPROVED' && g.reason === `review status ${status}`).length;
  // Specs blocked at review with an org-setup cause (e.g. the persona cannot see the object): said plainly.
  const orgBlocked = (d.manifest?.artifacts ?? []).filter(
    (a) => a.reviewStatus === 'BLOCKED' && a.reviewReasons.some((r) => /sObject type '\w+' is not supported/.test(r)),
  );
  const L: string[] = [];
  L.push(
    `**SF QA automated run ${d.runId}** — ${environmentLabel(s.environment)} · org ${s.orgAlias} · ${s.browser} · ${s.finishedAt.slice(0, 10)}`,
  );
  if (s.environment !== 'LIVE')
    L.push('', `_${s.environment} results are not Salesforce results and say nothing about the org._`);
  L.push('', `**Verdict: ${rc.verdict}** — ${rc.why}`, '');
  const x = s.executed;
  L.push(
    `- Executed ${String(ran.length)}: ${String(x.PASS)} passed, ${String(x.FAIL)} failed, ${String(x.UNCERTAIN)} uncertain, ${String(x.BLOCKED)} blocked (flaky ${String(s.flaky)}).`,
    `- Not executed: ${String(notApproved('REVIEW_REQUIRED'))} awaiting review, ${String(notApproved('BLOCKED'))} blocked at review, ${String(count('BLOCKED'))} stale, ${String(count('MANUAL'))} manual-only.`,
    `- Acceptance criteria with a passing executed test: ${String(rc.acCoverage.executedPassed)}/${String(rc.acCoverage.total)}.`,
    `- Test data: cleanup ${s.cleanup}${d.reconcile ? ` (${String(d.reconcile.subRuns.length)} test data sets, ${String(d.reconcile.remaining.length)} records remaining)` : ''}.`,
  );
  const fails = ran.filter((r) => r.state === 'FAIL' || r.state === 'UNCERTAIN');
  if (fails.length) {
    L.push('', '**Failures (not investigated yet):**');
    for (const f of fails)
      L.push(
        `- ${f.caseId ?? ''} ${title(f.caseId ?? '')} — ${f.state === 'FAIL' ? failureKind(f.reason ?? '', f.errorSummary ?? '') : 'uncertain'}`,
      );
  }
  if (orgBlocked.length) {
    const persona = (id: string): string => d.design?.cases.find((c) => c.id === id)?.persona ?? '?';
    const ids = orgBlocked.map((a) => a.testCaseIds[0] ?? '');
    const objects = [
      ...new Set(
        orgBlocked.flatMap((a) => a.reviewReasons.map((r) => /sObject type '(\w+)'/.exec(r)?.[1]).filter(Boolean)),
      ),
    ];
    L.push(
      '',
      `**Blocked by org setup:** the ${[...new Set(ids.map(persona))].join(', ')} test user has no access to ${objects.join(', ')} on ${s.orgAlias}, so ${ids.join(', ')} cannot run (needs a permission set from the Salesforce admin).`,
    );
  }
  const passed = ran.filter((r) => r.state === 'PASS').map((r) => r.caseId ?? '');
  if (passed.length) L.push('', `**Passed:** ${passed.join(', ')}`);
  const assumed = d.clarifications.filter((c) => c.status === 'ASSUMED');
  L.push(
    '',
    assumed.length ? `**Needs confirmation:** ${assumed.map((c) => c.id).join(', ')}` : '**Open assumptions:** none.',
  );
  L.push(
    '',
    `Reports are on the QA machine: runs/${d.runId}/report/index.md (execution report, release confidence, RTM with results), Playwright HTML and reporting-labs.`,
  );
  L.push('', `_Posted by sf-qa-agent after operator approval · qa-run ${d.runId}_`);
  return L.join('\n');
}

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function draftJiraComment(d: ReportData, redactor?: Redactor): JiraCommentDraft {
  const text = renderJiraComment(d);
  if (redactor && redactor.redactText(text) !== text) {
    throw new QAError('HARD_STOP', 'the JIRA comment draft contains redactable data (secret / PII) — not drafted');
  }
  const draft = JiraCommentDraft.parse({
    storyKey: d.summary.storyKey,
    runId: d.runId,
    text,
    sha256: sha256(text),
    createdAt: new Date().toISOString(),
  });
  const dir = join(d.runDir, 'report');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'jira-comment.md'), `${text}\n`, 'utf8');
  writeFileSync(join(dir, 'jira-comment.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  return draft;
}

export function readDraft(runDir: string): JiraCommentDraft {
  const f = join(runDir, 'report', 'jira-comment.json');
  if (!existsSync(f))
    throw new QAError('DATA', `no JIRA comment draft in ${f}`, { fix: 'qa report comment draft --run <id>' });
  const draft = JiraCommentDraft.parse(JSON.parse(readFileSync(f, 'utf8')));
  if (sha256(draft.text) !== draft.sha256)
    throw new QAError('HARD_STOP', 'the JIRA comment draft was changed after drafting');
  return draft;
}

/**
 * MCP mutation guard for the comment: only the comment tool, add mode (no commentId), the approved story, and an
 * approval recorded for this exact text. Everything else is refused.
 */
export function publicationGuard(o: { storyKey: string; approval: Approval | undefined; text: string }): MutationGuard {
  return ({ server, tool, args }) => {
    const deny = (reason: string) => Promise.resolve({ allowed: false as const, reason });
    if (server !== 'atlassian-rovo' || tool !== COMMENT_TOOL)
      return deny(`${server}.${tool} is not the run-comment tool`);
    if ('commentId' in args) return deny('editing a comment is not allowed (add mode only)');
    if (args['issueIdOrKey'] !== o.storyKey)
      return deny(`comment target ${String(args['issueIdOrKey'])} ≠ ${o.storyKey}`);
    if (args['commentBody'] !== o.text) return deny('comment body differs from the approved text');
    if (!o.approval) return deny(`no ${PUBLISH_CHECKPOINT} approval for this text`);
    return Promise.resolve({ allowed: true as const, approvalId: o.approval.id });
  };
}

/** Minimal ADF for the REST fallback: paragraphs and bullet lists of plain text (markdown emphasis stripped). */
export function toAdf(text: string): Record<string, unknown> {
  const plain = (s: string): string => s.replace(/\*\*|_/g, '');
  const content: Record<string, unknown>[] = [];
  let list: Record<string, unknown>[] | undefined;
  for (const line of text.split('\n')) {
    if (/^- /.test(line)) {
      list ??= [];
      list.push({
        type: 'listItem',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: plain(line.slice(2)) }] }],
      });
      continue;
    }
    if (list) {
      content.push({ type: 'bulletList', content: list });
      list = undefined;
    }
    if (line.trim()) content.push({ type: 'paragraph', content: [{ type: 'text', text: plain(line) }] });
  }
  if (list) content.push({ type: 'bulletList', content: list });
  return { type: 'doc', version: 1, content };
}

export interface McpCaller {
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    ctx: CallContext,
  ): Promise<{ text: string; class: 'observe' | 'mutate' }>;
}

export interface PublishInput {
  draft: JiraCommentDraft;
  approval: Approval | undefined;
  /** MCP hub built with `publicationGuard` as its mutation guard (undefined → REST only). */
  mcp?: McpCaller;
  env: { JIRA_BASE_URL?: string | undefined; JIRA_EMAIL?: string | undefined; JIRA_API_TOKEN?: string | undefined };
  audit: AuditLog;
  ctx: CallContext;
  /** `.qa-memory/publications.jsonl`: one line per published text (idempotency). */
  ledgerFile: string;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

export interface PublishResult {
  via: 'mcp' | 'rest';
  commentId?: string;
  /** Reason the MCP path was not used (when REST posted it). */
  mcpError?: string;
}

const published = (file: string, sha: string): { via: string; commentId?: string } | undefined => {
  if (!existsSync(file)) return undefined;
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const p = JSON.parse(l) as { sha256: string; via: string; commentId?: string };
    if (p.sha256 === sha) return p;
  }
  return undefined;
};

export async function publishJiraComment(i: PublishInput): Promise<PublishResult> {
  const { draft } = i;
  const log = i.log ?? (() => undefined);
  if (sha256(draft.text) !== draft.sha256) throw new QAError('HARD_STOP', 'comment text does not match its sha256');
  if (!i.approval || i.approval.subject !== commentSubject(draft.storyKey, draft.sha256)) {
    throw new QAError(
      'DATA',
      `the JIRA comment for ${draft.runId} is not approved (checkpoint ${PUBLISH_CHECKPOINT})`,
      {
        fix: `pnpm qa report comment approve --run ${draft.runId} --by "<your name>"`,
      },
    );
  }
  const done = published(i.ledgerFile, draft.sha256);
  if (done)
    throw new QAError(
      'DATA',
      `this exact comment was already posted (${done.via}${done.commentId ? `, comment ${done.commentId}` : ''})`,
    );
  const record = (r: PublishResult): PublishResult => {
    mkdirSync(dirname(i.ledgerFile), { recursive: true });
    appendFileSync(
      i.ledgerFile,
      `${JSON.stringify({ at: new Date().toISOString(), storyKey: draft.storyKey, runId: draft.runId, sha256: draft.sha256, approvalId: i.approval?.id, ...r })}\n`,
    );
    return r;
  };
  const base = i.env.JIRA_BASE_URL?.replace(/\/+$/, '');
  let mcpError: string | undefined;
  if (i.mcp) {
    try {
      log(`Posting through Atlassian Rovo MCP (${COMMENT_TOOL}, add mode) …`);
      const args: Record<string, unknown> = {
        ...(base ? { cloudId: new URL(base).hostname } : {}),
        issueIdOrKey: draft.storyKey,
        commentBody: draft.text,
        contentFormat: 'markdown',
      };
      const r = await i.mcp.callTool('atlassian-rovo', COMMENT_TOOL, args, { ...i.ctx, approvalId: i.approval.id });
      const commentId = /"?commentId"?\s*[:=]\s*"?(\d+)/.exec(r.text)?.[1];
      return record({ via: 'mcp', ...(commentId ? { commentId } : {}) });
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'HARD_STOP' || /refused/.test(c.message)) throw err;
      mcpError = `${c.kind}: ${c.message}`;
      log(`MCP path failed (${mcpError}); falling back to JIRA REST.`);
    }
  }
  // REST fallback — same approval, same write-ahead audit.
  const { JIRA_EMAIL: email, JIRA_API_TOKEN: token } = i.env;
  if (!base || !email || !token) {
    throw new QAError(
      'TOOL_UNAVAILABLE',
      `JIRA REST not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)${mcpError ? `; MCP: ${mcpError}` : ''}`,
    );
  }
  const auditBase = {
    runId: i.ctx.runId,
    orgId: i.ctx.orgId,
    user: i.ctx.user,
    persona: i.ctx.persona,
    tool: 'jira-rest.addComment',
    action: 'mutate' as const,
    approvalId: i.approval.id,
  };
  i.audit.append({ ...auditBase, outcome: 'ALLOWED', before: { issue: draft.storyKey, sha256: draft.sha256 } });
  const res = await (i.fetch ?? fetch)(`${base}/rest/api/3/issue/${encodeURIComponent(draft.storyKey)}/comment`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body: toAdf(draft.text) }),
  });
  if (!res.ok) {
    i.audit.append({ ...auditBase, outcome: 'FAILED', after: { status: res.status } });
    throw new QAError(
      res.status === 401 || res.status === 403 ? 'AUTH' : res.status >= 500 ? 'TRANSIENT' : 'DATA',
      `JIRA REST comment failed: HTTP ${String(res.status)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  i.audit.append({ ...auditBase, outcome: 'SUCCEEDED', after: { commentId: body.id ?? null } });
  return record({ via: 'rest', ...(body.id ? { commentId: body.id } : {}), ...(mcpError ? { mcpError } : {}) });
}
