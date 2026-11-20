import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/;

/** `run-20261120-142530-a1b2` — sortable, filesystem-safe on Windows. */
export function newRunId(prefix = 'run', now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${prefix}-${stamp}-${randomBytes(2).toString('hex')}`;
}

export interface RunPaths {
  runId: string;
  dir: string;
  logs: string;
  evidence: string;
  artifacts: string;
  auditLog: string;
  redactionMap: string;
  runLog: string;
}

export function runPaths(root: string, runId: string): RunPaths {
  if (!RUN_ID.test(runId)) throw new Error(`invalid runId "${runId}"`);
  const runsDir = resolve(root, 'runs');
  const dir = resolve(runsDir, runId);
  if (!dir.startsWith(runsDir + sep)) throw new Error(`runId escapes the runs folder: ${runId}`);
  return {
    runId,
    dir,
    logs: join(dir, 'logs'),
    evidence: join(dir, 'evidence'),
    artifacts: join(dir, 'artifacts'),
    auditLog: join(dir, 'audit.jsonl'),
    redactionMap: join(dir, 'redaction-map.json'),
    runLog: join(dir, 'logs', 'run.log'),
  };
}

/** Create `runs/<runId>/{logs,evidence,artifacts}` (idempotent). */
export async function ensureRunFolder(root: string, runId: string): Promise<RunPaths> {
  const p = runPaths(root, runId);
  await Promise.all([p.logs, p.evidence, p.artifacts].map((d) => mkdir(d, { recursive: true })));
  return p;
}
