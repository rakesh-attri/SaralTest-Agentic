// Fault-injection suite (PLAN.md Phase 7 exit: faults classified ≥ 4/5 correctly; no assertion changed by the healer).
// For each fault: start the fixture with it → run the target case → investigate the failure → heal script faults
// (FIXTURE repairs are verified, then reverted) → stop the fixture → score expected vs actual verdict.
// FIXTURE only: the scorecard is never a statement about a real org.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  FaultScorecard,
  FaultSuite,
  type FaultOutcome,
  type HealRepair,
  type Investigation,
  type TestResult,
} from '../core/schemas/index.js';
import { FixtureFaults } from '../fixture/faults.js';

export interface FaultSuiteDeps {
  startFixture: (faults: FixtureFaults) => Promise<{ close: () => Promise<void> }>;
  runCase: (o: { runId: string; caseId: string; storyKey: string; org: string }) => Promise<TestResult | undefined>;
  investigate: (o: { sourceRun: string; runId: string }) => Promise<Investigation[]>;
  heal: (o: { investigationRun: string; runId: string }) => Promise<HealRepair[]>;
  say: (m: string) => void;
  now?: () => Date;
}

export function loadFaultSuite(file: string): FaultSuite {
  const text = readFileSync(file, 'utf8');
  return FaultSuite.parse(file.endsWith('.json') ? JSON.parse(text) : parse(text));
}

/** Applied repairs that changed an assertion (refused repairs never applied, so they do not count). */
export const assertionChangesOf = (repairs: readonly HealRepair[]): number =>
  repairs.filter((r) => ['APPLIED', 'VERIFIED', 'FAILED'].includes(r.status) && !r.assertionsUnchanged).length;

export async function runFaultSuite(
  o: { root: string; suite: FaultSuite; runId: string; only?: readonly string[] },
  d: FaultSuiteDeps,
): Promise<{ scorecard: FaultScorecard; files: string[] }> {
  const outcomes: FaultOutcome[] = [];
  let assertionChanges = 0;
  const faults = o.suite.faults.filter((f) => !o.only?.length || o.only.includes(f.id));
  for (const [i, f] of faults.entries()) {
    const tag = `f${i + 1}`;
    const runId = `${o.runId}-${tag}`;
    d.say(`[${f.id}] ${f.title} → ${f.caseId} (expect ${f.expectedVerdict})`);
    const fx = await d.startFixture(FixtureFaults.parse(f.inject));
    try {
      const result = await d.runCase({ runId, caseId: f.caseId, storyKey: o.suite.story, org: o.suite.org });
      if (!result || (result.state !== 'FAIL' && !(result.state === 'UNCERTAIN' && result.flaky))) {
        outcomes.push({
          faultId: f.id,
          expectedVerdict: f.expectedVerdict,
          actualVerdict: null,
          correct: false,
          confidence: null,
          runId,
          testState: result?.state ?? 'NO_RESULT',
          note:
            result?.state === 'PASS'
              ? 'fault not detected: the test passed'
              : `no failure to investigate (${result?.reason ?? 'no result'})`,
        });
        d.say(`  test ${result?.state ?? 'NO_RESULT'} — nothing to investigate`);
        continue;
      }
      const invRun = `${o.runId}-i${i + 1}`;
      const [inv] = await d.investigate({ sourceRun: runId, runId: invRun });
      let healed: boolean | undefined;
      let unchanged: boolean | undefined;
      if (inv && f.expectHeal && (inv.verdict === 'SCRIPT_LOCATOR' || inv.verdict === 'SCRIPT_TIMING')) {
        const repairs = await d.heal({ investigationRun: invRun, runId: `${o.runId}-h${i + 1}` });
        healed = repairs.some((r) => r.status === 'VERIFIED');
        unchanged = repairs.every((r) => r.assertionsUnchanged);
        assertionChanges += assertionChangesOf(repairs);
      }
      const correct = inv?.verdict === f.expectedVerdict;
      outcomes.push({
        faultId: f.id,
        expectedVerdict: f.expectedVerdict,
        actualVerdict: inv?.verdict ?? null,
        correct,
        confidence: inv?.confidence ?? null,
        runId,
        testState: result.state,
        ...(healed !== undefined ? { healed } : {}),
        ...(unchanged !== undefined ? { assertionsUnchanged: unchanged } : {}),
        ...(inv ? { note: `${inv.rule ?? inv.model ?? ''}: ${inv.rationale ?? ''}`.slice(0, 300) } : {}),
      });
      d.say(
        `  → ${inv?.verdict ?? 'no investigation'} (${inv?.confidence.toFixed(2) ?? '-'}) ${correct ? '✓' : '✗'}${
          healed !== undefined
            ? ` · heal ${healed ? 'VERIFIED' : 'not verified'}, assertions ${unchanged ? 'unchanged' : 'CHANGED'}`
            : ''
        }`,
      );
    } finally {
      await fx.close();
    }
  }
  const correct = outcomes.filter((x) => x.correct).length;
  const scorecard = FaultScorecard.parse({
    suiteId: o.suite.id,
    runId: o.runId,
    environment: o.suite.environment,
    total: outcomes.length,
    correct,
    outcomes,
    assertionChanges,
    passed: outcomes.length > 0 && correct / outcomes.length >= 0.8 && assertionChanges === 0,
    createdAt: (d.now?.() ?? new Date()).toISOString(),
  });
  const dir = join(o.root, 'runs', o.runId, 'faults');
  mkdirSync(dir, { recursive: true });
  const json = join(dir, 'scorecard.json');
  writeFileSync(json, JSON.stringify(scorecard, null, 2) + '\n');
  const md = join(dir, 'scorecard.md');
  writeFileSync(md, renderScorecard(scorecard, o.suite));
  return { scorecard, files: [json, md] };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderScorecard(s: FaultScorecard, suite: FaultSuite): string {
  const l = [`# Fault-injection scorecard — ${s.suiteId}`, ''];
  if (s.environment !== 'LIVE')
    l.push(`> **${s.environment}** — faults injected into the offline fixture; not a Salesforce result.`, '');
  l.push(
    `**${s.correct}/${s.total} classified correctly** (${s.total ? Math.round((100 * s.correct) / s.total) : 0} %) · assertion changes by the healer: **${s.assertionChanges}** · exit (≥ 80 % and 0 changes): **${s.passed ? 'PASSED' : 'NOT MET'}**`,
    '',
    '| Fault | Case | Expected | Actual | Confidence | Correct | Heal | Assertions | Test run |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const x of s.outcomes) {
    const f = suite.faults.find((y) => y.id === x.faultId);
    l.push(
      `| ${x.faultId} | ${f?.caseId ?? ''} | ${x.expectedVerdict} | ${x.actualVerdict ?? '—'} | ${x.confidence?.toFixed(2) ?? '—'} | ${x.correct ? 'yes' : '**no**'} | ${
        x.healed === undefined ? '—' : x.healed ? 'verified + reverted' : 'not verified'
      } | ${x.assertionsUnchanged === undefined ? '—' : x.assertionsUnchanged ? 'unchanged' : '**changed**'} | ${x.runId} (${x.testState}) |`,
    );
  }
  l.push('', '## Why', '');
  for (const x of s.outcomes) l.push(`- **${x.faultId}**: ${cell(x.note ?? '')}`);
  l.push('');
  return l.join('\n');
}
