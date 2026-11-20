import type { AnalysisFinding, EvidenceEntry, Requirement } from '../../core/schemas/index.js';
import type { ComponentVersion } from '../../core/schemas/knowledge.js';
import type { StoredSnapshot } from '../../knowledge/snapshotStore.js';
import { linkAssets } from '../../sf/graph/assetLinks.js';
import { OrgCrossCheck, type OrgCheck, type OrgCheckKind, type OrgCheckResult } from './schema.js';

type C = ComponentVersion;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrase = (term: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(term)}(?![A-Za-z0-9_])`, 'i');

/** Actor words that are not personas ("User" alone says nothing about security). */
const GENERIC_PERSONAS = new Set(['user', 'users', 'system', 'customer', 'admin user']);

class Index {
  readonly objects = new Map<string, C>();
  readonly fields = new Map<string, C[]>();
  readonly byKey = new Map<string, C>();
  constructor(readonly snap: StoredSnapshot) {
    for (const c of snap.components) {
      this.byKey.set(`${c.type}|${c.apiName}`, c);
      if (c.type === 'SObject' && c.evidenceStatus !== 'UNKNOWN') this.objects.set(c.apiName, c);
      if (c.type === 'Field' && c.parent && c.evidenceStatus !== 'UNKNOWN') {
        const list = this.fields.get(c.parent) ?? [];
        list.push(c);
        this.fields.set(c.parent, list);
      }
    }
  }
  of(type: string): C[] {
    return this.snap.components.filter((c) => c.type === type && c.evidenceStatus !== 'UNKNOWN');
  }
  get(type: string, apiName: string): C | undefined {
    const c = this.byKey.get(`${type}|${apiName}`);
    return c?.evidenceStatus === 'UNKNOWN' ? undefined : c;
  }
  /** True when an area that would contain `type` on `object` could not be read. */
  unknown(type: string, object?: string): boolean {
    return (
      this.byKey.get(`${type}|*`)?.evidenceStatus === 'UNKNOWN' ||
      (object !== undefined && this.byKey.get(`${type}|${object}.*`)?.evidenceStatus === 'UNKNOWN')
    );
  }
  rulesReferencing(field: C): C[] {
    const name = field.apiName.split('.')[1] ?? '';
    return this.of('ValidationRule').filter(
      (v) => v.parent === field.parent && phrase(name).test(str(v.body?.['errorConditionFormula']) ?? ''),
    );
  }
}

function requirementText(r: Requirement): string {
  return [
    r.title,
    r.businessObjective,
    ...r.actions,
    ...r.businessRules,
    ...r.expectedOutcomes,
    ...r.preconditions,
    ...r.dataRequirements,
  ]
    .filter(Boolean)
    .join('\n');
}

function refsOf(r: Requirement, text: string): string[] {
  const fromSources = r.sources.map((s) => s.section).filter((s): s is string => !!s);
  const fromText = [...text.matchAll(/\b(AC-?\d+|[A-Z]{2,4}-\d{2,3})\b/g)].map((m) => m[1] ?? '');
  return [...new Set([...fromSources, ...fromText].filter(Boolean))];
}

export interface CrossCheckInput {
  snapshot: StoredSnapshot;
  requirements: readonly Requirement[];
  findings?: readonly AnalysisFinding[];
  /** Profiles / persona ids configured in personas.yaml (for persona checks). */
  configuredPersonas?: readonly string[];
}

/**
 * Deterministic org cross-check (requirement-analysis skill step 4): existence of referenced components, required /
 * format / allowed-value claims vs schema + validation rules + layouts, duplicate rules, personas vs profiles,
 * permission claims vs CRUD, and the update mechanism behind timing claims. Questions follow the skill format:
 * `[ref] ambiguity. The org currently … Test impact: …`.
 */
export function crossCheckRequirements(input: CrossCheckInput): OrgCrossCheck {
  const idx = new Index(input.snapshot);
  const env = input.snapshot.info.environment;
  const snapshotId = input.snapshot.info.id;
  const scope = input.snapshot.info.objects;
  const checks: OrgCheck[] = [];
  const merged = new Map<string, OrgCheck>();

  const push = (
    key: string,
    r: Requirement,
    refs: string[],
    c: {
      check: OrgCheckKind;
      subject: string;
      result: OrgCheckResult;
      orgFact: string;
      evidence?: OrgCheck['evidence'];
      question?: string;
      findingIds?: string[];
    },
  ): void => {
    const existing = merged.get(key);
    if (existing) {
      existing.requirementIds = [...new Set([...existing.requirementIds, r.id])];
      existing.refs = [...new Set([...existing.refs, ...refs])];
      existing.findingIds = [...new Set([...existing.findingIds, ...(c.findingIds ?? [])])];
      return;
    }
    const settled = c.result === 'EXISTS' || c.result === 'CONSISTENT';
    const check: OrgCheck = {
      id: `OC-${String(checks.length + 1).padStart(3, '0')}`,
      check: c.check,
      subject: c.subject,
      result: c.result,
      evidenceLevel: settled ? 'DECLARED_CONFIG' : 'UNKNOWN_OR_CONTRADICTORY',
      orgFact: c.orgFact,
      evidence: c.evidence ?? [],
      requirementIds: [r.id],
      refs,
      findingIds: c.findingIds ?? [],
      ...(c.question && !settled ? { question: c.question } : {}),
      snapshotId,
      environment: env,
    };
    merged.set(key, check);
    checks.push(check);
  };

  const ev = (c: C, detail: string): OrgCheck['evidence'][number] => ({
    componentType: c.type,
    apiName: c.apiName,
    detail,
  });
  const tag = (refs: string[], r: Requirement): string => `[${(refs.length ? refs : [r.id]).join(', ')}]`;

  for (const r of input.requirements) {
    const text = requirementText(r);
    const refs = refsOf(r, text);
    const linkedFindings = (input.findings ?? []).filter((f) => f.requirementIds.includes(r.id));
    const findingText = linkedFindings
      .filter((f) => f.kind === 'ORG_CHECK_NEEDED')
      .map((f) => f.text)
      .join('\n');
    const named = [...idx.objects.values()].filter(
      (o) =>
        phrase(o.apiName).test(text) ||
        phrase(o.label ?? o.apiName).test(text) ||
        phrase(str(o.body?.['labelPlural']) ?? `${o.label ?? o.apiName}s`).test(text),
    );
    const candidates = (named.length ? named : [...idx.objects.values()]).map((o) => o.apiName);
    // Linked fields carry the term the text actually used (an org may relabel Phone as "Business Phone").
    const termOf = new Map<string, string>();
    const linked = linkAssets([{ type: 'Requirement', id: r.id, label: r.id, text }], input.snapshot.components)
      .edges.filter((e) => e.to.startsWith('Field:'))
      .map((e) => {
        const f = idx.get('Field', e.to.slice('Field:'.length));
        if (f && e.evidence) termOf.set(f.apiName, e.evidence);
        return f;
      })
      .filter((c): c is C => !!c);
    const termFor = (f: C): string => termOf.get(f.apiName) ?? f.label ?? f.apiName;
    // The object the requirement is mostly about (most mentions) — e.g. the record being saved.
    const mainObject = [...named]
      .map((o) => ({ o, n: [...text.matchAll(new RegExp(phrase(o.label ?? o.apiName).source, 'gi'))].length }))
      .sort((a, b) => b.n - a.n)[0]?.o;

    // (1) existence of custom API names (story text + ORG_CHECK_NEEDED findings)
    const apiNames = new Set(
      [...`${text}\n${findingText}`.matchAll(/\b([A-Za-z][A-Za-z0-9_]*__(?:c|mdt|e|x))\b/g)].map((m) => m[1] ?? ''),
    );
    for (const name of apiNames) {
      const fIds = linkedFindings.filter((f) => f.text.includes(name)).map((f) => f.id);
      const dotted = name.includes('.') ? name : undefined;
      const field = candidates.map((o) => idx.get('Field', dotted ?? `${o}.${name}`)).find(Boolean);
      const obj = idx.get('SObject', name) ?? idx.get('CustomSetting', name) ?? idx.get('CustomMetadataType', name);
      const outOfScope = [
        ...text.matchAll(/\b(Account|Contact|Opportunity|Lead|Case|Campaign|Order|Contract|Asset|Product2|Quote)\b/g),
      ]
        .map((m) => m[1] ?? '')
        .filter((o) => !scope.includes(o));
      if (field) {
        push(`exist|${field.apiName}`, r, refs, {
          check: 'existence',
          subject: `${field.apiName} exists`,
          result: 'EXISTS',
          orgFact: `${field.apiName} exists (type ${str(field.body?.['type']) ?? '?'}${field.body?.['calculated'] === true ? ', formula' : ''}${field.body?.['createable'] === false ? ', read-only' : ''})`,
          evidence: [ev(field, `type=${str(field.body?.['type']) ?? '?'}`)],
          findingIds: fIds,
        });
      } else if (obj) {
        push(`exist|${obj.apiName}`, r, refs, {
          check: 'existence',
          subject: `${obj.apiName} exists`,
          result: 'EXISTS',
          orgFact: `${obj.type} ${obj.apiName} exists`,
          evidence: [ev(obj, obj.type)],
          findingIds: fIds,
        });
      } else if (candidates.some((o) => idx.unknown('Field', o))) {
        push(`exist|${name}`, r, refs, {
          check: 'existence',
          subject: `${name} exists`,
          result: 'UNKNOWN',
          orgFact: `fields of ${candidates.join(', ')} could not be read`,
          question: `${tag(refs, r)} ${name} could not be verified because the fields of ${candidates.join(', ')} were not readable. Who can confirm it exists?`,
          findingIds: fIds,
        });
      } else {
        const searched = candidates.reduce((n, o) => n + (idx.fields.get(o)?.length ?? 0), 0);
        const outside = outOfScope.length
          ? ` (the text also names ${[...new Set(outOfScope)].join(', ')}, outside this discovery)`
          : '';
        push(`exist|${name}`, r, refs, {
          check: 'existence',
          subject: `${name} exists on ${candidates.join(' / ')}`,
          result: 'NOT_FOUND',
          orgFact: `no field ${name} on ${candidates.join(', ')} (${searched} fields searched, describe as ${input.snapshot.info.persona ?? 'admin'})${outside}`,
          question: `${tag(refs, r)} The requirement references ${name}, but the org has no such field on ${candidates.join(' or ')}. Is it a new field this story must deliver, or is a different existing field meant? Test impact: tests that read or assert ${name} stay REVIEW_REQUIRED until this is answered.`,
          findingIds: fIds,
        });
      }
    }

    // (2) required claims
    const requiredPhrases = [
      ...text.matchAll(/\b([A-Z][\w ]{1,40}?) (?:is|are|must be) (?:required|mandatory)\b/g),
      ...text.matchAll(/\bleave (?:the )?([A-Z][\w ]{1,30}?) (?:field )?(?:empty|blank)\b/gi),
      ...text.matchAll(/\b([A-Z][\w ]{1,30}?) (?:field )?is (?:left )?(?:empty|blank)\b/g),
    ].map((m) => (m[1] ?? '').trim());
    for (const p of new Set(requiredPhrases)) {
      const field = candidates
        .flatMap((o) => idx.fields.get(o) ?? [])
        .find(
          (f) =>
            (f.label ?? '').toLowerCase() === p.toLowerCase().replace(/^the /, '') ||
            (f.apiName.split('.')[1] ?? '').toLowerCase() === p.toLowerCase(),
        );
      if (!field) continue;
      const evidence: OrgCheck['evidence'] = [];
      if (field.body?.['required'] === true) evidence.push(ev(field, 'required in the schema (nillable = false)'));
      for (const l of idx.of('Layout').filter((x) => x.parent === field.parent)) {
        const items = (l.body?.['fields'] as { field?: string; behavior?: string }[] | undefined) ?? [];
        if (items.some((i) => i.field === field.apiName.split('.')[1] && i.behavior === 'Required'))
          evidence.push(ev(l, 'Required on this page layout (UI only)'));
      }
      for (const v of idx.rulesReferencing(field)) {
        if (
          /ISBLANK|ISNULL|LEN\s*\(/i.test(str(v.body?.['errorConditionFormula']) ?? '') &&
          v.body?.['active'] === true
        )
          evidence.push(ev(v, 'active validation rule blocks blank values'));
      }
      push(`required|${field.apiName}`, r, refs, {
        check: 'required',
        subject: `${field.label ?? field.apiName} is required`,
        result: evidence.length ? 'CONSISTENT' : 'CONFLICT',
        orgFact: evidence.length
          ? evidence.map((e) => `${e.apiName}: ${e.detail}`).join('; ')
          : `${field.apiName} is optional in the schema, not required on any layout, and no active validation rule blocks blank values`,
        evidence,
        question: `${tag(refs, r)} ${field.label ?? field.apiName} is described as required, but the org does not enforce it today (${field.apiName} is optional; no layout or validation rule requires it). Must this story add the rule, or is it already enforced elsewhere? Test impact: the "${field.label ?? ''} required" negative test is REVIEW_REQUIRED until confirmed.`,
      });
    }

    // (3) format claims
    for (const field of linked) {
      const type = str(field.body?.['type']);
      const label = termFor(field);
      if (type === 'email' && /valid email|email (?:address )?format|not a valid email/i.test(text)) {
        push(`format|${field.apiName}`, r, refs, {
          check: 'format',
          subject: `${label} format is validated`,
          result: 'CONSISTENT',
          orgFact: `${field.apiName} is an Email-type field: Salesforce rejects syntactically invalid addresses on save`,
          evidence: [ev(field, 'type=email')],
        });
      }
      const digits = new RegExp(
        `${escapeRe(label)}[^.\\n]{0,80}?(\\d+)\\s*digits|(\\d+)\\s*digits[^.\\n]{0,40}?${escapeRe(label)}|not (\\d+) digits`,
        'i',
      ).exec(text);
      if ((type === 'phone' || type === 'string') && digits && phrase(label).test(text)) {
        const rules = idx
          .rulesReferencing(field)
          .filter((v) => /REGEX|LEN\s*\(|ISNUMBER/i.test(str(v.body?.['errorConditionFormula']) ?? ''));
        push(`format|${field.apiName}`, r, refs, {
          check: 'format',
          subject: `${label} must have ${digits[1] ?? digits[2] ?? digits[3] ?? '?'} digits`,
          result: rules.length ? 'CONSISTENT' : 'CONFLICT',
          orgFact: rules.length
            ? rules.map((v) => `${v.apiName}: ${str(v.body?.['errorConditionFormula']) ?? ''}`).join('; ')
            : `${field.apiName} is a ${type}-type field with no validation rule checking its format (${type === 'phone' ? 'phone fields accept any text' : 'free text'})`,
          evidence: rules.map((v) => ev(v, 'active format rule')),
          question: `${tag(refs, r)} ${label} must be ${digits[1] ?? digits[2] ?? digits[3] ?? '?'} digits, but no validation rule enforces a format on ${field.apiName} today. Is the rule part of this story's delivery, and what is the exact error message? Test impact: the negative format test cannot assert an error message until then.`,
        });
      }
    }

    // (4) duplicate rules
    if (/duplicate/i.test(text)) {
      for (const o of mainObject ? [mainObject] : []) {
        const rules = idx.of('DuplicateRule').filter((d) => d.parent === o.apiName);
        const active = rules.filter((d) => d.body?.['active'] === true);
        const unknown = idx.unknown('DuplicateRule');
        push(`dup|${o.apiName}`, r, refs, {
          check: 'duplicate-rule',
          subject: `an active duplicate rule exists on ${o.apiName}`,
          result: unknown ? 'UNKNOWN' : active.length ? 'CONSISTENT' : 'CONFLICT',
          orgFact: unknown
            ? 'duplicate rules could not be read'
            : active.length
              ? `active: ${active.map((d) => d.label ?? d.apiName).join(', ')}`
              : rules.length
                ? `${o.apiName} has ${rules.length} duplicate rule(s), none active (${rules.map((d) => d.label ?? d.apiName).join(', ')})`
                : `${o.apiName} has no duplicate rule`,
          evidence: (active.length ? active : rules).map((d) =>
            ev(d, d.body?.['active'] === true ? 'active' : 'inactive'),
          ),
          question: `${tag(refs, r)} The requirement expects a duplicate warning on ${o.apiName}, but ${active.length ? '' : 'no active duplicate rule exists there today'}. Will this story activate or create one (which matching rule: same Email on the same Account)? Test impact: the duplicate-warning test is REVIEW_REQUIRED until confirmed.`,
        });
      }
    }

    // (5) personas vs profiles / permission sets, (6) permission claims vs CRUD
    const profiles = idx.of('Profile');
    const permSets = idx.of('PermissionSet');
    for (const persona of new Set([...r.personas, ...r.actors].filter((p) => !GENERIC_PERSONAS.has(p.toLowerCase())))) {
      const bare = persona.replace(/\s+users?$/i, '').toLowerCase();
      const profile = profiles.find((p) => [persona.toLowerCase(), bare].includes(p.apiName.toLowerCase()));
      const ps = permSets.find((p) => [persona.toLowerCase(), bare].includes((p.label ?? p.apiName).toLowerCase()));
      const configured = (input.configuredPersonas ?? []).some((c) => c.toLowerCase() === persona.toLowerCase());
      if (profile || ps) {
        const c = (profile ?? ps) as C;
        push(`persona|${persona}`, r, refs, {
          check: 'persona',
          subject: `persona "${persona}" maps to org security`,
          result: 'EXISTS',
          orgFact: `${c.type} "${c.apiName}" exists${configured ? '' : '; no test user for it in personas.yaml yet'}`,
          evidence: [ev(c, c.type)],
        });
      } else {
        push(`persona|${persona}`, r, refs, {
          check: 'persona',
          subject: `persona "${persona}" maps to org security`,
          result: 'UNKNOWN',
          orgFact: `no profile or permission set is named "${persona}" (${profiles.length} profiles, ${permSets.length} permission sets discovered)`,
          question: `${tag(refs, r)} Which profile or permission set defines a "${persona}" in this org? None is named that way. Test impact: permission and visibility tests for "${persona}" stay BLOCKED-NO-PERSONA until a test user exists.`,
        });
      }
      if (!profile) continue;
      for (const o of named) {
        const perm = idx.get('ObjectPermissions', `Profile:${profile.apiName}.${o.apiName}`);
        const denies = new RegExp(`cannot (?:create|edit|add)[^.\\n]{0,40}${escapeRe(o.label ?? o.apiName)}`, 'i').test(
          text,
        );
        if (!denies) continue;
        if (!perm) {
          push(`perm|${profile.apiName}|${o.apiName}`, r, refs, {
            check: 'permission',
            subject: `${profile.apiName} cannot create or edit ${o.apiName}`,
            result:
              idx.unknown('ObjectPermissions') || idx.get('ObjectPermissions', `Hidden:*.${o.apiName}`)
                ? 'UNKNOWN'
                : 'CONSISTENT',
            orgFact: `no object permission row grants ${profile.apiName} access to ${o.apiName}`,
          });
          continue;
        }
        const create = perm.body?.['create'] === true;
        const edit = perm.body?.['edit'] === true;
        push(`perm|${profile.apiName}|${o.apiName}`, r, refs, {
          check: 'permission',
          subject: `${profile.apiName} cannot create or edit ${o.apiName}`,
          result: create || edit ? 'CONFLICT' : 'CONSISTENT',
          orgFact: `profile ${profile.apiName} on ${o.apiName}: read=${String(perm.body?.['read'] === true)}, create=${String(create)}, edit=${String(edit)}`,
          evidence: [ev(perm, `create=${String(create)} edit=${String(edit)}`)],
          question: `${tag(refs, r)} ${profile.apiName} should not create or edit ${o.apiName}, but the profile grants create=${String(create)}, edit=${String(edit)}. Which is correct? Test impact: the read-only negative test cannot pass as written.`,
        });
      }
    }

    // (7) picklist values named in the text
    for (const field of linked.filter((f) => Array.isArray(f.body?.['picklistValues']))) {
      const label = field.label ?? field.apiName;
      const m = new RegExp(
        `${escapeRe(label)}\\s*(?:is|=|equals|of)\\s*['"‘“]?([A-Za-z][\\w -]{0,30}?)['"’”]?(?=[\\s,.;)]|$)`,
        'i',
      ).exec(text);
      if (!m?.[1]) continue;
      const values = (field.body?.['picklistValues'] as { value: string; active: boolean }[])
        .filter((v) => v.active)
        .map((v) => v.value);
      const value = m[1].trim();
      const hit = values.find((v) => v.toLowerCase() === value.toLowerCase());
      push(`pick|${field.apiName}|${value}`, r, refs, {
        check: 'picklist-value',
        subject: `${label} has the value "${value}"`,
        result: hit ? 'CONSISTENT' : 'CONFLICT',
        orgFact: hit
          ? `"${hit}" is an active value of ${field.apiName}`
          : `${field.apiName} has no active value "${value}" (values: ${values.slice(0, 12).join(', ')}${values.length > 12 ? ', …' : ''})`,
        evidence: [ev(field, `${values.length} active values`)],
        question: `${tag(refs, r)} The requirement uses ${label} = "${value}", which is not an active value of ${field.apiName}. Which value is meant? Test impact: data recipes cannot use "${value}".`,
      });
    }

    // (8) allowed values (approved list)
    if (/approved list|allowed values|list of (?:allowed|approved)|from a (?:fixed |predefined )?list/i.test(text)) {
      for (const field of linked) {
        const isPick = Array.isArray(field.body?.['picklistValues']) && field.body['restrictedPicklist'] === true;
        const rules = idx.rulesReferencing(field).filter((v) => v.body?.['active'] === true);
        if (!phrase(field.label ?? '').test(text.split(/approved list|allowed values|list of/i)[0]?.slice(-120) ?? ''))
          continue;
        push(`allowed|${field.apiName}`, r, refs, {
          check: 'allowed-values',
          subject: `${field.label ?? field.apiName} is limited to an approved list`,
          result: isPick || rules.length ? 'CONSISTENT' : 'CONFLICT',
          orgFact: isPick
            ? `${field.apiName} is a restricted picklist`
            : rules.length
              ? `validation rule(s) ${rules.map((v) => v.apiName).join(', ')} reference ${field.apiName}`
              : `${field.apiName} is a free-text ${str(field.body?.['type']) ?? ''} field (length ${typeof field.body?.['length'] === 'number' ? field.body['length'] : '?'}) with no restricting validation rule`,
          evidence: [
            ev(field, `type=${str(field.body?.['type']) ?? '?'}`),
            ...rules.map((v) => ev(v, 'references the field')),
          ],
          question: `${tag(refs, r)} ${field.label ?? ''} must come from an approved list, but in the org it is free text with no restriction. Where is the list maintained, and will this story add the restriction? Test impact: valid/invalid value tests need the list.`,
        });
      }
    }

    // (9) mechanism behind timing claims ("immediately", "automatically")
    if (/\b(immediately|automatically|real[- ]time|instantly)\b/i.test(text)) {
      const targets = [...apiNames]
        .map((n) => candidates.map((o) => idx.get('Field', `${o}.${n}`)).find(Boolean))
        .filter((f): f is C => !!f);
      for (const f of targets) {
        // Objects whose records can change this field: its own object and children with a lookup to it.
        const related = new Set([
          f.parent ?? '',
          ...idx
            .of('Field')
            .filter((x) => ((x.body?.['referenceTo'] as string[] | undefined) ?? []).includes(f.parent ?? ''))
            .map((x) => x.parent ?? ''),
        ]);
        const writers = [
          ...idx.of('Flow').filter((fl) => ((fl.body?.['fields'] as string[] | undefined) ?? []).includes(f.apiName)),
          ...idx.of('ApexTrigger').filter((t) => related.has(t.parent ?? '')),
        ];
        const formula = f.body?.['calculated'] === true;
        push(`mech|${f.apiName}`, r, refs, {
          check: 'mechanism',
          subject: `what keeps ${f.apiName} up to date`,
          result: formula || writers.some((w) => w.type === 'Flow') ? 'CONSISTENT' : 'UNKNOWN',
          orgFact: formula
            ? `${f.apiName} is a formula/summary field (computed on read)`
            : writers.length
              ? writers
                  .map(
                    (w) =>
                      `${w.type} ${w.apiName}${w.type === 'Flow' ? ` writes it (${str(w.body?.['triggerType']) ?? 'flow'})` : ' may update it (Apex body not analysed)'}`,
                  )
                  .join('; ')
              : `no flow, trigger or formula found that writes ${f.apiName}`,
          evidence: writers.map((w) => ev(w, 'writes the field')),
          question: `${tag(refs, r)} The requirement says ${f.apiName} updates immediately, but no flow, trigger or formula that maintains it was found. What updates it? Test impact: timing assertions stay REVIEW_REQUIRED.`,
        });
      }
    }
  }

  const counts = { EXISTS: 0, CONSISTENT: 0, NOT_FOUND: 0, CONFLICT: 0, UNKNOWN: 0 } as Record<OrgCheckResult, number>;
  for (const c of checks) counts[c.result]++;
  return OrgCrossCheck.parse({
    snapshotId,
    orgId: input.snapshot.info.orgId,
    environment: env,
    objects: scope,
    checks,
    counts,
  });
}

/** Unsettled checks → analysis findings (NOT_FOUND / CONFLICT / UNKNOWN with a question). */
export function crossCheckFindings(cc: OrgCrossCheck, startAt = 1): AnalysisFinding[] {
  let n = startAt;
  return cc.checks
    .filter((c) => c.result === 'NOT_FOUND' || c.result === 'CONFLICT' || (c.result === 'UNKNOWN' && c.question))
    .map((c) => ({
      id: `F-ORG-${String(n++).padStart(3, '0')}`,
      kind:
        c.result === 'NOT_FOUND'
          ? ('ORG_NOT_FOUND' as const)
          : c.result === 'CONFLICT'
            ? ('ORG_CONFLICT' as const)
            : ('ORG_CHECK_NEEDED' as const),
      text: `${c.subject}: ${c.orgFact} (${cc.environment} snapshot ${cc.snapshotId}, ${c.id})`,
      refs: c.refs.length ? c.refs : c.requirementIds,
      requirementIds: c.requirementIds,
      severity:
        c.result === 'NOT_FOUND' ? ('HIGH' as const) : c.result === 'CONFLICT' ? ('MEDIUM' as const) : ('LOW' as const),
      origin: 'org' as const,
      rule: `org-${c.check}`,
    }));
}

/** Settled checks → evidence ledger entries (DECLARED_CONFIG facts with the component as source). */
export function crossCheckEvidence(cc: OrgCrossCheck, now = new Date()): EvidenceEntry[] {
  return cc.checks
    .filter((c) => c.result === 'EXISTS' || c.result === 'CONSISTENT')
    .map((c) => ({
      id: `EV-${c.id}-${cc.snapshotId.slice(-4)}`,
      claim: `${c.subject} — ${c.orgFact}`,
      sources: [cc.snapshotId, ...c.evidence.map((e) => `${e.componentType}:${e.apiName}`)],
      agent: 'sf-intelligence',
      confidence: 1,
      environment: cc.environment,
      createdAt: now.toISOString(),
    }));
}
