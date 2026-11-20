import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { classifyError } from '../../core/classifyError.js';
import { QAError } from '../../core/errors.js';
import {
  TestResult,
  type ChangedComponent,
  type DefectRecord,
  type ExploratoryObjective,
  type SourceDocument,
} from '../../core/schemas/index.js';
import { run } from '../../util/exec.js';
import { sha256 } from '../sections.js';
import type { AdapterContext } from '../types.js';
import { htmlToText } from './files.js';
import { textDocument } from './text.js';

// ------------------------------------------------------------------ chat
/** Plain-English story typed in chat or passed with `--text`. */
export function chatDocument(text: string, now: Date = new Date()): SourceDocument {
  return textDocument({ text, sourceType: 'chat', ref: `chat:${now.toISOString()}`, docId: 'CHAT' });
}

// ------------------------------------------------------------------ exploratory objective
export function objectiveFrom(text: string, now: Date = new Date()): ExploratoryObjective {
  const t = text.trim();
  if (!t) throw new QAError('DATA', 'exploratory objective is empty');
  return {
    id: `OBJ-${sha256(t).slice(0, 8)}`,
    text: t,
    source: { type: 'chat', ref: `chat:${now.toISOString()}`, hash: sha256(t) },
  };
}

// ------------------------------------------------------------------ Azure DevOps work item (optional input)
const AdoWorkItem = z.looseObject({
  id: z.number(),
  rev: z.number().optional(),
  fields: z.looseObject({
    'System.Title': z.string(),
    'System.Description': z.string().nullish(),
    'Microsoft.VSTS.Common.AcceptanceCriteria': z.string().nullish(),
    'System.WorkItemType': z.string().optional(),
    'System.State': z.string().optional(),
    'System.Tags': z.string().nullish(),
  }),
});
export type AdoWorkItem = z.infer<typeof AdoWorkItem>;

export function adoWorkItemToDocument(wi: AdoWorkItem, org?: string): SourceDocument {
  const f = wi.fields;
  const text = [
    `**Summary:** ${f['System.Title']}`,
    htmlToText(f['System.Description'] ?? ''),
    f['Microsoft.VSTS.Common.AcceptanceCriteria']
      ? `**Acceptance criteria**\n\n${htmlToText(f['Microsoft.VSTS.Common.AcceptanceCriteria'])}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return textDocument({
    text,
    sourceType: 'ado',
    ref: org ? `${org}/_workitems/edit/${wi.id}` : `ADO-${wi.id}`,
    docId: `ADO-${wi.id}`,
    title: f['System.Title'],
    ...(wi.rev !== undefined ? { version: String(wi.rev) } : {}),
    meta: {
      type: f['System.WorkItemType'],
      state: f['System.State'],
      tags: (f['System.Tags'] ?? '')
        .split(';')
        .map((t) => t.trim())
        .filter(Boolean),
    },
  });
}

/**
 * ADO REST (`_apis/wit/workitems/{id}`) with a PAT from `ADO_ORG_URL` / `ADO_PAT`. No ADO org is configured for
 * this project yet, so live use reports TOOL_UNAVAILABLE with the exact missing setting (CLAUDE.md rule 16).
 */
export async function fetchAdoWorkItem(
  id: string,
  ctx: AdapterContext,
  processEnv = process.env,
): Promise<SourceDocument> {
  const org = processEnv['ADO_ORG_URL']?.replace(/\/+$/, '');
  const pat = processEnv['ADO_PAT'];
  if (!/^\d+$/.test(id)) throw new QAError('DATA', `"${id}" is not an Azure DevOps work item id`);
  if (!org || !pat) {
    throw new QAError(
      'TOOL_UNAVAILABLE',
      'Azure DevOps not configured (set ADO_ORG_URL and ADO_PAT); work item skipped',
    );
  }
  const f = ctx.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${org}/_apis/wit/workitems/${id}?api-version=7.1`, {
      headers: { Authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const c = classifyError(err);
    throw new QAError(c.kind === 'UNKNOWN' ? 'TRANSIENT' : c.kind, `Azure DevOps request failed: ${c.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new QAError('AUTH', `Azure DevOps returned ${res.status}`);
  if (!res.ok) throw new QAError(res.status >= 500 ? 'TRANSIENT' : 'DATA', `Azure DevOps returned ${res.status}`);
  const wi = AdoWorkItem.safeParse(await res.json());
  if (!wi.success) throw new QAError('UNKNOWN', 'unexpected Azure DevOps work item shape');
  return adoWorkItemToDocument(wi.data, org);
}

// ------------------------------------------------------------------ past results (defect history)
/** FAIL results of earlier runs (`runs/<id>/results.json`) — risk signal for regression priority. */
export async function pastFailures(root: string): Promise<DefectRecord[]> {
  const runsDir = join(root, 'runs');
  let dirs: string[];
  try {
    dirs = (await readdir(runsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: DefectRecord[] = [];
  for (const d of dirs.sort()) {
    const file = join(runsDir, d, 'results.json');
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const parsed = z.array(TestResult).safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    for (const r of parsed.data.filter((x) => x.state === 'FAIL')) {
      out.push({
        key: `${r.testId}@${r.runId}`,
        summary: `${r.testId} failed in ${r.runId}${r.reason ? `: ${r.reason}` : ''} [${r.environment}]`,
        status: 'FAILED_RUN',
        components: [],
        labels: [r.environment],
        source: { type: 'defect', ref: file, hash: sha256(raw) },
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ git diff → metadata components
/** SFDX source path → metadata type + API name (the most common types; others → `Unknown`). */
export function componentFromPath(path: string): Omit<ChangedComponent, 'change'> | undefined {
  const p = path.replace(/\\/g, '/');
  const m = (re: RegExp): RegExpExecArray | null => re.exec(p);
  let r: RegExpExecArray | null;
  if ((r = m(/\/objects\/([^/]+)\/fields\/([^/]+)\.field-meta\.xml$/)))
    return { type: 'CustomField', apiName: `${r[1]}.${r[2]}`, path };
  if ((r = m(/\/objects\/([^/]+)\/validationRules\/([^/]+)\.validationRule-meta\.xml$/)))
    return { type: 'ValidationRule', apiName: `${r[1]}.${r[2]}`, path };
  if ((r = m(/\/objects\/([^/]+)\/recordTypes\/([^/]+)\.recordType-meta\.xml$/)))
    return { type: 'RecordType', apiName: `${r[1]}.${r[2]}`, path };
  if ((r = m(/\/objects\/([^/]+)\/listViews\/([^/]+)\.listView-meta\.xml$/)))
    return { type: 'ListView', apiName: `${r[1]}.${r[2]}`, path };
  if ((r = m(/\/objects\/([^/]+)\/\1\.object-meta\.xml$/))) return { type: 'CustomObject', apiName: r[1] ?? '', path };
  if ((r = m(/\/classes\/([^/]+)\.cls(?:-meta\.xml)?$/))) return { type: 'ApexClass', apiName: r[1] ?? '', path };
  if ((r = m(/\/triggers\/([^/]+)\.trigger(?:-meta\.xml)?$/)))
    return { type: 'ApexTrigger', apiName: r[1] ?? '', path };
  if ((r = m(/\/flows\/([^/]+)\.flow-meta\.xml$/))) return { type: 'Flow', apiName: r[1] ?? '', path };
  if ((r = m(/\/lwc\/([^/]+)\//))) return { type: 'LightningComponentBundle', apiName: r[1] ?? '', path };
  if ((r = m(/\/aura\/([^/]+)\//))) return { type: 'AuraDefinitionBundle', apiName: r[1] ?? '', path };
  if ((r = m(/\/layouts\/([^/]+)\.layout-meta\.xml$/))) return { type: 'Layout', apiName: r[1] ?? '', path };
  if ((r = m(/\/flexipages\/([^/]+)\.flexipage-meta\.xml$/))) return { type: 'FlexiPage', apiName: r[1] ?? '', path };
  if ((r = m(/\/permissionsets\/([^/]+)\.permissionset-meta\.xml$/)))
    return { type: 'PermissionSet', apiName: r[1] ?? '', path };
  if ((r = m(/\/profiles\/([^/]+)\.profile-meta\.xml$/))) return { type: 'Profile', apiName: r[1] ?? '', path };
  if ((r = m(/\/customMetadata\/([^/]+)\.md-meta\.xml$/))) return { type: 'CustomMetadata', apiName: r[1] ?? '', path };
  if (/\/(?:force-app|main\/default)\//.test(p) && /-meta\.xml$/.test(p))
    return { type: 'Unknown', apiName: p.split('/').pop() ?? p, path };
  return undefined;
}

const STATUS: Record<string, ChangedComponent['change']> = { A: 'ADDED', M: 'MODIFIED', D: 'DELETED', R: 'RENAMED' };

/** `git diff --name-status <ref>` in an SFDX project → changed metadata components (deduplicated per component). */
export async function gitDiffComponents(ref: string, ctx: AdapterContext): Promise<ChangedComponent[]> {
  if (!/^[\w./~^@{}-]+$/.test(ref) || ref.startsWith('-')) throw new QAError('DATA', `unsafe git ref "${ref}"`);
  const exec = ctx.exec ?? run;
  const res = await exec('git', ['diff', '--name-status', ref], { cwd: ctx.cwd ?? ctx.root, timeoutMs: 30_000 });
  if (res.error || res.code !== 0) {
    throw new QAError('TOOL_UNAVAILABLE', `git diff ${ref} failed: ${(res.error ?? res.stderr).slice(0, 200)}`);
  }
  const seen = new Map<string, ChangedComponent>();
  for (const line of res.stdout.split(/\r?\n/)) {
    const [status = '', ...paths] = line.split('\t');
    const path = paths[paths.length - 1];
    if (!path) continue;
    const c = componentFromPath(path);
    if (!c) continue;
    const key = `${c.type}:${c.apiName}`;
    if (!seen.has(key)) seen.set(key, { ...c, change: STATUS[status.charAt(0)] ?? 'MODIFIED' });
  }
  return [...seen.values()];
}
