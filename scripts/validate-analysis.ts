/**
 * Re-validate the analysis output of one or more runs against the Zod contracts (independent of the run itself).
 * Usage: pnpm tsx scripts/validate-analysis.ts <runId> [<runId> …]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AnalysisFinding,
  Clarification,
  ManualTestCase,
  Requirement,
  SourceDocument,
} from '../src/core/schemas/index.js';

const root = join(import.meta.dirname, '..');
let failed = false;
for (const runId of process.argv.slice(2)) {
  const dir = join(root, 'runs', runId, 'analysis');
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const checks: [string, z.ZodType, string][] = [
    ['requirements.json', z.array(Requirement).min(1), 'requirements'],
    ['clarifications.json', z.array(Clarification), 'clarifications'],
    ['findings.json', z.array(AnalysisFinding), 'findings'],
    ['existing-tests.json', z.array(ManualTestCase), 'existing tests'],
  ];
  const parts: string[] = [];
  for (const [file, schema, label] of checks) {
    const r = schema.safeParse(read(file));
    if (!r.success) {
      failed = true;
      parts.push(`${label}: INVALID (${r.error.issues[0]?.message ?? ''})`);
    } else parts.push(`${label} ${(r.data as unknown[]).length} ok`);
  }
  const run = read('run.json') as { inputs: { kind: string; value: string }[] };
  const sources = run.inputs.length;
  const reqs = z.array(Requirement).parse(read('requirements.json'));
  const unsourced = reqs.filter((x) => x.sources.length === 0 || x.sources.some((s) => !s.section)).length;
  const questions = z.array(Clarification).parse(read('clarifications.json')).length;
  if (questions < 1) failed = true;
  const docFiles = readdirSync(join(dir, 'sources'));
  for (const f of docFiles) {
    const d = SourceDocument.safeParse(JSON.parse(readFileSync(join(dir, 'sources', f), 'utf8')));
    if (!d.success) {
      failed = true;
      parts.push(`source ${f}: INVALID`);
    }
  }
  parts.push(`source documents ${docFiles.length} ok`);
  console.log(
    `${runId}: inputs ${sources} · ${parts.join(' · ')} · requirements without a section ref: ${unsourced} · questions ≥1: ${questions >= 1 ? 'yes' : 'NO'}`,
  );
}
process.exitCode = failed ? 1 : 0;
