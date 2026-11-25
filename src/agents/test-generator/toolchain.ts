// Static "resolve" checks of generated files (PLAN.md Phase 4 exit: specs lint / typecheck / resolve):
// TypeScript (project tsc), ESLint incl. sf-locators/no-fragile-locators, and `playwright test --list` (loads every
// spec and its imports, lists the tests — executes nothing). Results are per repo-relative path.
import { ESLint } from 'eslint';
import { join, relative, sep } from 'node:path';
import { run as defaultRunner, type Runner } from '../../util/exec.js';

export interface ToolchainResult {
  /** path → tsc errors in that file. */
  typecheck: Record<string, string[]>;
  /** path → ESLint errors (rule: message). */
  lint: Record<string, string[]>;
  /** path → test titles Playwright listed for it (empty / missing = not loaded). */
  listed: Record<string, string[]>;
  /** Whole-tool failures (could not run): reported, never silently passed. */
  toolErrors: string[];
}

const rel = (root: string, p: string): string => relative(root, p).split(sep).join('/');

export async function runTypecheck(
  root: string,
  files: readonly string[],
  runner: Runner = defaultRunner,
): Promise<{
  byFile: Record<string, string[]>;
  error?: string;
}> {
  const r = await runner('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false'], {
    cwd: root,
    timeoutMs: 300_000,
  });
  const byFile: Record<string, string[]> = Object.fromEntries(files.map((f) => [f, []]));
  for (const line of `${r.stdout}\n${r.stderr}`.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m?.[1]) continue;
    const file = m[1].split('\\').join('/');
    if (file in byFile) byFile[file]?.push(`${m[2] ?? ''}:${m[3] ?? ''} ${m[4] ?? ''} ${m[5] ?? ''}`);
  }
  const anyMapped = Object.values(byFile).some((v) => v.length);
  if (r.error || (r.code !== 0 && !anyMapped && !/error TS/.test(r.stdout))) {
    return { byFile, error: r.error ?? `tsc exited ${String(r.code)}: ${r.stderr.slice(0, 300)}` };
  }
  return { byFile };
}

export async function runLint(root: string, files: readonly string[]): Promise<Record<string, string[]>> {
  const eslint = new ESLint({ cwd: root });
  const results = await eslint.lintFiles(files.map((f) => join(root, ...f.split('/'))));
  const out: Record<string, string[]> = Object.fromEntries(files.map((f) => [f, []]));
  for (const r of results) {
    out[rel(root, r.filePath)] = r.messages
      .filter((m) => m.severity === 2)
      .map((m) => `${m.line}:${m.column} ${m.ruleId ?? 'parse'}: ${m.message}`);
  }
  return out;
}

interface ListSuite {
  file?: string;
  title?: string;
  specs?: { title: string; file?: string }[];
  suites?: ListSuite[];
}

export async function runList(
  root: string,
  files: readonly string[],
  runner: Runner = defaultRunner,
): Promise<{ byFile: Record<string, string[]>; error?: string }> {
  const r = await runner('npx', ['playwright', 'test', '--list', '--reporter=json', ...files], {
    cwd: root,
    timeoutMs: 300_000,
  });
  const byFile: Record<string, string[]> = Object.fromEntries(files.map((f) => [f, []]));
  let report: { suites?: ListSuite[]; errors?: { message?: string }[] };
  try {
    const start = r.stdout.indexOf('{');
    report = JSON.parse(r.stdout.slice(start)) as typeof report;
  } catch {
    return {
      byFile,
      error: `playwright --list output is not JSON (exit ${String(r.code)}): ${r.stderr.slice(0, 300)}`,
    };
  }
  const visit = (s: ListSuite, file?: string): void => {
    const f = s.file ?? file;
    for (const spec of s.specs ?? []) {
      const key = files.find((x) => f && (x.endsWith(f.split('\\').join('/')) || f.endsWith(x.split('/').pop() ?? x)));
      if (key) byFile[key]?.push(spec.title);
    }
    for (const c of s.suites ?? []) visit(c, f);
  };
  for (const s of report.suites ?? []) visit(s);
  const errors = (report.errors ?? []).map((e) => e.message ?? '').filter(Boolean);
  return { byFile, ...(errors.length ? { error: errors.join(' | ').slice(0, 500) } : {}) };
}

/** Typecheck + lint + list the given repo-relative files (forward slashes). */
export async function runToolchain(root: string, files: readonly string[], runner?: Runner): Promise<ToolchainResult> {
  const toolErrors: string[] = [];
  const tc = await runTypecheck(root, files, runner);
  if (tc.error) toolErrors.push(`typecheck: ${tc.error}`);
  let lint: Record<string, string[]> = {};
  try {
    lint = await runLint(root, files);
  } catch (e) {
    toolErrors.push(`eslint: ${e instanceof Error ? e.message : String(e)}`);
  }
  const list = await runList(root, files, runner);
  if (list.error) toolErrors.push(`playwright --list: ${list.error}`);
  return { typecheck: tc.byFile, lint, listed: list.byFile, toolErrors };
}
