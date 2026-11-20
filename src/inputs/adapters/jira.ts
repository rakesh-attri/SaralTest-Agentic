import { z } from 'zod';
import { classifyError } from '../../core/classifyError.js';
import { QAError } from '../../core/errors.js';
import type { DefectRecord, SourceDocument } from '../../core/schemas/index.js';
import { normalizeText, sha256 } from '../sections.js';
import type { AdapterContext } from '../types.js';
import { textDocument } from './text.js';

/**
 * JIRA input (PLAN.md §7a): Atlassian Rovo MCP first, JIRA REST (API token from env / Credential Manager) as the
 * fallback (PLAN.md §5 TOOL_UNAVAILABLE chain). Read-only: only `observe` tools / GET requests.
 */

// ------------------------------------------------------------------ ADF → text
type Adf = {
  type?: string;
  text?: string;
  content?: Adf[];
  attrs?: Record<string, unknown>;
  marks?: { type: string }[];
};

/** Atlassian Document Format → markdown-ish text that sectionize() understands (bold labels, headings, lists). */
export function adfToText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as Adf;
  const kids = (sep = ''): string => (n.content ?? []).map(adfToText).join(sep);
  switch (n.type) {
    case 'doc':
      return kids('\n\n');
    case 'text': {
      const t = n.text ?? '';
      return n.marks?.some((m) => m.type === 'strong') && t.trim() ? `**${t}**` : t;
    }
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return kids();
    case 'heading': {
      const level = typeof n.attrs?.['level'] === 'number' ? n.attrs['level'] : 2;
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${kids()}`;
    }
    case 'bulletList':
      return (n.content ?? []).map((li) => `- ${adfToText(li).trim()}`).join('\n');
    case 'orderedList':
      return (n.content ?? []).map((li, i) => `${i + 1}. ${adfToText(li).trim()}`).join('\n');
    case 'listItem':
      return kids('\n');
    case 'codeBlock':
    case 'blockquote':
    case 'panel':
      return kids('\n');
    case 'table':
      return kids('\n');
    case 'tableRow':
      return (n.content ?? []).map((c) => adfToText(c).trim()).join(' | ');
    case 'tableHeader':
    case 'tableCell':
      return kids(' ');
    case 'mention':
      return '@user';
    case 'inlineCard':
    case 'blockCard': {
      const url = n.attrs?.['url'];
      return typeof url === 'string' ? url : '';
    }
    default:
      return kids();
  }
}

/** Description / comment / custom field value: ADF object, plain string, or null. */
const fieldText = (v: unknown): string => (typeof v === 'string' ? v : v ? adfToText(v) : '');

// ------------------------------------------------------------------ issue shape (Zod at the boundary)
const Named = z.looseObject({ name: z.string() });
export const JiraIssue = z.looseObject({
  key: z.string(),
  id: z.string().optional(),
  fields: z.looseObject({
    summary: z.string(),
    description: z.unknown().optional(),
    issuetype: Named.optional(),
    status: Named.optional(),
    priority: Named.nullish(),
    labels: z.array(z.string()).optional(),
    components: z.array(Named).optional(),
    fixVersions: z.array(Named).optional(),
    updated: z.string().optional(),
    created: z.string().optional(),
    resolutiondate: z.string().nullish(),
    issuelinks: z
      .array(
        z.looseObject({
          type: z.looseObject({ outward: z.string().optional(), inward: z.string().optional() }).optional(),
          outwardIssue: z.looseObject({ key: z.string() }).optional(),
          inwardIssue: z.looseObject({ key: z.string() }).optional(),
        }),
      )
      .optional(),
    comment: z
      .looseObject({ comments: z.array(z.looseObject({ body: z.unknown(), created: z.string().optional() })) })
      .optional(),
  }),
  /** `expand=names`: field id → display name (finds an "Acceptance Criteria" custom field). */
  names: z.record(z.string(), z.string()).optional(),
});
export type JiraIssue = z.infer<typeof JiraIssue>;

const SearchResult = z.looseObject({ issues: z.array(JiraIssue) });

export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-\d{1,7}$/;

// ------------------------------------------------------------------ client
export class JiraClient {
  private cloudId: string | undefined;

  constructor(private readonly ctx: AdapterContext) {}

  private get base(): string | undefined {
    return this.ctx.env.JIRA_BASE_URL?.replace(/\/+$/, '');
  }

  /** Rovo MCP needs the site's cloudId (observe tool `getAccessibleAtlassianResources`). */
  private async mcpCloudId(): Promise<string> {
    if (this.cloudId) return this.cloudId;
    const hub = this.ctx.mcp;
    if (!hub || !this.ctx.callCtx) throw new QAError('TOOL_UNAVAILABLE', 'Atlassian MCP not connected');
    const res = await hub.callTool('atlassian-rovo', 'getAccessibleAtlassianResources', {}, this.ctx.callCtx);
    const sites = z
      .array(z.looseObject({ id: z.string(), url: z.string().optional() }))
      .safeParse(JSON.parse(res.text));
    if (!sites.success || sites.data.length === 0) {
      throw new QAError('TOOL_UNAVAILABLE', 'Atlassian MCP returned no accessible sites');
    }
    const host = this.base ? new URL(this.base).host : undefined;
    const site = sites.data.find((s) => host && s.url?.includes(host)) ?? sites.data[0];
    this.cloudId = site?.id;
    if (!this.cloudId) throw new QAError('TOOL_UNAVAILABLE', 'Atlassian MCP site has no cloudId');
    return this.cloudId;
  }

  private async rest(path: string): Promise<unknown> {
    const { JIRA_EMAIL: email, JIRA_API_TOKEN: token } = this.ctx.env;
    if (!this.base || !email || !token) {
      throw new QAError(
        'TOOL_UNAVAILABLE',
        'JIRA REST fallback not configured (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)',
      );
    }
    const f = this.ctx.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.base}${path}`, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const c = classifyError(err);
      throw new QAError(c.kind === 'UNKNOWN' ? 'TRANSIENT' : c.kind, `JIRA REST request failed: ${c.message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new QAError(
        'AUTH',
        `JIRA REST returned ${res.status}: check JIRA_EMAIL / JIRA_API_TOKEN and project access`,
        {
          status: res.status,
        },
      );
    }
    if (res.status === 404)
      throw new QAError('DATA', `JIRA REST 404 for ${path.split('?')[0] ?? path}`, { status: 404 });
    if (res.status === 429 || res.status >= 500) {
      throw new QAError('TRANSIENT', `JIRA REST returned ${res.status}`, { status: res.status });
    }
    if (!res.ok) throw new QAError('UNKNOWN', `JIRA REST returned ${res.status}`, { status: res.status });
    return res.json();
  }

  /** Try MCP; on TOOL_UNAVAILABLE / TRANSIENT / unexpected shape use REST. AUTH and DATA from REST are real errors. */
  private async chain<T>(
    viaMcp: () => Promise<T>,
    viaRest: () => Promise<T>,
  ): Promise<{ value: T; via: string; notes: string[] }> {
    const notes: string[] = [];
    if (this.ctx.mcp && this.ctx.callCtx) {
      try {
        return { value: await viaMcp(), via: 'mcp', notes };
      } catch (err) {
        const c = classifyError(err);
        if (c.kind === 'HARD_STOP') throw err;
        notes.push(`Atlassian MCP unavailable (${c.kind}: ${c.message.slice(0, 160)}); used JIRA REST fallback`);
        this.ctx.logger?.warn({ kind: c.kind }, 'Atlassian MCP failed; falling back to JIRA REST');
      }
    } else {
      notes.push('Atlassian MCP not connected; used JIRA REST');
    }
    return { value: await viaRest(), via: 'rest', notes };
  }

  async getIssue(key: string): Promise<{ issue: JiraIssue; via: string; notes: string[] }> {
    if (!ISSUE_KEY.test(key)) throw new QAError('DATA', `"${key}" is not a JIRA issue key (e.g. SF-123)`);
    const r = await this.chain(
      async () => {
        const cloudId = await this.mcpCloudId();
        const res = await this.ctx.mcp?.callTool(
          'atlassian-rovo',
          'getJiraIssue',
          { cloudId, issueIdOrKey: key, expand: 'names' },
          this.ctx.callCtx ?? { runId: '-', orgId: '-', user: '-', persona: '-' },
        );
        const parsed = JiraIssue.safeParse(JSON.parse(res?.text ?? 'null'));
        if (!parsed.success) throw new QAError('TOOL_UNAVAILABLE', 'unexpected getJiraIssue result shape');
        return parsed.data;
      },
      async () => {
        const parsed = JiraIssue.safeParse(
          await this.rest(`/rest/api/3/issue/${encodeURIComponent(key)}?expand=names`),
        );
        if (!parsed.success) throw new QAError('UNKNOWN', `unexpected JIRA REST issue shape for ${key}`);
        return parsed.data;
      },
    );
    return { issue: r.value, via: r.via, notes: r.notes };
  }

  async search(jql: string, max = 50): Promise<{ issues: JiraIssue[]; via: string; notes: string[] }> {
    const fields = 'summary,status,priority,components,labels,created,resolutiondate,issuetype,description';
    const r = await this.chain(
      async () => {
        const cloudId = await this.mcpCloudId();
        const res = await this.ctx.mcp?.callTool(
          'atlassian-rovo',
          'searchJiraIssuesUsingJql',
          { cloudId, jql, maxResults: max, fields: fields.split(',') },
          this.ctx.callCtx ?? { runId: '-', orgId: '-', user: '-', persona: '-' },
        );
        const parsed = SearchResult.safeParse(JSON.parse(res?.text ?? 'null'));
        if (!parsed.success) throw new QAError('TOOL_UNAVAILABLE', 'unexpected searchJiraIssuesUsingJql result shape');
        return parsed.data.issues;
      },
      async () => {
        const q = new URLSearchParams({ jql, maxResults: String(max), fields });
        const parsed = SearchResult.safeParse(await this.rest(`/rest/api/3/search/jql?${q.toString()}`));
        if (!parsed.success) throw new QAError('UNKNOWN', 'unexpected JIRA REST search shape');
        return parsed.data.issues;
      },
    );
    return { issues: r.value, via: r.via, notes: r.notes };
  }
}

// ------------------------------------------------------------------ issue → SourceDocument
export function jiraIssueToDocument(issue: JiraIssue, base?: string): SourceDocument {
  const f = issue.fields;
  const acFieldId = Object.entries(issue.names ?? {}).find(([, name]) => /acceptance\s*criteria/i.test(name))?.[0];
  const acField = acFieldId ? fieldText(f[acFieldId]) : '';
  const comments = (f.comment?.comments ?? [])
    .map((c, i) => `CM-${i + 1}: (comment${c.created ? ` ${c.created.slice(0, 10)}` : ''}) ${fieldText(c.body).trim()}`)
    .filter((c) => c.length > 20);
  const text = normalizeText(
    [
      `**Summary:** ${f.summary}`,
      fieldText(f.description),
      acField ? `**Acceptance criteria**\n\n${acField}` : '',
      comments.length ? `## Comments\n\n${comments.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  const links = (f.issuelinks ?? []).flatMap((l) => {
    if (l.outwardIssue) return [`${l.type?.outward ?? 'relates to'} ${l.outwardIssue.key}`];
    if (l.inwardIssue) return [`${l.type?.inward ?? 'relates to'} ${l.inwardIssue.key}`];
    return [];
  });
  return textDocument({
    text,
    sourceType: 'jira',
    ref: base ? `${base}/browse/${issue.key}` : issue.key,
    docId: issue.key,
    title: f.summary,
    ...(f.updated ? { version: f.updated } : {}),
    meta: {
      key: issue.key,
      issueType: f.issuetype?.name,
      status: f.status?.name,
      priority: f.priority?.name,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name),
      fixVersions: (f.fixVersions ?? []).map((v) => v.name),
      links,
      acceptanceCriteriaField: acFieldId ?? null,
    },
  });
}

export function jiraIssueToDefect(issue: JiraIssue, base?: string): DefectRecord {
  const f = issue.fields;
  const description = fieldText(f.description).slice(0, 2000);
  return {
    key: issue.key,
    summary: f.summary,
    ...(f.status?.name ? { status: f.status.name } : {}),
    ...(f.priority?.name ? { priority: f.priority.name } : {}),
    components: (f.components ?? []).map((c) => c.name),
    labels: f.labels ?? [],
    ...(f.created ? { created: f.created } : {}),
    ...(f.resolutiondate ? { resolved: f.resolutiondate } : {}),
    ...(description ? { description } : {}),
    source: {
      type: 'defect',
      ref: base ? `${base}/browse/${issue.key}` : issue.key,
      hash: sha256(JSON.stringify(issue.fields)),
    },
  };
}
