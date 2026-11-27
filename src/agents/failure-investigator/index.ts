// Failure Investigator (PLAN.md §3, defect-investigation SKILL): Observe (signals) → Hypothesize (3–5) → Experiment
// (cheapest discriminating check first) → Conclude. Code decides wherever a deterministic rule applies; the reasoning
// model concludes only otherwise, within the hypotheses the experiments left open, citing evidence ids that exist.
// Below `minConfidence` the verdict is UNKNOWN. Every observation and experiment is written to the evidence ledger.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PolicyConfig } from '../../config/schemas.js';
import type { Environment, Experiment, Investigation, TestResult, Verdict } from '../../core/schemas/index.js';
import { ROUTE_OF } from '../../core/schemas/index.js';
import type { Logger } from '../../core/logger.js';
import type { EvidenceLedger, LedgerEntry } from '../../knowledge/evidenceLedger.js';
import { fileSource } from '../../knowledge/evidenceLedger.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { runStructured } from '../shared/structured.js';
import { loadCaseContext, type CaseContext } from './context.js';
import {
  apiReproduce,
  ariaLocate,
  dataLedgerCheck,
  flakyReruns,
  identityAndHealth,
  permissionCheck,
  requirementTrace,
  rerunExtendedWaits,
  rerunFreshData,
  snapshotDiff,
  validationRuleCheck,
  type ExperimentEnv,
  type ExperimentRun,
  type InvestigationProviders,
  type RerunOutcome,
} from './experiments.js';
import { decide, hypothesesFor, scoreHypotheses, type RuleDecision } from './rules.js';
import { CONCLUSION_CONTRACT, InvestigatorConclusion } from './schema.js';
import { extractSignals, hasSignal } from './signals.js';

export const INVESTIGATOR_SKILLS = ['defect-investigation', 'salesforce-platform'] as const;

export interface InvestigatorDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  ledger: EvidenceLedger;
  providers: InvestigationProviders;
}

export interface InvestigateOptions {
  root: string;
  /** Investigation run id (evidence + reruns are stored under it). */
  runId: string;
  /** Folder of the run that produced the failure. */
  sourceRunDir: string;
  environment: Environment;
  policy: Pick<PolicyConfig, 'investigation'>;
  /** Objects the case's data touches (permission / validation-rule checks). */
  objects?: readonly string[];
  now?: () => Date;
  say?: (m: string) => void;
}

export interface InvestigationOutcome {
  investigation: Investigation;
  evidence: LedgerEntry[];
  /** Fresh-data reruns (the Defect Judge reuses them as reproductions). */
  reruns: RerunOutcome[];
  context: CaseContext;
}

function loadPrompt(): string {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  return text.split(/^## conclude\s*$/m)[1]?.trim() ?? '';
}

/** Rules that decide before any rerun is needed (cheap evidence is conclusive). */
const CONCLUSIVE_EARLY = new Set<Verdict>([
  'ENVIRONMENT',
  'PERMISSION_CONFIG',
  'TEST_DATA',
  'SCRIPT_LOCATOR',
  'STALE_KNOWLEDGE',
]);

export async function investigateFailure(
  r: TestResult,
  o: InvestigateOptions,
  d: InvestigatorDeps,
): Promise<InvestigationOutcome> {
  const say = o.say ?? (() => undefined);
  const now = o.now ?? (() => new Date());
  const failureId = `F-${r.runId}-${r.caseId ?? r.testId}`.replace(/[^A-Za-z0-9-]/g, '-');
  const signals = extractSignals(r);
  const ctx = loadCaseContext(o.root, r.caseId ?? r.testId);
  const env: ExperimentEnv = {
    root: o.root,
    runId: o.runId,
    sourceRunDir: o.sourceRunDir,
    environment: o.environment,
    failureId,
    providers: d.providers,
    waitFactor: o.policy.investigation.extendedWaitFactor,
    flakyReruns: o.policy.investigation.flakyReruns,
    reproductions: o.policy.investigation.reproductions,
    now,
  };
  const evidence: LedgerEntry[] = [];
  const experiments: Experiment[] = [];
  const reruns: RerunOutcome[] = [];
  const record = (x: ExperimentRun | ExperimentRun[]): void => {
    for (const e of Array.isArray(x) ? x : [x]) {
      experiments.push(e.experiment);
      evidence.push(...e.evidence);
      say(`    ${e.experiment.kind}: ${e.experiment.outcome} — ${e.experiment.result}`);
    }
  };

  // ---- Observe: the failure itself is evidence.
  const obsSources = [
    fileSource(o.root, join(o.sourceRunDir, 'results.json'), 'result'),
    ...(r.failure?.errorContext ? [fileSource(o.root, join(o.sourceRunDir, r.failure.errorContext), 'aria')] : []),
    ...(r.failure?.screenshot ? [fileSource(o.root, join(o.sourceRunDir, r.failure.screenshot), 'screenshot')] : []),
    ...(r.failure?.trace ? [fileSource(o.root, join(o.sourceRunDir, r.failure.trace), 'trace')] : []),
  ];
  const obsId = `EV-${failureId}-observed`;
  evidence.push({
    id: obsId,
    runId: o.runId,
    kind: 'observation',
    claim: `${r.caseId ?? r.testId} ${r.state} (${r.environment}) after ${r.attempts ?? 1} attempt(s): ${
      signals.map((s) => s.kind).join(', ') || 'no signal'
    }`,
    sources: obsSources,
    agent: 'failure-investigator',
    confidence: 1,
    environment: o.environment,
    createdAt: now().toISOString(),
    subject: failureId,
  });
  const observations = [
    `state ${r.state} in run ${r.runId} (${r.environment}), persona ${r.persona ?? '?'}, ${r.attempts ?? 1} attempt(s)`,
    ...signals.map((s) => `${s.kind}${s.step ? ` in "${s.step}"` : ''}: ${s.detail}`),
    ...(r.failure?.attempts[0]?.specLine ? [`failed at ${r.failure.attempts[0].specLine}`] : []),
  ];
  let hypotheses = hypothesesFor(signals);

  // ---- Experiment: cheap, local and observe-only first.
  record(requirementTrace(env, ctx, r, signals));
  record(await identityAndHealth(env));
  record(dataLedgerCheck(env, r));
  record(snapshotDiff(env, r.caseId ?? r.testId));
  const objects = o.objects ?? [
    ...new Set(ctx.ir?.steps.flatMap((s) => s.assertions.flatMap((a) => ('object' in a ? [a.object] : []))) ?? []),
  ];
  if (hasSignal(signals, 'DATA_SETUP_FAILED', 'VALIDATION_ERROR', 'DUPLICATE_RULE')) {
    record(
      validationRuleCheck(
        env,
        ctx.ir?.data.length ? ctx.ir.data : objects,
        signals.find((s) => s.sfErrorCode)?.sfErrorCode,
      ),
    );
  }
  if (hasSignal(signals, 'INSUFFICIENT_ACCESS', 'LOCATOR_NOT_FOUND') && objects.length)
    record(await permissionCheck(env, objects));
  if (hasSignal(signals, 'LOCATOR_NOT_FOUND', 'LOCATOR_NOT_UNIQUE')) record(ariaLocate(env, r, signals));

  let decided = decide(signals, experiments);
  if (!(decided && CONCLUSIVE_EARLY.has(decided.verdict) && decided.confidence >= 0.8)) {
    // ---- Reruns (mutate: data through the guard, cleaned up) only when cheap evidence did not decide.
    if (
      hasSignal(signals, 'LOCATOR_NOT_FOUND', 'WAIT_TIMEOUT') &&
      experiments.find((e) => e.kind === 'aria-locate')?.outcome !== 'SUPPORTS'
    ) {
      record(await rerunExtendedWaits(env, r));
    }
    if (hasSignal(signals, 'PASSED_ON_RETRY', 'DIFFERENT_FAILURE_ON_RETRY')) record(await flakyReruns(env, r));
    decided = decide(signals, experiments);
    if (!decided || decided.verdict === 'ENVIRONMENT') {
      const fresh = await rerunFreshData(env, r);
      reruns.push(...fresh.reruns);
      record(fresh.run);
      const trace = experiments.find((e) => e.kind === 'requirement-trace');
      if (fresh.run.experiment.outcome === 'SUPPORTS' && trace?.outcome === 'REFUTES')
        record(await apiReproduce(env, r.caseId));
      decided = decide(signals, experiments);
    }
  }

  // ---- Conclude.
  hypotheses = scoreHypotheses(hypotheses, experiments, decided);
  let verdict: Verdict;
  let confidence: number;
  let rationale: string;
  let verdictBy: Investigation['verdictBy'];
  let rule: string | undefined;
  let model: string | undefined;
  let evidenceIds: string[];
  if (decided) {
    ({ verdict, confidence, rationale } = decided);
    verdictBy = 'rule';
    rule = decided.rule;
    evidenceIds = [obsId, ...decided.evidenceIds];
  } else {
    const c = await modelConclusion(r, o, d, { signals: observations, experiments, evidence, hypotheses });
    verdict = c.verdict;
    confidence = c.confidence;
    rationale = c.rationale;
    verdictBy = c.model === 'none' ? undefined : 'model';
    model = c.model;
    evidenceIds = [obsId, ...c.evidenceIds];
  }
  if (confidence < o.policy.investigation.minConfidence && verdict !== 'UNKNOWN') {
    rationale = `${verdict} at confidence ${confidence.toFixed(2)} is below ${o.policy.investigation.minConfidence}: ${rationale}`;
    verdict = 'UNKNOWN';
  }
  const verdictId = `EV-${failureId}-verdict`;
  evidence.push({
    id: verdictId,
    runId: o.runId,
    kind: 'verdict',
    claim: `${verdict} (${confidence.toFixed(2)}${rule ? `, ${rule}` : model ? `, model ${model}` : ''}): ${rationale}`,
    sources: [...new Set(evidenceIds)].map((id) => ({ type: 'evidence' as const, ref: id })),
    agent: 'failure-investigator',
    confidence,
    environment: o.environment,
    createdAt: now().toISOString(),
    subject: failureId,
  });
  for (const e of evidence) d.ledger.add(e);

  const investigation: Investigation = {
    failureId,
    observations,
    hypotheses,
    verdict,
    confidence,
    // Never CONFIRMED by the investigator: product defects are confirmed by the Defect Judge; script causes by a heal.
    status: 'SUSPECTED',
    runId: o.runId,
    ...(r.caseId ? { caseId: r.caseId } : {}),
    testId: r.testId,
    ...(r.specPath ? { specPath: r.specPath } : {}),
    ...(r.persona ? { persona: r.persona } : {}),
    environment: o.environment,
    signals,
    experiments,
    ...(verdictBy ? { verdictBy } : {}),
    ...(rule ? { rule } : {}),
    route: ROUTE_OF[verdict],
    rationale,
    evidenceIds: [...new Set([...evidenceIds, verdictId])],
    ...(model ? { model } : { model: 'none' }),
    createdAt: now().toISOString(),
  };
  return { investigation, evidence, reruns, context: ctx };
}

async function modelConclusion(
  r: TestResult,
  o: InvestigateOptions,
  d: InvestigatorDeps,
  x: {
    signals: string[];
    experiments: Experiment[];
    evidence: LedgerEntry[];
    hypotheses: ReturnType<typeof scoreHypotheses>;
  },
): Promise<{ verdict: Verdict; confidence: number; rationale: string; evidenceIds: string[]; model: string }> {
  const open = x.hypotheses.filter((h) => h.status !== 'REFUTED' && h.verdict).map((h) => h.verdict as Verdict);
  const reproduced = x.experiments.find((e) => e.kind === 'rerun-fresh-data')?.outcome === 'SUPPORTS';
  const allowed = [...new Set<Verdict>([...open.filter((v) => v !== 'PRODUCT_DEFECT' || reproduced), 'UNKNOWN'])];
  const known = new Set(x.evidence.map((e) => e.id));
  if (!d.router) {
    return {
      verdict: 'UNKNOWN',
      confidence: 0.3,
      rationale: 'no rule decided and no model is configured; needs a human',
      evidenceIds: [],
      model: 'none',
    };
  }
  const user = [
    `CASE ${r.caseId ?? r.testId} (${r.environment}, persona ${r.persona ?? '?'})`,
    'SIGNALS',
    ...x.signals.map((s) => `- ${s}`),
    'EXPERIMENTS',
    ...x.experiments.map(
      (e) => `- ${e.kind}: ${e.outcome} — ${e.result}${e.evidenceIds.length ? ` [${e.evidenceIds.join(', ')}]` : ''}`,
    ),
    'HYPOTHESES',
    ...x.hypotheses.map((h) => `- ${h.id} ${h.verdict ?? ''} (${h.status ?? 'OPEN'}): ${h.text}`),
    `ALLOWED VERDICTS: ${allowed.join(', ')}`,
    'EVIDENCE',
    ...[...known].map((id) => `- ${id}`),
  ].join('\n');
  try {
    const res = await runStructured({
      router: d.router,
      role: 'reasoning',
      agent: 'failure-investigator:conclude',
      schema: InvestigatorConclusion,
      contract: CONCLUSION_CONTRACT,
      system: loadPrompt().replace(/\{\{minConfidence\}\}/g, String(o.policy.investigation.minConfidence)),
      user,
      ...(d.skills ? { skills: { loader: d.skills, names: INVESTIGATOR_SKILLS } } : {}),
      ...(d.redactor ? { redactor: d.redactor } : {}),
      ...(d.logger ? { logger: d.logger } : {}),
      check: (c) => [
        ...(allowed.includes(c.verdict)
          ? []
          : [`verdict ${c.verdict} is not allowed; choose one of ${allowed.join(', ')}`]),
        ...c.evidenceIds.filter((id) => !known.has(id)).map((id) => `evidence id ${id} is not listed under EVIDENCE`),
      ],
    });
    // A model verdict without a deterministic rule is never stronger than 0.75.
    return {
      ...res.value,
      confidence: Math.min(res.value.confidence, 0.75),
      model: `${res.model}${res.usedFallback ? ' (fallback)' : ''}`,
    };
  } catch (e) {
    return {
      verdict: 'UNKNOWN',
      confidence: 0.2,
      rationale: `no rule decided and the model failed (${e instanceof Error ? e.message : String(e)}); needs a human`,
      evidenceIds: [],
      model: 'none',
    };
  }
}

export type { InvestigationProviders, RuleDecision };
