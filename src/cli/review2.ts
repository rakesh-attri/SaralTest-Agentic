// qa review --pass 2 --run <build run> [--cases ids]: Test Reviewer pass 2 again on specs that are already generated,
// without regenerating them. Uses the current org knowledge (latest snapshot, locator registry) — e.g. after
// RE_VERIFY marks were cleared by re-exploring the pages — and fresh tool results (tsc, ESLint, --list, dry-run).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedSpec } from '../agents/test-generator/graph.js';
import { reviewPass2Round, settlePass2 } from '../agents/test-reviewer/pass2.js';
import { QAError } from '../core/errors.js';
import type { GeneratedArtifact } from '../core/schemas/generation.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import { manifestPath } from '../graph/buildNodes.js';
import type { QAGraphStateType } from '../graph/state.js';
import { createRuntime } from './analyze.js';
import { createBuild } from './build.js';

type Say = (msg: string) => void;
const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

export interface Pass2ReviewOptions {
  root: string;
  buildRun: string;
  /** Default: the build run's org. */
  org?: string;
  cases?: string[];
  offline?: boolean;
  say: Say;
}

export async function rerunPass2(o: Pass2ReviewOptions): Promise<{ runId: string; artifacts: GeneratedArtifact[] }> {
  const runId = newRunId('review2');
  const rt = await createRuntime({
    root: o.root,
    say: o.say,
    logFile: runPaths(o.root, runId).runLog,
    ...(o.offline ? { offline: true } : {}),
  });
  try {
    const v = (await rt.graph.getState({ configurable: { thread_id: o.buildRun } })).values as QAGraphStateType;
    if (!v.buildSpecs.length) {
      throw new QAError('DATA', `run ${o.buildRun} has no generated specs in .qa-memory/checkpoints.db`, {
        fix: 'run qa build first',
      });
    }
    const wanted = o.cases ?? v.buildSpecs.map((s) => s.caseId);
    const specs: GeneratedSpec[] = [];
    for (const id of wanted) {
      const spec = v.buildSpecs.find((s) => s.caseId === id);
      if (!spec) throw new QAError('DATA', `run ${o.buildRun} has no spec for ${id}`);
      const file = join(o.root, ...spec.path.split('/'));
      // Review exactly the file on disk: refuse when it is not the version this build produced.
      if (!existsSync(file) || sha16(readFileSync(file, 'utf8')) !== spec.artifact.hash) {
        throw new QAError(
          'DATA',
          `${spec.path} is not the version run ${o.buildRun} generated (rebuilt or edited since)`,
          {
            fix: 'review the build run that produced the current file',
          },
        );
      }
      specs.push(spec);
    }
    const cases = v.testCases.filter((c) => wanted.includes(c.id));
    const storyKey = v.storyKey ?? 'story';
    const build = createBuild({
      root: o.root,
      orgAlias: o.org ?? v.org,
      runId,
      designRunId: v.designRunId ?? '',
      storyKey,
      ...(o.offline ? { offline: true } : {}),
      say: o.say,
    });
    const { ctx, notes } = await build.build({ runId, storyKey, testCases: cases });
    for (const n of notes) o.say(n);
    o.say(`Checking ${specs.map((s) => s.path).join(', ')}: tsc, ESLint, playwright --list (no execution)…`);
    const toolchain = await build.toolchain?.(specs.map((s) => s.path));
    const refs = [...new Set(specs.flatMap((s) => s.artifact.locatorsUsed))];
    const dryRun = build.dryRun && refs.length ? await build.dryRun(refs) : undefined;
    if (dryRun) o.say(`Locator dry-run: ${dryRun.checks.filter((c) => c.ok).length}/${dryRun.checks.length} resolved.`);
    const r = await reviewPass2Round(
      {
        ctx,
        cases,
        specs,
        ...(toolchain ? { toolchain } : {}),
        ...(dryRun ? { dryRun } : {}),
        prior: [],
        round: 1,
        mode: rt.deps.router ? 'llm' : 'mechanical',
      },
      {
        ...(rt.deps.router ? { router: rt.deps.router } : {}),
        ...(rt.deps.skills ? { skills: rt.deps.skills } : {}),
        ...(rt.deps.redactor ? { redactor: rt.deps.redactor } : {}),
        logger: rt.deps.logger,
      },
    );
    // Review only: nothing is regenerated, so every open finding is settled now.
    const settled = settlePass2(r.findings, specs);

    // Update the verdicts in the story manifest (the specs themselves are unchanged).
    const mf = join(o.root, ...manifestPath(storyKey).split('/'));
    if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, 'utf8')) as { artifacts: (GeneratedArtifact & { reviewedBy?: string })[] };
      m.artifacts = m.artifacts.map((a) => {
        const n = settled.artifacts.find((x) => x.path === a.path);
        return n ? { ...a, reviewStatus: n.reviewStatus, reviewReasons: n.reviewReasons, reviewedBy: runId } : a;
      });
      writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
    }
    const dir = join(runPaths(o.root, runId).dir, 'build');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'review-pass2-recheck.json'),
      `${JSON.stringify(
        {
          buildRun: o.buildRun,
          reviewRun: runId,
          snapshotId: ctx.snapshotId,
          models: r.models,
          environment: r.environment,
          judgeDegraded: r.judgeDegraded,
          toolchain,
          dryRun,
          findings: settled.findings,
          artifacts: settled.artifacts,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return { runId, artifacts: settled.artifacts };
  } finally {
    await rt.close();
  }
}
