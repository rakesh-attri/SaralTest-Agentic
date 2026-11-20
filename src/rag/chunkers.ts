import { createHash } from 'node:crypto';
import type { Requirement } from '../core/schemas/index.js';
import type { ManualTestCase, SourceDocument } from '../core/schemas/inputs.js';
import type { ComponentVersion } from '../core/schemas/knowledge.js';
import type { LocatorEntry } from '../knowledge/locatorRegistry.js';

/** LanceDB tables (PLAN.md §7). */
export const RAG_TABLES = [
  'requirements',
  'org_metadata',
  'test_assets',
  'defects',
  'learnings',
  'locators',
  'docs',
] as const;
export type RagTable = (typeof RAG_TABLES)[number];

export interface Chunk {
  /** Stable id: same table + source + text → same id (dedupe). */
  id: string;
  table: RagTable;
  text: string;
  org: string;
  release: string;
  type: string;
  /** Citable source (`SF-219#AC3`, `snapshot:<id>#ValidationRule:Contact.Phone_Format`, …). */
  sourceRef: string;
  /** Groups chunks of one source so a re-ingest replaces exactly that source's chunks (incremental). */
  sourceKey: string;
  /** sha256 of the text (change detection). */
  hash: string;
  confidence?: number;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function makeChunk(c: Omit<Chunk, 'id' | 'hash'>): Chunk {
  const hash = sha(c.text);
  return { ...c, hash, id: sha(`${c.table}\u0000${c.sourceRef}\u0000${hash}`).slice(0, 32) };
}

/** ≈ tokens for chunk sizing (4 chars ≈ 1 token; good enough for 500–800-token windows). */
export const approxTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * Split text into windows of `min..max` tokens with `overlap` (fraction) carried over, breaking on paragraph or
 * sentence boundaries where possible (PLAN.md §7: docs by heading, 500–800 tokens, 12% overlap).
 */
export function windowText(text: string, min = 500, max = 800, overlap = 0.12): string[] {
  if (approxTokens(text) <= max) return [text.trim()].filter(Boolean);
  const units = text.split(/(?<=[.!?])\s+|\n{2,}/).filter((u) => u.trim());
  const out: string[] = [];
  let cur: string[] = [];
  const size = (xs: string[]): number => approxTokens(xs.join(' '));
  for (const u of units) {
    if (cur.length && size([...cur, u]) > max && size(cur) >= min) {
      out.push(cur.join(' ').trim());
      const keep: string[] = [];
      for (let i = cur.length - 1; i >= 0 && size(keep) < max * overlap; i--) keep.unshift(cur[i] ?? '');
      cur = keep;
    }
    cur.push(u);
  }
  if (cur.length) out.push(cur.join(' ').trim());
  return out;
}

/**
 * Source documents: JIRA/ADO → one chunk per acceptance criterion + summary; other documents → per heading section,
 * windowed to 500–800 tokens with 12% overlap. Manual-test documents are skipped here (they arrive as test assets).
 */
export function chunkSourceDocument(doc: SourceDocument, org: string, release: string): Chunk[] {
  if (doc.source.type === 'manual-test') return [];
  const isStory = doc.source.type === 'jira' || doc.source.type === 'ado' || doc.source.type === 'chat';
  const out: Chunk[] = [];
  if (isStory) {
    for (const s of doc.sections) {
      out.push(
        makeChunk({
          table: 'requirements',
          text: `${doc.docId} ${s.ref}${s.heading ? ` — ${s.heading}` : ''}\n${s.text}`,
          org,
          release,
          type: `${doc.source.type}-${s.kind}`,
          sourceRef: `${doc.docId}#${s.ref}`,
          sourceKey: `doc:${doc.docId}`,
        }),
      );
    }
    return out;
  }
  // Group consecutive sections under their heading, then window.
  const groups = new Map<string, { refs: string[]; text: string[] }>();
  for (const s of doc.sections) {
    const g = groups.get(s.heading ?? doc.title) ?? { refs: [], text: [] };
    g.refs.push(s.ref);
    g.text.push(s.text);
    groups.set(s.heading ?? doc.title, g);
  }
  for (const [heading, g] of groups) {
    windowText(g.text.join('\n\n')).forEach((w, i) => {
      out.push(
        makeChunk({
          table: 'docs',
          text: `${doc.docId} — ${heading}\n${w}`,
          org,
          release,
          type: `${doc.source.type}-section`,
          sourceRef: `${doc.docId}#${g.refs[0] ?? heading}${i ? `+${i}` : ''}`,
          sourceKey: `doc:${doc.docId}`,
        }),
      );
    });
  }
  return out;
}

export function chunkRequirements(reqs: readonly Requirement[], org: string, release: string, runId: string): Chunk[] {
  return reqs.map((r) =>
    makeChunk({
      table: 'requirements',
      text: [
        `${r.id} ${r.title ?? ''} [${r.type}, ${r.status}, risk ${r.risk}]`,
        r.businessObjective,
        r.personas.length ? `Personas: ${r.personas.join(', ')}` : '',
        r.businessRules.length ? `Rules: ${r.businessRules.join(' | ')}` : '',
        r.expectedOutcomes.length ? `Expected: ${r.expectedOutcomes.join(' | ')}` : '',
        `Sources: ${r.sources.map((s) => s.section ?? s.ref).join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n'),
      org,
      release,
      type: 'requirement',
      sourceRef: r.id,
      sourceKey: `run:${runId}:requirements`,
    }),
  );
}

export function chunkManualTests(
  tests: readonly ManualTestCase[],
  org: string,
  release: string,
  runId: string,
): Chunk[] {
  return tests.map((t) =>
    makeChunk({
      table: 'test_assets',
      text: [
        `${t.id}: ${t.title}${t.type ? ` [${t.type}]` : ''}${t.priority ? ` ${t.priority}` : ''}`,
        t.requirementRefs.length ? `Refs: ${t.requirementRefs.join(', ')}` : 'Refs: none',
        t.preconditions.length ? `Preconditions: ${t.preconditions.join(' | ')}` : '',
        `Steps: ${t.steps.join(' / ')}`,
        t.expected ? `Expected: ${t.expected}` : '',
        `Last run: ${t.lastRun.status}${t.lastRun.date ? ` (${t.lastRun.date})` : ''}`,
      ]
        .filter(Boolean)
        .join('\n'),
      org,
      release,
      type: 'manual-test',
      sourceRef: t.id,
      sourceKey: `run:${runId}:manual-tests`,
    }),
  );
}

const pickBody = (c: ComponentVersion, keys: string[]): string =>
  keys
    .map((k) => [k, c.body?.[k]] as const)
    .filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('; ');

/**
 * Org metadata from a snapshot: one chunk per component; fields grouped per object (≤ 25 per chunk); UNKNOWN
 * placeholders are kept as explicit "could not be read" chunks so retrieval never implies absence.
 */
export function chunkSnapshot(o: {
  snapshotId: string;
  org: string;
  release: string;
  environment: 'LIVE' | 'FIXTURE';
  components: readonly ComponentVersion[];
}): Chunk[] {
  const out: Chunk[] = [];
  const env = o.environment === 'LIVE' ? '' : ` (${o.environment})`;
  const base = { org: o.org, release: o.release, table: 'org_metadata' as const, sourceKey: `snapshot:${o.org}` };
  const fieldsByObject = new Map<string, ComponentVersion[]>();
  for (const c of o.components) {
    if (c.type === 'Field' && c.parent && c.evidenceStatus !== 'UNKNOWN') {
      const l = fieldsByObject.get(c.parent) ?? [];
      l.push(c);
      fieldsByObject.set(c.parent, l);
      continue;
    }
    if (c.type === 'FieldPermissions') continue; // folded into the object summary below (too granular)
    const ref = `snapshot:${o.snapshotId}#${c.type}:${c.apiName}`;
    if (c.evidenceStatus === 'UNKNOWN') {
      out.push(
        makeChunk({
          ...base,
          type: c.type,
          sourceRef: ref,
          text: `${c.type} ${c.apiName}${env}: UNKNOWN — could not be read (${typeof c.body?.['reason'] === 'string' ? c.body['reason'] : 'no reason recorded'}). Not evidence of absence.`,
        }),
      );
      continue;
    }
    const detail: Record<string, string[]> = {
      SObject: ['label', 'labelPlural', 'custom', 'sharing', 'createable', 'deletable'],
      ValidationRule: ['active', 'errorConditionFormula', 'errorMessage', 'errorDisplayField', 'description'],
      Flow: [
        'label',
        'processType',
        'triggerType',
        'triggerObjectLabel',
        'recordTriggerType',
        'isActive',
        'objects',
        'fields',
      ],
      ApexTrigger: ['status', 'events', 'apiVersion'],
      ApexClass: ['status', 'isTest', 'mentions', 'apiVersion'],
      Layout: ['fields', 'relatedLists'],
      RecordType: ['name', 'active', 'master'],
      ObjectPermissions: ['create', 'read', 'edit', 'delete', 'viewAll', 'modifyAll'],
      DuplicateRule: ['label', 'active'],
    };
    const text = `${c.type} ${c.apiName}${c.label && c.label !== c.apiName ? ` ("${c.label}")` : ''}${env}\n${pickBody(c, detail[c.type] ?? ['label'])}`;
    out.push(makeChunk({ ...base, type: c.type, sourceRef: ref, text }));
  }
  for (const [object, fields] of fieldsByObject) {
    const sorted = [...fields].sort((a, b) => a.apiName.localeCompare(b.apiName));
    for (let i = 0; i < sorted.length; i += 25) {
      const group = sorted.slice(i, i + 25);
      const lines = group.map((f) => {
        const b = f.body ?? {};
        const flags = [
          b['required'] === true ? 'required' : '',
          b['custom'] === true ? 'custom' : '',
          b['calculated'] === true ? 'formula' : '',
        ]
          .filter(Boolean)
          .join(',');
        const picks = Array.isArray(b['picklistValues'])
          ? ` values=${(b['picklistValues'] as { value: string }[])
              .map((p) => p.value)
              .slice(0, 15)
              .join('|')}`
          : '';
        return `${f.apiName} "${f.label ?? ''}" ${typeof b['type'] === 'string' ? b['type'] : ''}${flags ? ` [${flags}]` : ''}${picks}`;
      });
      out.push(
        makeChunk({
          ...base,
          type: 'FieldGroup',
          sourceRef: `snapshot:${o.snapshotId}#Fields:${object}:${i / 25 + 1}`,
          text: `Fields of ${object}${env} (group ${i / 25 + 1})\n${lines.join('\n')}`,
        }),
      );
    }
  }
  return out;
}

export function chunkLocators(entries: readonly LocatorEntry[], release: string): Chunk[] {
  return entries.map((l) =>
    makeChunk({
      table: 'locators',
      text: `${l.page} · ${l.role ?? ''} "${l.accessibleName ?? ''}" (persona ${l.persona}, rank ${l.strategyRank}, ${l.status}${l.environment === 'LIVE' ? '' : `, ${l.environment}`})\n${l.expression}${l.fieldApiName ? `\nfield: ${l.fieldApiName}` : ''}`,
      org: l.org,
      release,
      type: 'locator',
      sourceRef: `locator:${l.page}/${l.element}`,
      sourceKey: `locators:${l.org}`,
      confidence: l.status === 'ACTIVE' ? 1 : 0.5,
    }),
  );
}
