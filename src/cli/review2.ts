// qa review --pass 2 --run <build run> [--cases ids]: Test Reviewer pass 2 again on specs that are already generated,
// without regenerating them. Uses the current org knowledge (latest snapshot, locator registry) — e.g. after
// RE_VERIFY marks were cleared by re-exploring the pages — and fresh tool results (tsc, ESLint, --list, dry-run).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GeneratedSpec } from '../agents/test-generator/graph.js';
import { reviewPass2Round, settlePass2, withoutJudge } from '../agents/test-reviewer/pass2.js';
import { QAError } from '../core/errors.js';
import type { DryRunReport, GeneratedArtifact } from '../core/schemas/generation.js';
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
    // One dry-run per case persona: a case is only verified by the locators its own persona sees.
    const dryRuns: DryRunReport[] = [];
    for (const persona of [...new Set(cases.map((c) => c.persona))]) {
      const refs = [
        ...new Set(
          specs
            .filter((s) => cases.find((c) => c.id === s.caseId)?.persona === persona)
            .flatMap((s) => s.artifact.locatorsUsed),
        ),
      ];
      if (!build.dryRun || !refs.length) continue;
      try {
        const d = await build.dryRun(refs, persona);
        dryRuns.push(d);
        o.say(`Locator dry-run as ${persona}: ${d.checks.filter((c) => c.ok).length}/${d.checks.length} resolved.`);
      } catch (err) {
        // jsforce errors carry the SOQL on the first lines; keep the line that says what is wrong.
        const lines = err instanceof Error ? err.message.split('\n').map((l) => l.trim()) : [String(err)];
        const msg =
          lines.find((l) => /not supported|INVALID|denied|insufficient/i.test(l)) ?? lines.find(Boolean) ?? '';
        o.say(`Locator dry-run as ${persona} FAILED: ${msg}`);
        dryRuns.push({
          orgAlias: o.org ?? v.org,
          environment: 'LIVE',
          persona,
          at: new Date().toISOString(),
          checks: [],
          pageErrors: [{ page: '*', error: msg.slice(0, 300) }],
          ok: false,
        });
      }
    }
    const dryRun = dryRuns[0];
    const r = await reviewPass2Round(
      {
        ctx,
        cases,
        specs,
        ...(toolchain ? { toolchain } : {}),
        ...(dryRun ? { dryRun } : {}),
        ...(dryRuns.length ? { dryRuns } : {}),
        prior: [],
        round: 1,
        mode: rt.deps.router ? 'llm' : 'mechanical',
        transientDegrades: true,
      },
      {
        ...(rt.deps.router ? { router: rt.deps.router } : {}),
        ...(rt.deps.skills ? { skills: rt.deps.skills } : {}),
        ...(rt.deps.redactor ? { redactor: rt.deps.redactor } : {}),
        logger: rt.deps.logger,
      },
    );
    // Review only: nothing is regenerated, so every open finding is settled now.
    const settled0 = settlePass2(r.findings, specs);
    const settled = r.judgeDegraded ? { ...settled0, artifacts: withoutJudge(settled0.artifacts) } : settled0;
    if (r.judgeDegraded) o.say('Judge unavailable: deterministic checks only, nothing can be APPROVED in this review.');

    // Update the verdicts in the story manifest (the specs themselves are unchanged).
    const mf = join(o.root, ...manifestPath(storyKey).split('/'));
    if (existsSync(mf)) {
      const m = JSON.parse(readFileSync(mf, 'utf8')) as {
        artifacts: (GeneratedArtifact & { reviewedBy?: string; buildRun?: string })[];
      };
      // A re-review changes only the verdict: reviewStatus / reviewReasons / reviewedBy. Everything else the manifest
      // records about the file (dependsOn, stale, snapshotId, buildRun …) stays as it is — the spec did not change.
      // When the judge was unavailable, the previous judge findings are carried over (they still apply).
      m.artifacts = m.artifacts.map((a) => {
        const s2 = settled.artifacts.find((x) => x.path === a.path);
        if (!s2) return a;
        const priorJudge = r.judgeDegraded
          ? a.reviewReasons
              .filter((x) => / judge: /.test(x))
              .map(
                (x) =>
                  `${x} [carried over from ${a.reviewedBy ?? a.buildRun ?? 'the previous review'}: judge unavailable]`,
              )
          : [];
        return {
          ...a,
          reviewStatus: s2.reviewStatus,
          reviewReasons: [...s2.reviewReasons, ...priorJudge],
          reviewedBy: runId,
        };
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
