import type { AnalysisFinding, ManualTestCase, SourceDocument, SourceSection } from '../../core/schemas/index.js';
import type { RefIndex } from './refs.js';

/**
 * Deterministic requirement lint (CLAUDE.md rule 15: prefer deterministic checks). Each rule comes from the
 * requirement-analysis skill's "Ambiguity & gap checklist" and is phrased generically — it knows wording patterns,
 * never a particular story. The model adds judgement (conflicts, cross-source questions) on top of this.
 */

export interface LintRule {
  id: string;
  kind: AnalysisFinding['kind'];
  severity: AnalysisFinding['severity'];
  appliesTo: readonly SourceSection['kind'][];
  /** True when the finding means the expected outcome cannot be asserted yet → requirements citing it are REVIEW_REQUIRED. */
  blocksOutcome: boolean;
  /** Returns the matched evidence (short phrase) or undefined. */
  match: (text: string) => string | undefined;
  message: (evidence: string) => string;
}

const SPEC_KINDS = ['ac', 'rule', 'nfr', 'scenario', 'description', 'summary', 'text'] as const;
const BEHAVIOUR_KINDS = ['ac', 'rule', 'scenario'] as const;

const firstMatch = (re: RegExp) => (text: string) => re.exec(text)?.[0];

export const LINT_RULES: readonly LintRule[] = [
  {
    id: 'vague-wording',
    blocksOutcome: true,
    kind: 'AMBIGUITY',
    severity: 'MEDIUM',
    appliesTo: SPEC_KINDS,
    match: firstMatch(
      /\b(?:probably|possibly|maybe|perhaps|TBD|TBC|to be (?:decided|confirmed|defined)|etc\.?|and so on|as appropriate|as needed|if needed|where possible|ideally|approximately|roughly|user[- ]friendly|reasonable|sufficient|some kind of)\b/i,
    ),
    message: (e) =>
      `Vague wording "${e}": the expected behaviour is not definite; confirm whether it is required, optional or out of scope.`,
  },
  {
    id: 'unspecified-message',
    blocksOutcome: false,
    kind: 'MISSING_DETAIL',
    severity: 'MEDIUM',
    appliesTo: BEHAVIOUR_KINDS,
    match: (t) => {
      const m =
        /\b(?:an? )?(?:error|warning|message|alert|notification|toast)(?: message)? (?:is |will be )?(?:shown|displayed|raised|thrown|appears?)\b|\bwarned\b/i.exec(
          t,
        );
      // A quoted text means the message is specified.
      return m && !/["“”‘’']{1}[^"“”‘’']{3,}["“”‘’']{1}/.test(t) ? m[0] : undefined;
    },
    message: (e) =>
      `"${e}" without the exact text or where it appears: the expected message is unknown until observed in the org (assert presence only, or confirm the text).`,
  },
  {
    id: 'external-list',
    blocksOutcome: true,
    kind: 'MISSING_DETAIL',
    severity: 'MEDIUM',
    appliesTo: ['ac', 'rule', 'nfr', 'assumption'],
    match: firstMatch(
      /\b(?:one of the|from the|in the|on the)\s+(?:approved|allowed|permitted|valid|supported|standard|agreed)\b[^.]*|\b(?:maintained|published|defined|managed) by\b[^.]*/i,
    ),
    message: (e) =>
      `Refers to values defined elsewhere ("${e.trim()}") that are not provided: tests cannot assert valid/invalid values until the list is supplied.`,
  },
  {
    id: 'timing-mechanism',
    blocksOutcome: false,
    kind: 'ORG_CHECK_NEEDED',
    severity: 'MEDIUM',
    appliesTo: ['ac', 'rule', 'nfr'],
    match: firstMatch(
      /\b(?:immediately|instantly|in real[- ]time|real[- ]time|automatically|asynchronously|eventually|nightly|on a schedule)\b/i,
    ),
    message: (e) =>
      `Timing "${e}": the mechanism (trigger, flow, roll-up summary, batch) decides whether the result is synchronous; confirm it in the org before asserting timing.`,
  },
  {
    id: 'custom-component',
    blocksOutcome: false,
    kind: 'ORG_CHECK_NEEDED',
    severity: 'LOW',
    appliesTo: SPEC_KINDS,
    match: firstMatch(/\b[A-Za-z][A-Za-z0-9_]*__(?:c|r|mdt|e|x)\b/),
    message: (e) =>
      `Custom component ${e} is referenced: verify it exists in the org and is accessible to the personas (org discovery).`,
  },
  {
    id: 'nfr-measurement',
    blocksOutcome: true,
    kind: 'MISSING_DETAIL',
    severity: 'LOW',
    appliesTo: ['nfr'],
    match: firstMatch(
      /\b(?:under|within|less than|below|at most|faster than)\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|minutes?)\b[^.]*/i,
    ),
    message: (e) =>
      `Performance target "${e.trim()}" needs a measurement method (where timed from/to, percentile, environment, baseline) before it can be a pass/fail check.`,
  },
  {
    id: 'conditional-rule',
    blocksOutcome: false,
    kind: 'MISSING_DETAIL',
    severity: 'LOW',
    appliesTo: ['ac', 'rule'],
    match: firstMatch(
      /\b(?:required|mandatory|optional|hidden|read[- ]only|visible|editable) (?:when|if|unless|only when|only if)\b[^.]*/i,
    ),
    message: (e) =>
      `Conditional behaviour "${e.trim()}": both branches (condition met / not met) need an expected result.`,
  },
];

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(3, '0')}`;

/** Spec lint over every non-test source document. */
export function lintSources(docs: readonly SourceDocument[], refs: RefIndex): AnalysisFinding[] {
  const out: AnalysisFinding[] = [];
  for (const doc of docs) {
    if (doc.meta['format'] === 'manual-tests') continue;
    for (const section of doc.sections) {
      for (const rule of LINT_RULES) {
        if (!rule.appliesTo.includes(section.kind)) continue;
        const evidence = rule.match(section.text)?.replace(/\s+/g, ' ');
        if (!evidence) continue;
        out.push({
          id: nextId('LINT'),
          kind: rule.kind,
          text: rule.message(evidence),
          refs: [refs.display(`${doc.docId}#${section.ref}`)],
          requirementIds: [],
          severity: rule.severity,
          origin: 'lint',
          rule: rule.id,
        });
      }
    }
  }
  return out;
}

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'are',
  'not',
  'open',
  'click',
  'enter',
  'check',
  'exists',
]);

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Section kinds that are requirements an existing test could cover. */
const COVERABLE: readonly SourceSection['kind'][] = ['ac', 'rule', 'nfr', 'scenario'];

/**
 * Existing test-case lint: unsupported tests, likely duplicates, failed last runs (risk signal), and requirement
 * sections without any existing test.
 */
export function lintExistingTests(
  tests: readonly ManualTestCase[],
  docs: readonly SourceDocument[],
  refs: RefIndex,
): AnalysisFinding[] {
  if (!tests.length) return [];
  const out: AnalysisFinding[] = [];
  const push = (f: Omit<AnalysisFinding, 'id' | 'origin' | 'requirementIds'>): void => {
    out.push({ ...f, id: nextId('LINT'), origin: 'lint', requirementIds: [] });
  };

  for (const t of tests) {
    if (!t.requirementRefs.length) {
      push({
        kind: 'UNSUPPORTED_TEST',
        rule: 'test-without-requirement',
        severity: 'MEDIUM',
        refs: [t.id],
        text: `${t.id} "${t.title}" names no requirement: obsolete or unsupported unless a source requirement is identified.`,
      });
    } else {
      const unknown = t.requirementRefs.filter((r) => !refs.resolve(r));
      if (unknown.length) {
        push({
          kind: 'UNSUPPORTED_TEST',
          rule: 'test-unknown-ref',
          severity: 'MEDIUM',
          refs: [t.id],
          text: `${t.id} "${t.title}" references ${unknown.join(', ')}, which no source document contains.`,
        });
      }
    }
    if (t.lastRun.status === 'FAIL' || t.lastRun.status === 'BLOCKED') {
      push({
        kind: 'RISK_SIGNAL',
        rule: 'test-last-run-failed',
        severity: 'HIGH',
        refs: [t.id, ...t.requirementRefs.filter((r) => refs.resolve(r))],
        text: `${t.id} "${t.title}" was ${t.lastRun.status === 'FAIL' ? 'failing' : 'blocked'} on its last run${t.lastRun.date ? ` (${t.lastRun.date})` : ''}: raise regression priority for the requirements it covers.`,
      });
    }
  }

  // Likely duplicates: overlapping requirement refs and similar wording.
  for (let i = 0; i < tests.length; i++) {
    for (let j = i + 1; j < tests.length; j++) {
      const a = tests[i];
      const b = tests[j];
      if (!a || !b) continue;
      const refOverlap = jaccard(new Set(a.requirementRefs), new Set(b.requirementRefs));
      const text = (t: ManualTestCase): Set<string> => tokens(`${t.title} ${t.steps.join(' ')} ${t.expected ?? ''}`);
      const sim = jaccard(text(a), text(b));
      if (
        a.requirementRefs.length &&
        b.requirementRefs.length &&
        refOverlap > 0 &&
        sim >= 0.35 &&
        (a.persona ?? '') === (b.persona ?? '')
      ) {
        push({
          kind: 'DUPLICATE_TEST',
          rule: 'test-duplicate',
          severity: 'LOW',
          refs: [b.id, a.id],
          text: `${b.id} "${b.title}" likely duplicates ${a.id} "${a.title}" (same requirement ${[...new Set(a.requirementRefs)].filter((r) => b.requirementRefs.includes(r)).join(', ')}, ${Math.round(sim * 100)}% similar wording); merge or differentiate.`,
        });
      }
    }
  }

  // Requirement sections no existing test references.
  const covered = new Set(
    tests.flatMap((t) => t.requirementRefs.map((r) => refs.resolve(r)).filter((r): r is string => !!r)),
  );
  const gaps: string[] = [];
  for (const doc of docs) {
    if (doc.meta['format'] === 'manual-tests') continue;
    for (const s of doc.sections) {
      const q = `${doc.docId}#${s.ref}`;
      // Only identified requirement items count (AC3, BR-04, a Gherkin scenario) — not generic prose blocks (S5),
      // which may be a table header or an intro paragraph under a "rules" heading.
      const identified = s.kind === 'scenario' || !/^S\d+$/.test(s.ref);
      if (COVERABLE.includes(s.kind) && identified && !covered.has(q)) gaps.push(refs.display(q));
    }
  }
  if (gaps.length) {
    push({
      kind: 'COVERAGE_GAP',
      rule: 'requirement-without-existing-test',
      severity: 'HIGH',
      refs: gaps,
      text: `No existing test case covers: ${gaps.join(', ')}. New cases are needed (Test Planner, Phase 3).`,
    });
  }
  return out;
}

/** Reset the id counter (tests). */
/** Lint rule ids whose findings block assertions. */
export const OUTCOME_BLOCKING_RULES: ReadonlySet<string> = new Set(
  LINT_RULES.filter((r) => r.blocksOutcome).map((r) => r.id),
);

export function resetLintIds(): void {
  counter = 0;
}
