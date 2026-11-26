// qa decide --from-run <analysis run> --decisions <yaml> [--run-id <id>]: apply operator decisions (answers to
// clarification questions, deferred requirements, notes on org conflicts) to an analysis run and write a NEW analysis
// run that `qa design --from-run` can use. Deterministic: no model call, no org call. The source run is not changed.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { QAError } from '../core/errors.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { SourceDocument } from '../core/schemas/inputs.js';
import { AnalysisFinding, Clarification, Requirement } from '../core/schemas/requirement.js';
import { applyDecisions, DecisionsFile, type DecisionsResult } from '../inputs/decisions.js';

type Say = (msg: string) => void;
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8')) as unknown;
const list = <T>(file: string, schema: z.ZodType<T>): T[] =>
  existsSync(file) ? z.array(schema).parse(readJson(file)) : [];
const write = (file: string, v: unknown): void => {
  writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
};

export interface DecideOptions {
  root: string;
  fromRun: string;
  decisionsFile: string;
  runId?: string;
  say: Say;
}

export function decide(o: DecideOptions): { runId: string; result: DecisionsResult } {
  const from = join(runPaths(o.root, o.fromRun).dir, 'analysis');
  if (!existsSync(join(from, 'requirements.json'))) {
    throw new QAError('DATA', `run ${o.fromRun} has no analysis output (${join(from, 'requirements.json')})`);
  }
  const file = resolve(o.root, o.decisionsFile);
  if (!existsSync(file)) throw new QAError('DATA', `decisions file not found: ${file}`);
  const parsed = DecisionsFile.safeParse(parseYaml(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new QAError('DATA', `invalid decisions file ${file}: ${parsed.error.message}`);
  const d = parsed.data;

  const srcDir = join(from, 'sources');
  const sources = existsSync(srcDir)
    ? readdirSync(srcDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => SourceDocument.parse(readJson(join(srcDir, f))))
    : [];
  let result: DecisionsResult;
  try {
    result = applyDecisions(
      {
        sources,
        requirements: list(join(from, 'requirements.json'), Requirement),
        findings: list(join(from, 'findings.json'), AnalysisFinding),
        clarifications: list(join(from, 'clarifications.json'), Clarification),
      },
      d,
    );
  } catch (e) {
    throw new QAError('DATA', `decisions do not match run ${o.fromRun}: ${(e as Error).message}`);
  }

  const runId = o.runId ?? newRunId('decide');
  const out = join(runPaths(o.root, runId).dir, 'analysis');
  if (existsSync(out)) throw new QAError('DATA', `run ${runId} already exists — use a new --run-id`);
  mkdirSync(join(out, 'sources'), { recursive: true });
  // Everything the decisions do not touch is carried over unchanged.
  for (const f of readdirSync(from)) {
    if (f.endsWith('.json') && !['requirements.json', 'findings.json', 'clarifications.json', 'run.json'].includes(f)) {
      copyFileSync(join(from, f), join(out, f));
    }
  }
  for (const doc of result.sources) write(join(out, 'sources', `${doc.docId}.json`), doc);
  write(join(out, 'requirements.json'), result.requirements);
  write(join(out, 'findings.json'), result.findings);
  write(join(out, 'clarifications.json'), result.clarifications);
  const run = existsSync(join(from, 'run.json')) ? (readJson(join(from, 'run.json')) as Record<string, unknown>) : {};
  write(join(out, 'run.json'), {
    ...run,
    runId,
    storyKey: d.storyKey,
    derivedFrom: o.fromRun,
    decisions: { file: o.decisionsFile, decidedBy: d.decidedBy, decidedOn: d.decidedOn },
  });
  writeFileSync(
    join(out, 'decisions-applied.md'),
    [
      `# Decisions applied to ${o.fromRun} → ${runId}`,
      '',
      `Decided by ${d.decidedBy} on ${d.decidedOn} (${o.decisionsFile}). No model and no org call were used.`,
      '',
      ...result.changes.map((c) => `- ${c}`),
      '',
    ].join('\n'),
    'utf8',
  );
  return { runId, result };
}

export function registerDecide(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('decide')
    .description('Apply operator decisions (answers, deferred requirements) to an analysis run → new analysis run')
    .requiredOption('--from-run <runId>', 'qa analyze run to start from (not modified)')
    .requiredOption('--decisions <file>', 'decisions YAML (see examples/decisions/)')
    .option('--run-id <id>', 'id of the new analysis run (default decide-<timestamp>)')
    .action((o: { fromRun: string; decisions: string; runId?: string }) => {
      const root = rootOf();
      const { runId, result } = decide({
        root,
        fromRun: o.fromRun,
        decisionsFile: o.decisions,
        ...(o.runId ? { runId: o.runId } : {}),
        say,
      });
      for (const c of result.changes) say(`  ${c}`);
      const st = (s: string): number => result.requirements.filter((r) => r.status === s).length;
      say(
        `Requirements: ${String(st('EXECUTABLE'))} executable, ${String(st('REVIEW_REQUIRED'))} review required, ${String(st('DEFERRED'))} deferred; ${String(result.findings.length)} findings left.`,
      );
      say(`Saved: ${join(runPaths(root, runId).dir, 'analysis')}`);
      say(`Next: qa design --from-run ${runId} --org <alias>`);
    });
}
