import type {
  AnalysisFinding,
  Clarification,
  ComponentVersion,
  EvidenceLevel,
  ManualTestCase,
  Requirement,
  SourceDocument,
} from '../core/schemas/index.js';
import type { OrgCheck } from '../agents/sf-intelligence/schema.js';
import type { LocatorEntry } from '../knowledge/locatorRegistry.js';
import { RefIndex } from '../agents/spec-analyst/refs.js';

/**
 * Expected-result oracles (PLAN.md §7f): the index of everything an expectation may cite, with the evidence level each
 * item carries when cited. Built deterministically from Phase 1/2 outputs; no model is involved.
 *
 * Evidence ids:
 * - requirement sections: `DOC#REF` (`SF-219#AC2`, `BRD-CON-012#BR-04`)
 * - org cross-check results: `OC-007`
 * - snapshot components: `<Type>:<apiName>` (`ValidationRule:Contact.Phone_Must_Be_10_Digits`)
 * - registry locators (UI observations): `LOC:<page>/<element>`
 * - imported manual tests: `MTC-001`
 */
export type EvidenceKind = 'requirement-section' | 'org-check' | 'component' | 'locator' | 'manual-test';

export interface EvidenceRecord {
  id: string;
  kind: EvidenceKind;
  /** The text an expectation's values must be grounded in. */
  text: string;
  /** Level this item carries when cited alone. */
  level: EvidenceLevel;
  /** Why the level is what it is (shown in reports and reviewer findings). */
  reason: string;
  /** Qualified section refs this item relates to. */
  refs: string[];
  requirementIds: string[];
  environment?: 'LIVE' | 'FIXTURE';
}

export interface EvidenceIndexInput {
  docs: readonly SourceDocument[];
  requirements: readonly Requirement[];
  findings?: readonly AnalysisFinding[];
  clarifications?: readonly Clarification[];
  orgChecks?: readonly OrgCheck[];
  components?: readonly ComponentVersion[];
  locators?: readonly LocatorEntry[];
  manualTests?: readonly ManualTestCase[];
  snapshotEnvironment?: 'LIVE' | 'FIXTURE';
}

/** Section kinds that state approved requirements. Prose, scope and assumption blocks are context only. */
const APPROVED_KINDS = new Set(['ac', 'rule', 'nfr', 'scenario']);
/** Analysis findings that make a section's meaning contested. ORG_* findings are represented by org checks. */
const CONTESTING = new Set(['CONFLICT', 'AMBIGUITY']);
/** Component types worth citing as declared configuration. */
const CITABLE_TYPES = new Set([
  'SObject',
  'Field',
  'RecordType',
  'ValidationRule',
  'DuplicateRule',
  'ObjectPermissions',
  'FieldPermissions',
  'Flow',
  'ApexTrigger',
  'Layout',
  'Profile',
  'PermissionSet',
]);

export class EvidenceIndex {
  private readonly items = new Map<string, EvidenceRecord>();
  readonly refs: RefIndex;

  constructor(readonly input: EvidenceIndexInput) {
    this.refs = new RefIndex(input.docs);
    this.build();
  }

  /** Canonical id for a raw citation (accepts unqualified unique section refs like `AC2`), or undefined. */
  resolve(raw: string): string | undefined {
    const id = raw.trim();
    if (this.items.has(id)) return id;
    const ci = [...this.items.keys()].find((k) => k.toUpperCase() === id.toUpperCase());
    if (ci) return ci;
    const q = this.refs.resolve(id);
    return q && this.items.has(q) ? q : undefined;
  }

  get(raw: string): EvidenceRecord | undefined {
    const id = this.resolve(raw);
    return id ? this.items.get(id) : undefined;
  }

  all(): EvidenceRecord[] {
    return [...this.items.values()];
  }

  /** Qualified section refs of a requirement (`SF-219#AC2`). */
  sectionsOf(req: Requirement): string[] {
    const out: string[] = [];
    for (const s of req.sources) {
      if (!s.section) continue;
      const doc = this.input.docs.find((d) => d.source.ref === s.ref || d.docId === s.ref);
      const q = doc ? `${doc.docId}#${s.section}` : this.refs.resolve(s.section);
      if (q && this.items.has(q) && !out.includes(q)) out.push(q);
    }
    return out;
  }

  private add(r: EvidenceRecord): void {
    this.items.set(r.id, r);
  }

  private build(): void {
    const { docs, requirements, findings = [], clarifications = [] } = this.input;
    const reqsBySection = new Map<string, string[]>();
    for (const r of requirements) {
      for (const s of r.sources) {
        if (!s.section) continue;
        const doc = docs.find((d) => d.source.ref === s.ref || d.docId === s.ref);
        const q = doc ? `${doc.docId}#${s.section}` : this.refs.resolve(s.section);
        if (!q) continue;
        reqsBySection.set(q, [...(reqsBySection.get(q) ?? []), r.id]);
      }
    }
    const contest = new Map<string, string[]>();
    const mark = (rawRef: string, why: string): void => {
      const q = this.refs.resolve(rawRef);
      if (q) contest.set(q, [...(contest.get(q) ?? []), why]);
    };
    for (const f of findings) {
      if (CONTESTING.has(f.kind)) for (const ref of f.refs) mark(ref, `${f.id} ${f.kind.toLowerCase()}`);
    }
    for (const c of clarifications) {
      if (c.status === 'OPEN' || c.status === 'ASSUMED') {
        for (const ref of c.refs)
          mark(ref, `${c.id} ${c.status === 'OPEN' ? 'unanswered' : 'answered only by assumption'}`);
      }
    }

    for (const doc of docs) {
      if (doc.source.type === 'manual-test') continue;
      for (const sec of doc.sections) {
        const id = `${doc.docId}#${sec.ref}`;
        const why = contest.get(id) ?? [];
        let level: EvidenceLevel = 'APPROVED_REQUIREMENT';
        let reason = `${sec.kind} section of ${doc.docId}`;
        if (!APPROVED_KINDS.has(sec.kind)) {
          level = 'UNKNOWN_OR_CONTRADICTORY';
          reason = `${sec.kind} block (context only, not an approved requirement)`;
        } else if (why.length) {
          level = 'UNKNOWN_OR_CONTRADICTORY';
          reason = `contested: ${why.join('; ')}`;
        }
        this.add({
          id,
          kind: 'requirement-section',
          text: `${sec.heading ?? ''} ${sec.text}`.trim(),
          level,
          reason,
          refs: [id],
          requirementIds: reqsBySection.get(id) ?? [],
        });
      }
    }

    for (const c of this.input.orgChecks ?? []) {
      this.add({
        id: c.id,
        kind: 'org-check',
        text: `${c.subject}. ${c.orgFact} ${c.evidence.map((e) => `${e.apiName}: ${e.detail}`).join('; ')}`,
        level: c.evidenceLevel,
        reason: `org cross-check ${c.result} (${c.check})`,
        refs: c.refs.map((r) => this.refs.resolve(r)).filter((r): r is string => r !== undefined),
        requirementIds: [...c.requirementIds],
        environment: c.environment,
      });
    }

    for (const cv of this.input.components ?? []) {
      if (!CITABLE_TYPES.has(cv.type) || cv.apiName.endsWith('*')) continue;
      const { level, reason } = componentLevel(cv);
      this.add({
        id: `${cv.type}:${cv.apiName}`,
        kind: 'component',
        text: componentText(cv),
        level,
        reason,
        refs: [],
        requirementIds: [],
        ...(this.input.snapshotEnvironment ? { environment: this.input.snapshotEnvironment } : {}),
      });
    }

    for (const l of this.input.locators ?? []) {
      this.add({
        id: `LOC:${l.page}/${l.element}`,
        kind: 'locator',
        text: `${l.page}: ${l.accessibleName ?? l.element} (${l.role ?? l.strategy})${l.fieldApiName ? ` → ${l.fieldApiName}` : ''}`,
        level: 'OBSERVED_ONLY',
        reason: `UI observation by ${l.verifiedBy} (${l.status})`,
        refs: [],
        requirementIds: [],
      });
    }

    for (const t of this.input.manualTests ?? []) {
      this.add({
        id: t.id,
        kind: 'manual-test',
        text: `${t.title}. ${t.steps.join(' ')} Expected: ${t.expected ?? ''}`,
        level: 'OBSERVED_ONLY',
        reason: 'existing manual test (human-authored expectation, not a requirement)',
        refs: t.requirementRefs.map((r) => this.refs.resolve(r)).filter((r): r is string => r !== undefined),
        requirementIds: [],
      });
    }
  }
}

function componentLevel(cv: ComponentVersion): { level: EvidenceLevel; reason: string } {
  if (cv.evidenceStatus === 'UNKNOWN')
    return { level: 'UNKNOWN_OR_CONTRADICTORY', reason: 'component unreadable (UNKNOWN)' };
  if (cv.evidenceStatus === 'OBSERVED') return { level: 'OBSERVED_ONLY', reason: 'observed, not declared' };
  if (
    (cv.type === 'ValidationRule' || cv.type === 'DuplicateRule' || cv.type === 'Flow') &&
    cv.body?.active === false
  ) {
    return { level: 'UNKNOWN_OR_CONTRADICTORY', reason: `${cv.type} is inactive: it enforces nothing today` };
  }
  return { level: 'DECLARED_CONFIG', reason: `declared ${cv.type} in snapshot ${cv.snapshotId}` };
}

const s = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';

/** Citable text of a component: only metadata the hash covers, never record data. */
export function componentText(cv: ComponentVersion): string {
  const b = cv.body ?? {};
  const head = `${cv.type} ${cv.apiName}${cv.label ? ` (${cv.label})` : ''}`;
  switch (cv.type) {
    case 'ValidationRule':
      return `${head}: active=${s(b.active)}; condition ${s(b.errorConditionFormula)}; error message "${s(b.errorMessage)}"${b.errorDisplayField ? ` on ${s(b.errorDisplayField)}` : ''}`;
    case 'Field': {
      const pick = Array.isArray(b.picklistValues)
        ? (b.picklistValues as { value?: unknown; active?: unknown }[])
            .filter((p) => p.active !== false)
            .map((p) => s(p.value))
            .join(', ')
        : '';
      return `${head}: type=${s(b.type)}${b.length ? ` length=${s(b.length)}` : ''} required=${s(b.required)} nillable=${s(b.nillable)}${pick ? ` values: ${pick}` : ''}${Array.isArray(b.referenceTo) ? ` references ${(b.referenceTo as unknown[]).map(s).join('/')}` : ''}`;
    }
    case 'ObjectPermissions':
      return `${head}: create=${s(b.create)} read=${s(b.read)} edit=${s(b.edit)} delete=${s(b.delete)}`;
    case 'DuplicateRule':
    case 'Flow':
      return `${head}: active=${s(b.active)}`;
    default:
      return head;
  }
}
