import type {
  ComponentVersion,
  CoverageObligation,
  ManualTestCase,
  ObligationKind,
  Requirement,
} from '../../core/schemas/index.js';
import type { OrgCheck } from '../sf-intelligence/schema.js';
import { assignLevel, type EvidenceIndex } from '../../oracles/index.js';
import { resolvePersona, type ConfiguredPersona } from './personas.js';

/**
 * Coverage obligations (test-design skill, technique table): what the design MUST cover, derived by code from the
 * requirements, the org cross-check and the snapshot. The Planner drafts wording; it cannot drop an obligation.
 *
 * - every approved AC/BR/NFR section of a requirement → positive (deny for security requirements, nfr for NFRs)
 * - validation requirements → one negative per org check that settles or contests a rule (required, format,
 *   duplicate rule, allowed values), else one negative from the sections
 * - a numeric limit in the text (`80 characters`, `10 digits`) → boundary at n-1 / n / n+1
 * - security requirements → deny per non-admin persona + allow for the default persona when its access is declared
 * - an active trigger/flow on an object a data/functional requirement touches → bulk (200 records)
 * - an imported manual test with an open RE_VERIFY mark → regression (must be re-run)
 */
export interface ObligationInput {
  requirements: readonly Requirement[];
  index: EvidenceIndex;
  orgChecks: readonly OrgCheck[];
  components: readonly ComponentVersion[];
  manualTests: readonly ManualTestCase[];
  personas: readonly ConfiguredPersona[];
  defaultPersona: string;
  /** Open RE_VERIFY asset ids (`manual-test:MTC-001`). */
  reverify?: readonly string[];
}

const SECTION_KINDS = new Set(['ac', 'rule', 'nfr', 'scenario']);
const NEGATIVE_CHECKS = new Set<OrgCheck['check']>(['required', 'format', 'duplicate-rule', 'allowed-values']);

export function deriveObligations(i: ObligationInput): CoverageObligation[] {
  const out: CoverageObligation[] = [];
  const add = (
    o: Omit<CoverageObligation, 'id' | 'level' | 'levelReason' | 'values' | 'manualTestIds' | 'tier' | 'isAc'> &
      Partial<Pick<CoverageObligation, 'values' | 'manualTestIds' | 'isAc'>>,
  ): void => {
    const d = assignLevel(i.index, o.evidenceIds);
    out.push({
      ...o,
      id: `OB-${String(out.length + 1).padStart(3, '0')}`,
      values: o.values ?? [],
      manualTestIds: o.manualTestIds ?? [],
      isAc: o.isAc ?? false,
      evidenceIds: d.evidenceIds,
      level: d.level,
      ...(d.level === 'UNKNOWN_OR_CONTRADICTORY' || d.level === 'OBSERVED_ONLY' ? { levelReason: d.reason } : {}),
      tier: 'mandatory',
    });
  };
  /** Uncontested items only (added next to stronger evidence such as an org check). */
  const uncontested = (ids: string[]): string[] =>
    ids.filter((id) => i.index.get(id)?.level !== 'UNKNOWN_OR_CONTRADICTORY');
  /**
   * Evidence a step may cite: the uncontested items when there are any, otherwise the contested ones — so the case
   * still cites its source and is labelled UNKNOWN_OR_CONTRADICTORY (REVIEW_REQUIRED) instead of having nothing to cite.
   */
  const usable = (ids: string[]): string[] => {
    const ok = uncontested(ids);
    return ok.length ? ok : ids;
  };
  const shortRef = (q: string): string => q.split('#')[1] ?? q;
  const manualFor = (refs: string[]): string[] =>
    i.manualTests
      .filter((t) => t.requirementRefs.some((r) => refs.some((q) => i.index.resolve(r) === q)))
      .map((t) => t.id);

  for (const r of i.requirements) {
    const sections = i.index.sectionsOf(r).filter((q) => {
      const kind = i.index.input.docs
        .find((d) => d.docId === q.split('#')[0])
        ?.sections.find((s) => s.ref === shortRef(q))?.kind;
      return kind !== undefined && SECTION_KINDS.has(kind);
    });
    const checks = i.orgChecks.filter((c) => c.requirementIds.includes(r.id));
    const okSections = uncontested(sections);
    const outcome = r.expectedOutcomes[0];
    const acs = sections.filter((q) => /^AC\d+$/i.test(shortRef(q)));
    const primary = acs.length ? acs : sections.slice(0, 1);
    const security = r.type === 'security';
    const nfr = r.type === 'non-functional';

    // positive / deny / nfr / ui per AC (or the first section when the requirement cites no AC)
    for (const q of primary.length ? primary : ['*']) {
      const kind: ObligationKind = security ? 'deny' : nfr ? 'nfr' : r.type === 'ui' ? 'ui' : 'positive';
      const permission = security ? checks.filter((c) => c.check === 'permission') : [];
      const persona = security ? denyPersona(r, i, checks) : undefined;
      const refs = q === '*' ? [] : [q];
      add({
        requirementId: r.id,
        ref: q === '*' ? '*' : shortRef(q),
        kind,
        detail: `${kind} case for ${q === '*' ? r.id : shortRef(q)}: ${r.title ?? r.businessObjective}`,
        evidenceIds: [...usable(refs), ...permission.map((c) => c.id), ...componentsOf(permission)],
        ...(outcome ? { expectedHint: outcome } : {}),
        ...(persona ? { persona: persona.id, values: [persona.name] } : {}),
        manualTestIds: manualFor(refs),
        isAc: /^AC\d+$/i.test(shortRef(q)),
      });
    }

    // negatives for validation rules: one per org check that settles or contests a rule
    if (r.type === 'validation') {
      const negChecks = checks.filter((c) => NEGATIVE_CHECKS.has(c.check));
      if (negChecks.length) {
        for (const c of negChecks) {
          add({
            requirementId: r.id,
            ref: shortRef(c.refs.map((x) => i.index.resolve(x)).find((x): x is string => !!x) ?? primary[0] ?? '*'),
            kind: 'negative',
            detail: `negative: ${c.subject} (${c.id} ${c.result})`,
            evidenceIds: [c.id, ...componentsOf([c]), ...okSections],
            expectedHint:
              c.result === 'CONSISTENT' || c.result === 'EXISTS' ? c.orgFact : `${c.subject} — ${c.orgFact}`,
            manualTestIds: manualFor(sections),
          });
        }
      } else {
        add({
          requirementId: r.id,
          ref: shortRef(primary[0] ?? '*'),
          kind: 'negative',
          detail: `negative: invalid input for ${r.title ?? r.id} is rejected`,
          evidenceIds: usable(sections),
          ...(outcome ? { expectedHint: outcome } : {}),
          manualTestIds: manualFor(sections),
        });
      }
    }

    // boundaries from numeric limits stated in the requirement's own sections (once per limit)
    const limits = new Set<string>();
    for (const q of sections) {
      const text = i.index.get(q)?.text ?? '';
      for (const m of text.matchAll(/(\d+)\s*(characters|chars|digits)/gi)) {
        const n = Number(m[1]);
        const unit = (m[2] ?? '').toLowerCase().startsWith('dig') ? 'digits' : 'characters';
        if (limits.has(`${String(n)} ${unit}`)) continue;
        limits.add(`${String(n)} ${unit}`);
        const field = fieldFor(
          text,
          i.components,
          objectsIn(`${r.businessObjective} ${r.title ?? ''} ${text}`, i.components),
        );
        const fieldEv = field ? [`Field:${field.apiName}`] : [];
        const vr = checks.filter((c) => c.check === 'format' && c.result === 'CONSISTENT');
        add({
          requirementId: r.id,
          ref: shortRef(q),
          kind: 'boundary',
          detail: `boundary on ${field?.label ?? 'the field'}: ${String(n - 1)} / ${String(n)} / ${String(n + 1)} ${unit} (${shortRef(q)})`,
          values: [String(n - 1), String(n), String(n + 1)],
          evidenceIds: [
            ...usable([q]),
            ...(unit === 'digits' ? vr.flatMap((c) => [c.id, ...componentsOf([c])]) : fieldEv),
          ],
          expectedHint: m[0],
        });
      }
    }

    // allow for the default persona when its access is declared
    if (security) {
      const objects = objectsIn(`${r.businessObjective} ${r.title ?? ''}`, i.components);
      const admin = i.personas.find((p) => p.id === i.defaultPersona);
      const perm = admin
        ? i.components.find(
            (c) => c.type === 'ObjectPermissions' && objects.some((o) => c.apiName === `Profile:${admin.profile}.${o}`),
          )
        : undefined;
      if (perm && admin) {
        add({
          requirementId: r.id,
          ref: shortRef(primary[0] ?? '*'),
          kind: 'allow',
          detail: `allow: ${admin.id} (${admin.profile}) can perform the action`,
          persona: admin.id,
          evidenceIds: [`${perm.type}:${perm.apiName}`],
        });
      }
    }

    // bulk when automation runs on a touched object
    if (r.type === 'data' || r.type === 'functional') {
      const objects = objectsIn(`${r.businessObjective} ${r.title ?? ''} ${r.businessRules.join(' ')}`, i.components);
      const automation = i.components.filter(
        (c) =>
          (c.type === 'ApexTrigger' || c.type === 'Flow') &&
          c.body?.active !== false &&
          objects.includes(c.parent ?? ''),
      );
      const already = new Set(out.filter((o) => o.kind === 'bulk').flatMap((o) => o.values));
      const fresh = automation.filter((a) => !already.has(`${a.type}:${a.apiName}`));
      if (fresh.length) {
        add({
          requirementId: r.id,
          ref: shortRef(primary[0] ?? '*'),
          kind: 'bulk',
          detail: `bulk: 200 records through ${fresh.map((a) => a.apiName).join(', ')} (automation on ${[...new Set(fresh.map((a) => a.parent))].join(', ')})`,
          values: fresh.map((a) => `${a.type}:${a.apiName}`),
          evidenceIds: [...usable(sections), ...fresh.map((a) => `${a.type}:${a.apiName}`)],
        });
      }
    }
  }

  // regression: manual tests whose components changed (RE_VERIFY) must be re-run
  for (const mark of i.reverify ?? []) {
    const [type, id] = mark.split(':');
    if (type !== 'manual-test' || !id) continue;
    const t = i.manualTests.find((m) => m.id === id);
    if (!t) continue;
    const refs = t.requirementRefs.map((x) => i.index.resolve(x)).filter((x): x is string => !!x);
    const req = i.requirements.find((r) => i.index.sectionsOf(r).some((q) => refs.includes(q)));
    if (!req) continue;
    add({
      requirementId: req.id,
      ref: shortRef(refs[0] ?? '*'),
      kind: 'regression',
      detail: `regression: ${t.id} "${t.title}" is marked RE_VERIFY (a component it covers changed)`,
      evidenceIds: usable(refs),
      manualTestIds: [t.id],
    });
  }
  return out;
}

function componentsOf(checks: readonly OrgCheck[]): string[] {
  return checks.flatMap((c) => c.evidence.map((e) => `${e.componentType}:${e.apiName}`));
}

function denyPersona(r: Requirement, i: ObligationInput, checks: readonly OrgCheck[]) {
  const named = [
    ...r.personas,
    ...checks.filter((c) => c.check === 'persona').map((c) => /"([^"]+)"/.exec(c.subject)?.[1] ?? ''),
  ]
    .filter(Boolean)
    .filter((p) => p.toLowerCase() !== i.defaultPersona);
  const name = named[0];
  return name ? resolvePersona(name, i.personas, checks) : undefined;
}

/**
 * The field a limit is about: its label (preferred) or api name appears word-bounded in the text, within the objects
 * the requirement names; the longest (most specific) match wins ("Last Name" over "Name").
 */
function fieldFor(
  text: string,
  components: readonly ComponentVersion[],
  objects: readonly string[] = [],
): ComponentVersion | undefined {
  const lc = text.toLowerCase();
  const score = (c: ComponentVersion): number => {
    const bodyLabel = c.body?.label;
    const label = (c.label ?? (typeof bodyLabel === 'string' ? bodyLabel : '')).toLowerCase();
    const name = c.apiName.split('.')[1]?.toLowerCase() ?? '';
    if (label.length > 2 && new RegExp(`\\b${escape(label)}\\b`).test(lc)) return 100 + label.length;
    if (name.length > 3 && new RegExp(`\\b${escape(name)}\\b`).test(lc)) return name.length;
    return 0;
  };
  return components
    .filter(
      (c) => c.type === 'Field' && (!objects.length || objects.includes(c.parent ?? c.apiName.split('.')[0] ?? '')),
    )
    .map((c) => ({ c, s: score(c) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)[0]?.c;
}

function objectsIn(text: string, components: readonly ComponentVersion[]): string[] {
  const lc = text.toLowerCase();
  return components
    .filter((c) => c.type === 'SObject')
    .map((c) => c.apiName)
    .filter((o) => new RegExp(`\\b${escape(o.toLowerCase())}s?\\b`).test(lc));
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
