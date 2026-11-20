import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { QAError } from '../core/errors.js';
import type { InputRequest } from '../core/state.js';
import { readDocx, readGherkin, readPdf, readStructured, readTextFile } from './adapters/files.js';
import { JiraClient, jiraIssueToDefect, jiraIssueToDocument, ISSUE_KEY } from './adapters/jira.js';
import { readManualTests } from './adapters/manualTests.js';
import { chatDocument, fetchAdoWorkItem, gitDiffComponents, objectiveFrom, pastFailures } from './adapters/other.js';
import { emptyOutput, type AdapterContext, type AdapterOutput } from './types.js';

export type { AdapterContext, AdapterOutput } from './types.js';

/** File extensions each file adapter accepts (PLAN.md §7a). */
export const FILE_TYPES: Record<string, 'text' | 'gherkin' | 'structured' | 'pdf' | 'docx' | 'manual-tests'> = {
  '.md': 'text',
  '.markdown': 'text',
  '.txt': 'text',
  '.feature': 'gherkin',
  '.json': 'structured',
  '.yaml': 'structured',
  '.yml': 'structured',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'manual-tests',
  '.csv': 'manual-tests',
};

export function resolvePath(p: string, ctx: AdapterContext): string {
  if (isAbsolute(p)) return p;
  const fromCwd = resolve(ctx.cwd ?? process.cwd(), p);
  return existsSync(fromCwd) ? fromCwd : resolve(ctx.root, p);
}

async function readFileInput(path: string): Promise<AdapterOutput> {
  const ext = extname(path).toLowerCase();
  const kind = FILE_TYPES[ext];
  if (!existsSync(path)) throw new QAError('DATA', `input file not found: ${path}`, { path });
  switch (kind) {
    case 'text':
      return { ...emptyOutput('text'), documents: [await readTextFile(path)] };
    case 'gherkin':
      return { ...emptyOutput('gherkin'), documents: [await readGherkin(path)] };
    case 'structured':
      return { ...emptyOutput(ext.slice(1)), documents: [await readStructured(path)] };
    case 'pdf':
      return { ...emptyOutput('pdf'), documents: [await readPdf(path)] };
    case 'docx':
      return { ...emptyOutput('docx'), documents: [await readDocx(path)] };
    case 'manual-tests': {
      const m = await readManualTests(path);
      return {
        ...emptyOutput(`manual-tests:${ext.slice(1)}`),
        tests: m.tests,
        documents: [m.document],
        notes: m.notes,
      };
    }
    default:
      throw new QAError(
        'DATA',
        `unsupported input format "${ext || '(none)'}" for ${path}; supported: ${Object.keys(FILE_TYPES).join(' ')}`,
        { path },
      );
  }
}

/**
 * Resolve one requested input through its adapter. Deterministic; throws QAError with the right IssueKind
 * (DATA = bad/missing input, AUTH, TOOL_UNAVAILABLE, TRANSIENT) — the intake node turns it into an Issue.
 */
export async function resolveInput(req: InputRequest, ctx: AdapterContext): Promise<AdapterOutput> {
  switch (req.kind) {
    case 'jira': {
      const key = req.value.trim().toUpperCase();
      if (!ISSUE_KEY.test(key)) throw new QAError('DATA', `"${req.value}" is not a JIRA issue key (e.g. SF-123)`);
      const r = await new JiraClient(ctx).getIssue(key);
      const base = ctx.env.JIRA_BASE_URL?.replace(/\/+$/, '');
      return { ...emptyOutput(`jira:${r.via}`), documents: [jiraIssueToDocument(r.issue, base)], notes: r.notes };
    }
    case 'ado':
      return { ...emptyOutput('ado:rest'), documents: [await fetchAdoWorkItem(req.value.trim(), ctx)] };
    case 'chat':
      return { ...emptyOutput('chat'), documents: [chatDocument(req.value, ctx.now?.())] };
    case 'file':
    case 'manual-tests':
      return readFileInput(resolvePath(req.value, ctx));
    case 'defects': {
      const out = emptyOutput('defects');
      if (req.value.trim().toLowerCase() !== 'past-results') {
        const r = await new JiraClient(ctx).search(req.value);
        const base = ctx.env.JIRA_BASE_URL?.replace(/\/+$/, '');
        out.defects.push(...r.issues.map((i) => jiraIssueToDefect(i, base)));
        out.via = `defects:jira-${r.via}`;
        out.notes.push(...r.notes);
      }
      const past = await pastFailures(ctx.root);
      out.defects.push(...past);
      out.notes.push(`${past.length} failed result(s) from past runs`);
      return out;
    }
    case 'git-diff':
      return { ...emptyOutput('git-diff'), changes: await gitDiffComponents(req.value.trim(), ctx) };
    case 'objective':
      return { ...emptyOutput('objective'), objectives: [objectiveFrom(req.value, ctx.now?.())] };
  }
}
