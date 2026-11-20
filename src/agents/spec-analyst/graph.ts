import { readFileSync } from 'node:fs';
import { classifyError } from '../../core/classifyError.js';
import type { Logger } from '../../core/logger.js';
import type {
  AnalysisFinding,
  Clarification,
  EvidenceEntry,
  IssueKind,
  ManualTestCase,
  Requirement,
  SourceDocument,
  SourceSection,
} from '../../core/schemas/index.js';
import { normalizeText, sha256 } from '../../inputs/sections.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { runStructured } from '../shared/structured.js';
import type { RequirementIdStore } from './ids.js';
import { jaccard, lintExistingTests, lintSources, OUTCOME_BLOCKING_RULES } from './lint.js';
import { RefIndex, renderSources } from './refs.js';
import { AnalyzeOutput, ExtractOutput, type CoverageRow, type RequirementDraft } from './schema.js';

export const SPEC_ANALYST_SKILLS = ['requirement-analysis', 'salesforce-platform'] as const;

/** Sections of prompt.md by `## name`. */
function loadPrompts(): Record<string, string> {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}
const fill = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

export interface SpecAnalystDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  ids: RequirementIdStore;
  maxQuestions: number;
}

export interface SpecAnalystInput {
  /** Requirement id prefix (JIRA key or document id). */
  key: string;
  sources: readonly SourceDocument[];
  existingTests: readonly ManualTestCase[];
  /** Clarifications of earlier rounds (answered / assumed / open). */
  clarifications: readonly Clarification[];
  round: number;
  /** `mechanical` = deterministic degrade path when the model is unavailable or keeps producing invalid output. */
  mode: 'llm' | 'mechanical';
}

export interface SpecAnalystResult {
  requirements: Requirement[];
  findings: AnalysisFinding[];
  /** New OPEN questions for this round (≤ maxQuestions). */
  questions: Clarification[];
  coverage: CoverageRow[];
  evidence: EvidenceEntry[];
  environment: 'LIVE' | 'MOCK' | 'NONE';
  models: string[];
  /** Steps that fell back (analyze failure keeps the requirements; recorded as a DEGRADED issue by the node). */
  degraded: { step: 'analyze'; kind: IssueKind; message: string }[];
}

export const CLARIFICATION_DOC_ID = 'CLARIFICATIONS';

/** Answers and unconfirmed assumptions of earlier rounds become a citable source (`CLARIFICATIONS#Q2`). */
export function clarificationDocument(clars: readonly Clarification[]): SourceDocument | undefined {
  const done = clars.filter((c) => c.status === 'ANSWERED' || c.status === 'ASSUMED');
  if (!done.length) return undefined;
  const sections: SourceSection[] = done.map((c) => ({
    ref: c.id,
    kind: 'text',
    heading: c.status === 'ANSWERED' ? 'Answered clarification' : 'Unconfirmed assumption',
    text:
      c.status === 'ANSWERED'
        ? `Question: ${c.question}\nAnswer (human): ${c.answer ?? ''}`
        : `Question: ${c.question}\nASSUMPTION (unconfirmed, no answer received): ${c.assumption ?? c.proposedAssumption ?? ''}`,
  }));
  const text = normalizeText(sections.map((s) => `${s.ref}: ${s.text}`).join('\n\n'));
  return {
    docId: CLARIFICATION_DOC_ID,
    source: { type: 'chat', ref: 'clarifications', hash: sha256(text) },
    title: 'Clarification answers and assumptions',
    meta: { format: 'clarifications' },
    sections,
    text,
    warnings: [],
  };
}

const significantWords = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !['user', 'users', 'the', 'and'].includes(w));

// ------------------------------------------------------------------ mechanical (degrade) path
const GWT = /^\s*(given|when|then|and|but)\b\s*/i;

function mechanicalDrafts(docs: readonly SourceDocument[]): RequirementDraft[] {
  const drafts: RequirementDraft[] = [];
  for (const doc of docs) {
    if (doc.meta['format'] === 'manual-tests' || doc.docId === CLARIFICATION_DOC_ID) continue;
    for (const s of doc.sections) {
      if (!['ac', 'rule', 'nfr', 'scenario'].includes(s.kind)) continue;
      const lines = s.text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const pre: string[] = [];
      const act: string[] = [];
      const exp: string[] = [];
      let bucket: string[] | undefined;
      for (const l of lines) {
        const m = GWT.exec(l);
        const word = m?.[1]?.toLowerCase();
        if (word === 'given') bucket = pre;
        else if (word === 'when') bucket = act;
        else if (word === 'then') bucket = exp;
        if (m && bucket) bucket.push(l.replace(GWT, ''));
      }
      const text = lines.join(' ');
      drafts.push({
        key: `m${drafts.length + 1}`,
        title: (lines[0] ?? s.ref).slice(0, 120),
        businessObjective: text.slice(0, 500),
        type:
          s.kind === 'nfr'
            ? 'non-functional'
            : /\b(required|must (?:contain|be)|format|maximum|minimum|length|digits|valid)\b/i.test(text)
              ? 'validation'
              : 'functional',
        actors: [],
        personas: [],
        preconditions: pre,
        actions: act,
        businessRules: exp.length ? [] : [text.slice(0, 300)],
        expectedOutcomes: exp,
        expectedOutcomeClear: false,
        reviewReason: 'generated mechanically (model unavailable): needs analyst review',
        dependencies: [],
        dataRequirements: [],
        risk: 'MEDIUM',
        assumptionsKnown: [],
        assumptionsUnknown: [],
        sources: [`${doc.docId}#${s.ref}`],
      });
    }
  }
  return drafts;
}

// ------------------------------------------------------------------ main
export async function analyzeSpec(input: SpecAnalystInput, deps: SpecAnalystDeps): Promise<SpecAnalystResult> {
  const prompts = loadPrompts();
  const clarDoc = clarificationDocument(input.clarifications);
  const docs = clarDoc ? [...input.sources, clarDoc] : [...input.sources];
  const refs = new RefIndex(docs);
  const sourceText = docs.map((d) => d.text.toLowerCase()).join('\n');
  const models: string[] = [];
  const envs: ('LIVE' | 'MOCK')[] = [];
  const label = (env: 'LIVE' | 'MOCK', model: string): void => {
    models.push(model);
    envs.push(env);
  };
  const currentEnv = (): SpecAnalystResult['environment'] =>
    envs.includes('MOCK') ? 'MOCK' : envs.length ? 'LIVE' : 'NONE';

  const lint = [...lintSources(docs, refs), ...lintExistingTests(input.existingTests, docs, refs)];
  const resolvedClars = input.clarifications.filter((c) => c.status !== 'OPEN' && c.status !== 'WITHDRAWN');
  const clarText = resolvedClars.length
    ? `\nAnswers and assumptions from earlier clarification rounds are in source ${CLARIFICATION_DOC_ID}; follow answers, keep assumptions flagged as unconfirmed (cite them).\n`
    : '';

  // ---- 1. extract
  let drafts: RequirementDraft[];
  if (input.mode === 'mechanical' || !deps.router) {
    drafts = mechanicalDrafts(docs);
  } else {
    const res = await runStructured({
      router: deps.router,
      role: 'reasoning',
      agent: 'spec-analyst:extract',
      schema: ExtractOutput,
      system: fill(prompts['extract'] ?? '', { key: input.key, clarifications: clarText }),
      user: `SOURCES\n\n${renderSources(docs, { skipTests: true })}`,
      ...(deps.skills ? { skills: { loader: deps.skills, names: SPEC_ANALYST_SKILLS } } : {}),
      ...(deps.redactor ? { redactor: deps.redactor } : {}),
      ...(deps.logger ? { logger: deps.logger } : {}),
      check: (out) => {
        const problems: string[] = [];
        const keys = new Set<string>();
        for (const r of out.requirements) {
          if (keys.has(r.key)) problems.push(`requirement key ${r.key} is used twice`);
          keys.add(r.key);
          for (const s of r.sources)
            if (!refs.resolve(s)) problems.push(`${r.key}: cited section "${s}" does not exist in the sources`);
          for (const p of r.personas) {
            if (!significantWords(p).some((w) => sourceText.includes(w)))
              problems.push(`${r.key}: persona "${p}" is not named in any source`);
          }
          if (!r.expectedOutcomeClear && !r.reviewReason)
            problems.push(`${r.key}: reviewReason is required when expectedOutcomeClear is false`);
        }
        return problems;
      },
    });
    label(res.environment, res.model);
    drafts = res.value.requirements;
  }

  // ---- 2. ids + canonical requirements (status decided after analysis)
  const qualified = drafts.map((d) => [
    ...new Set(d.sources.map((s) => refs.resolve(s)).filter((s): s is string => !!s)),
  ]);
  const ids = deps.ids.assign(drafts.map((d, i) => ({ sections: qualified[i] ?? [], type: d.type })));
  deps.ids.save();
  const reqs = drafts.map((d, i) => ({ d, id: ids[i] ?? '', cites: qualified[i] ?? [] }));

  // ---- 3. analyze (findings + questions)
  let llmFindings: AnalyzeOutput['findings'] = [];
  let questionDrafts: AnalyzeOutput['questions'] = [];
  const degraded: SpecAnalystResult['degraded'] = [];
  const knownIds = new Set(ids);
  if (input.mode === 'llm' && deps.router) {
    const previous = input.clarifications.length
      ? `\nQuestions already asked in earlier rounds (do not ask them again):\n${input.clarifications.map((c) => `- ${c.id} [${c.status}] ${c.question}`).join('\n')}\n`
      : '';
    const reqBlock = reqs
      .map(
        ({ d, id, cites }) =>
          `${id} [${d.type}; sources ${cites.join(', ')}] ${d.businessObjective}${d.expectedOutcomes.length ? ` → expected: ${d.expectedOutcomes.join('; ')}` : ' → expected: (not stated)'}${d.personas.length ? ` (personas: ${d.personas.join(', ')})` : ''}`,
      )
      .join('\n');
    const lintBlock = lint.map((f) => `- [${f.kind}] ${f.refs.join(', ')}: ${f.text}`).join('\n') || '(none)';
    try {
      const res = await runStructured({
        router: deps.router,
        role: 'reasoning',
        agent: 'spec-analyst:analyze',
        schema: AnalyzeOutput,
        system: fill(prompts['analyze'] ?? '', { maxQuestions: String(deps.maxQuestions), previous }),
        user: `SOURCES\n\n${renderSources(docs)}\n\nREQUIREMENTS\n${reqBlock}\n\nLINT FINDINGS (already reported)\n${lintBlock}`,
        ...(deps.skills ? { skills: { loader: deps.skills, names: SPEC_ANALYST_SKILLS } } : {}),
        ...(deps.redactor ? { redactor: deps.redactor } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
        check: (out) => {
          const problems: string[] = [];
          out.findings.forEach((f, i) => {
            for (const r of f.refs) if (!refs.resolve(r)) problems.push(`findings.${i}: ref "${r}" does not exist`);
            const distinct = new Set(f.refs.map((r) => refs.resolve(r) ?? r));
            if (f.kind === 'CONFLICT' && distinct.size < 2) {
              problems.push(
                `findings.${i}: a CONFLICT must cite the two disagreeing sections; with one section it is an AMBIGUITY`,
              );
            }
            for (const id of f.requirementIds)
              if (!knownIds.has(id)) problems.push(`findings.${i}: unknown requirement id ${id}`);
          });
          out.questions.forEach((q, i) => {
            for (const r of q.refs) if (!refs.resolve(r)) problems.push(`questions.${i}: ref "${r}" does not exist`);
            for (const id of q.requirementIds)
              if (!knownIds.has(id)) problems.push(`questions.${i}: unknown requirement id ${id}`);
          });
          return problems;
        },
      });
      label(res.environment, res.model);
      llmFindings = res.value.findings;
      questionDrafts = res.value.questions;
    } catch (err) {
      const c = classifyError(err);
      if (c.kind === 'HARD_STOP' || c.kind === 'BUDGET') throw err;
      degraded.push({ step: 'analyze', kind: c.kind, message: `analysis step degraded to lint-only: ${c.message}` });
      deps.logger?.warn({ kind: c.kind }, 'spec analyst analyze step failed; continuing with lint findings only');
    }
  }

  // ---- 4. findings (lint + model), linked to requirements by cited sections
  const display = (r: string): string => {
    const q = refs.resolve(r);
    return q ? refs.display(q) : r;
  };
  const reqsBySection = (sectionDisplay: string): string[] => {
    const q = refs.resolve(sectionDisplay);
    return q ? reqs.filter((r) => r.cites.includes(q)).map((r) => r.id) : [];
  };
  const findings: AnalysisFinding[] = [
    ...lint.map((f) => ({ ...f, requirementIds: [...new Set(f.refs.flatMap(reqsBySection))] })),
    ...llmFindings.map((f) => ({
      id: '',
      kind: f.kind,
      text: f.text,
      refs: [...new Set(f.refs.map(display))],
      requirementIds: [
        ...new Set([...f.requirementIds.filter((id) => knownIds.has(id)), ...f.refs.flatMap(reqsBySection)]),
      ],
      severity: f.severity,
      origin: 'llm' as const,
    })),
  ].map((f, i) => ({ ...f, id: `F-${String(i + 1).padStart(3, '0')}` }));

  // ---- 5. questions (≤ maxQuestions per round, most important first, no repeats)
  if (input.mode === 'mechanical' || !deps.router) {
    // No model: ask about the outcome-blocking lint findings so a human can still unblock requirements.
    questionDrafts = findings
      .filter((f) => f.origin === 'lint' && f.rule && OUTCOME_BLOCKING_RULES.has(f.rule))
      .map((f, i) => ({
        question: `${f.refs.join(', ')}: ${f.text} Please clarify.`,
        refs: f.refs,
        requirementIds: f.requirementIds,
        testImpact: 'Until clarified, the affected requirements stay REVIEW_REQUIRED and are not asserted.',
        proposedAssumption:
          'Treat the statement as unconfirmed: do not assert it; keep the requirement REVIEW_REQUIRED.',
        priority: i + 1,
      }));
  }
  const prevQuestions = input.clarifications.map((c) => new Set(significantWords(c.question)));
  const fresh = [...questionDrafts]
    .sort((a, b) => a.priority - b.priority)
    .filter((q) => !prevQuestions.some((p) => jaccard(p, new Set(significantWords(q.question))) >= 0.7));
  const asked = fresh.slice(0, deps.maxQuestions);
  const deferred = fresh.slice(deps.maxQuestions);
  for (const q of deferred) {
    findings.push({
      id: `F-${String(findings.length + 1).padStart(3, '0')}`,
      kind: 'AMBIGUITY',
      text: `Deferred question (over the ${deps.maxQuestions}-per-round limit): ${q.question}`,
      refs: [...new Set(q.refs.map(display))],
      requirementIds: q.requirementIds.filter((id) => knownIds.has(id)),
      severity: 'LOW',
      origin: input.mode === 'llm' ? 'llm' : 'lint',
    });
  }
  const startNo = input.clarifications.length;
  const questions: Clarification[] = asked.map((q, i) => {
    const reqIds = [
      ...new Set([...q.requirementIds.filter((id) => knownIds.has(id)), ...q.refs.flatMap(reqsBySection)]),
    ];
    return {
      id: `Q${startNo + i + 1}`,
      ...(reqIds[0] ? { requirementId: reqIds[0] } : {}),
      requirementIds: reqIds,
      refs: [...new Set(q.refs.map(display))],
      question: q.question,
      testImpact: q.testImpact,
      proposedAssumption: q.proposedAssumption,
      priority: i + 1,
      round: input.round,
      status: 'OPEN',
    };
  });

  // ---- 6. status: REVIEW_REQUIRED when the expected outcome is missing, unclear, conflicting or still open
  const assumed = new Map(
    input.clarifications
      .filter((c) => c.status === 'ASSUMED')
      .map((c) => [`${CLARIFICATION_DOC_ID}#${c.id}`.toUpperCase(), c]),
  );
  const answered = input.clarifications.filter((c) => c.status === 'ANSWERED');
  const requirements: Requirement[] = reqs.map(({ d, id, cites }) => {
    const reasons: string[] = [];
    // Sections whose open points a human already answered, when this requirement cites that answer.
    const settled = new Set(
      answered
        .filter((c) => cites.includes(`${CLARIFICATION_DOC_ID}#${c.id}`))
        .flatMap((c) => c.refs.map((r) => refs.resolve(r)).filter((r): r is string => !!r)),
    );
    if (!d.expectedOutcomes.length) reasons.push('no expected outcome stated in the sources');
    if (!d.expectedOutcomeClear) reasons.push(d.reviewReason ?? 'expected outcome unclear');
    for (const f of findings) {
      if (!f.requirementIds.includes(id)) continue;
      const blocking =
        f.kind === 'CONFLICT' ||
        (f.origin === 'lint' && f.rule !== undefined && OUTCOME_BLOCKING_RULES.has(f.rule)) ||
        (f.origin === 'llm' && f.severity === 'HIGH' && (f.kind === 'AMBIGUITY' || f.kind === 'MISSING_DETAIL'));
      const resolvedByAnswer = f.origin === 'lint' && f.refs.every((r) => settled.has(refs.resolve(r) ?? r));
      if (blocking && !resolvedByAnswer)
        reasons.push(`${f.id} ${f.kind.toLowerCase().replace('_', ' ')}: ${f.text.slice(0, 140)}`);
    }
    for (const q of questions) if (q.requirementIds.includes(id)) reasons.push(`open question ${q.id}`);
    const assumptionNotes: string[] = [];
    for (const c of cites) {
      const a = assumed.get(c.toUpperCase());
      if (a) {
        reasons.push(`relies on unconfirmed assumption ${a.id}`);
        assumptionNotes.push(`ASSUMPTION (unconfirmed, ${a.id}): ${a.assumption ?? a.proposedAssumption ?? ''}`);
      }
    }
    return {
      id,
      title: d.title,
      businessObjective: d.businessObjective,
      actors: d.actors,
      personas: d.personas,
      preconditions: d.preconditions,
      actions: d.actions,
      businessRules: d.businessRules,
      expectedOutcomes: d.expectedOutcomes,
      dependencies: d.dependencies,
      dataRequirements: d.dataRequirements,
      risk: d.risk,
      assumptions: { known: [...d.assumptionsKnown, ...assumptionNotes], unknown: d.assumptionsUnknown },
      sources: cites.map((c) => refs.sourceRef(c)).filter((s): s is NonNullable<typeof s> => !!s),
      type: d.type,
      status: reasons.length ? 'REVIEW_REQUIRED' : 'EXECUTABLE',
      reviewReasons: [...new Set(reasons)],
    };
  });

  // ---- 7. coverage by existing tests + evidence ledger entries
  const coverage: CoverageRow[] = reqs.map(({ id, cites }) => ({
    requirementId: id,
    sections: cites.map((c) => refs.display(c)),
    coveredBy: input.existingTests
      .filter((t) =>
        t.requirementRefs.some((r) => {
          const q = refs.resolve(r);
          return q !== undefined && cites.includes(q);
        }),
      )
      .map((t) => t.id),
  }));
  const now = new Date().toISOString();
  // Analysis touches no org: LIVE = real inputs + real (or no) model; MOCK = mock model (rule 13).
  const environment = currentEnv();
  const evEnv = environment === 'MOCK' ? 'MOCK' : 'LIVE';
  const evidence: EvidenceEntry[] = requirements.map((r) => ({
    id: `EV-${r.id}`,
    claim: `${r.id} (${r.status}): ${r.businessObjective}${r.reviewReasons.length ? ` | review: ${r.reviewReasons.join('; ')}` : ''}`,
    sources: r.sources.map((s) => `${s.ref}${s.section ? `#${s.section}` : ''}@${s.hash.slice(0, 12)}`),
    agent: input.mode === 'llm' ? 'spec-analyst' : 'spec-analyst:mechanical',
    confidence: input.mode === 'mechanical' ? 0.3 : r.status === 'EXECUTABLE' ? 0.85 : 0.6,
    environment: evEnv,
    createdAt: now,
  }));

  return { requirements, findings, questions, coverage, evidence, environment, models, degraded };
}
