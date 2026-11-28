// Bug publication (defect-investigation SKILL: "Publication to JIRA/ADO only with an approved project, field mapping
// and publication policy"; checkpoint publish-defect waits for a human at L1/L2/L3). The approval binds to the sha256
// of the exact text the operator read. Posting goes through Atlassian Rovo MCP (createJiraIssue) when a hub is given,
// else JIRA REST; it is audited write-ahead and recorded in `.qa-memory/publications.jsonl` (never posted twice).
// FIXTURE / MOCK defects and SUSPECTED drafts are never published.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { PolicyConfig } from '../../config/schemas.js';
import { QAError } from '../../core/errors.js';
import type { Approval, DefectDraft } from '../../core/schemas/index.js';
import type { AuditLog } from '../../security/audit.js';
import { classifyError } from '../../core/classifyError.js';
import { toAdf, type McpCaller } from '../../report/jiraComment.js';
import type { CallContext } from '../../mcp/client.js';

export const PUBLISH_DEFECT_CHECKPOINT = 'publish-defect';
export const BUG_TOOL = 'createJiraIssue';
export const defectSubject = (id: string, sha: string): string => `defect:${id}@${sha}`;

/** policy.defectPublication when enabled: project key, issue type and field mapping (labels, components). */
export const DefectPublicationPolicy = z.object({
  enabled: z.literal(true, { error: 'defectPublication.enabled is false: bugs are drafted, never posted' }),
  project: z.string().regex(/^[A-Z][A-Z0-9]+$/, 'defectPublication.project must be a JIRA project key'),
  issueType: z.string().min(1).default('Bug'),
  fieldMapping: z.object({
    labels: z.array(z.string()).default(['sf-qa-agent']),
    /** Link the bug to the story (issue link type name, e.g. "Relates"). */
    linkType: z.string().optional(),
  }),
});
export type DefectPublicationPolicy = z.infer<typeof DefectPublicationPolicy>;

export interface PublishDefectInput {
  draft: DefectDraft;
  text: string;
  approval: Approval | undefined;
  policy: Pick<PolicyConfig, 'defectPublication'>;
  env: { JIRA_BASE_URL?: string | undefined; JIRA_EMAIL?: string | undefined; JIRA_API_TOKEN?: string | undefined };
  audit: AuditLog;
  ctx: CallContext;
  ledgerFile: string;
  mcp?: McpCaller;
  fetch?: typeof fetch;
  log?: (m: string) => void;
}

const already = (file: string, sha: string): { key?: string } | undefined => {
  if (!existsSync(file)) return undefined;
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const p = JSON.parse(l) as { sha256?: string; key?: string };
    if (p.sha256 === sha) return p;
  }
  return undefined;
};

/** Refusals before anything leaves the machine (each is a reason, never silently skipped). */
export function publicationRefusals(i: Pick<PublishDefectInput, 'draft' | 'approval' | 'policy'>): string[] {
  const out: string[] = [];
  const d = i.draft;
  if (d.environment !== 'LIVE') out.push(`${d.environment ?? '?'} defect: only LIVE defects are published`);
  if (d.status !== 'CONFIRMED') out.push(`status ${d.status ?? 'SUSPECTED'}: only CONFIRMED defects are published`);
  if (!d.sha256) out.push('draft has no sha256');
  if (!i.approval || !d.sha256 || i.approval.subject !== defectSubject(d.id, d.sha256))
    out.push(`no ${PUBLISH_DEFECT_CHECKPOINT} approval for this exact text`);
  const p = DefectPublicationPolicy.safeParse(i.policy.defectPublication);
  if (!p.success) out.push(`publication policy: ${p.error.issues.map((x) => x.message).join('; ')}`);
  return out;
}

export async function publishDefect(
  i: PublishDefectInput,
): Promise<{ key: string; via: 'mcp' | 'rest'; url?: string }> {
  const refusals = publicationRefusals(i);
  if (refusals.length) throw new QAError('DATA', `defect ${i.draft.id} not published: ${refusals.join('; ')}`);
  const policy = DefectPublicationPolicy.parse(i.policy.defectPublication);
  const sha = i.draft.sha256 ?? '';
  const done = already(i.ledgerFile, sha);
  if (done) throw new QAError('DATA', `this exact defect text was already posted${done.key ? ` (${done.key})` : ''}`);
  const record = (r: { key: string; via: 'mcp' | 'rest'; url?: string }): typeof r => {
    mkdirSync(dirname(i.ledgerFile), { recursive: true });
    appendFileSync(
      i.ledgerFile,
      `${JSON.stringify({ at: new Date().toISOString(), defect: i.draft.id, sha256: sha, approvalId: i.approval?.id, ...r })}\n`,
    );
    return r;
  };
  const base = i.env.JIRA_BASE_URL?.replace(/\/+$/, '');
  const summary = i.draft.title.slice(0, 250);
  const log = i.log ?? (() => undefined);
  let mcpError: string | undefined;
  if (i.mcp) {
    try {
      log(`Creating the bug through Atlassian Rovo MCP (${BUG_TOOL}) …`);
      const r = await i.mcp.callTool(
        'atlassian-rovo',
        BUG_TOOL,
        {
          ...(base ? { cloudId: new URL(base).hostname } : {}),
          projectKey: policy.project,
          issueTypeName: policy.issueType,
          summary,
          description: i.text,
          contentFormat: 'markdown',
        },
        { ...i.ctx, approvalId: i.approval?.id ?? '' },
      );
      const key = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(r.text)?.[1] ?? 'unknown';
      return record({ key, via: 'mcp', ...(base ? { url: `${base}/browse/${key}` } : {}) });
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'HARD_STOP' || /refused/.test(c.message)) throw err;
      mcpError = `${c.kind}: ${c.message}`;
      log(`MCP path failed (${mcpError}); falling back to JIRA REST.`);
    }
  }
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
    tool: 'jira-rest.createIssue',
    action: 'mutate' as const,
    ...(i.approval ? { approvalId: i.approval.id } : {}),
  };
  i.audit.append({
    ...auditBase,
    outcome: 'ALLOWED',
    before: { project: policy.project, defect: i.draft.id, sha256: sha },
  });
  const res = await (i.fetch ?? fetch)(`${base}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: policy.project },
        issuetype: { name: policy.issueType },
        summary,
        description: toAdf(i.text),
        labels: policy.fieldMapping.labels,
      },
    }),
  });
  if (!res.ok) {
    i.audit.append({ ...auditBase, outcome: 'FAILED', after: { status: res.status } });
    throw new QAError(
      res.status === 401 || res.status === 403 ? 'AUTH' : res.status >= 500 ? 'TRANSIENT' : 'DATA',
      `JIRA REST create issue failed: HTTP ${String(res.status)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { key?: string };
  const key = body.key ?? 'unknown';
  i.audit.append({ ...auditBase, outcome: 'SUCCEEDED', after: { key } });
  return record({ key, via: 'rest', url: `${base}/browse/${key}` });
}
