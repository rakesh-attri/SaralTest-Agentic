import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { matches, type SoqlQuery } from './soql.js';
import type { FixtureStore, ObjectDef } from './store.js';

/**
 * Offline metadata for discovery tests (FIXTURE only). `entities` holds Tooling/REST setup rows keyed by entity name
 * (ValidationRule, FlowDefinitionView, ObjectPermissions, …); queries against those entities are answered from here
 * with a minimal WHERE/projection, never with real Salesforce semantics.
 */
export const FixtureMetadata = z.object({
  _comment: z.string().optional(),
  entities: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  recordTypes: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).default({}),
  /** Extra global-describe entries (custom metadata types, custom settings) beyond the seed objects. */
  globalExtras: z.array(z.record(z.string(), z.unknown())).default([]),
});
export type FixtureMetadata = z.infer<typeof FixtureMetadata>;

export function loadFixtureMetadata(file: string): FixtureMetadata {
  if (!existsSync(file)) return { entities: {}, recordTypes: {}, globalExtras: [] };
  return FixtureMetadata.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function pick(row: Record<string, unknown>, path: string): unknown {
  let cur: unknown = row;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    const obj = cur as Record<string, unknown>;
    const key = Object.keys(obj).find((k) => k.toLowerCase() === part.toLowerCase());
    cur = key ? obj[key] : null;
  }
  return cur ?? null;
}

function put(out: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = out;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) {
      cur[p] = value;
      return;
    }
    const next = cur[p];
    if (next === null || typeof next !== 'object') {
      const created: Record<string, unknown> = {};
      cur[p] = created;
      cur = created;
    } else {
      cur = next as Record<string, unknown>;
    }
  });
}

export function hasEntity(meta: FixtureMetadata, entity: string): boolean {
  return Object.keys(meta.entities).some((k) => k.toLowerCase() === entity.toLowerCase());
}

export function queryMetadata(
  meta: FixtureMetadata,
  q: SoqlQuery,
): { totalSize: number; records: Record<string, unknown>[] } {
  const key = Object.keys(meta.entities).find((k) => k.toLowerCase() === q.object.toLowerCase()) ?? q.object;
  let rows = (meta.entities[key] ?? []).filter((r) =>
    q.where.every((c) => {
      const v = pick(r, c.field);
      return matches(typeof v === 'boolean' ? String(v) : v, c);
    }),
  );
  if (q.count) return { totalSize: rows.length, records: [] };
  if (q.limit !== undefined) rows = rows.slice(0, q.limit);
  return {
    totalSize: rows.length,
    records: rows.map((r) => {
      const out: Record<string, unknown> = { attributes: { type: key } };
      for (const f of q.fields) put(out, f, pick(r, f));
      return out;
    }),
  };
}

const SF_TYPE: Record<string, string> = {
  id: 'id',
  string: 'string',
  email: 'email',
  phone: 'phone',
  picklist: 'picklist',
  reference: 'reference',
  datetime: 'datetime',
  boolean: 'boolean',
  double: 'double',
};

/** Salesforce-shaped describe built from the fixture object model (enough for discovery; FIXTURE only). */
export function describeSf(store: FixtureStore, meta: FixtureMetadata, def: ObjectDef): Record<string, unknown> {
  const children = store.seed.objects.flatMap((o) =>
    o.fields
      .filter((f) => f['referenceTo'] === def.name)
      .map((f) => ({ childSObject: o.name, field: f.name, relationshipName: `${o.name}s`, cascadeDelete: false })),
  );
  return {
    name: def.name,
    label: def.label,
    labelPlural: `${def.label}s`,
    keyPrefix: def.keyPrefix,
    custom: def.name.endsWith('__c'),
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: def.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: SF_TYPE[f.type] ?? 'string',
      length: f.length ?? 0,
      nillable: f.required !== true && f.type !== 'id',
      createable: f.createable ?? true,
      updateable: f.createable ?? true,
      defaultedOnCreate: false,
      unique: false,
      externalId: false,
      calculated: false,
      custom: f.name.endsWith('__c'),
      referenceTo: f.referenceTo ? [f.referenceTo] : [],
      relationshipName: f.relationshipName ?? null,
      picklistValues: (f.picklistValues ?? []).map((v) => ({ value: v, label: v, active: true, defaultValue: false })),
      restrictedPicklist: f.type === 'picklist',
      dependentPicklist: false,
      controllerName: null,
    })),
    recordTypeInfos: meta.recordTypes[def.name] ?? [
      {
        name: 'Master',
        developerName: 'Master',
        master: true,
        active: true,
        available: true,
        defaultRecordTypeMapping: true,
        recordTypeId: '012000000000000AAA',
      },
    ],
    childRelationships: children,
  };
}

export function describeGlobalSf(store: FixtureStore, meta: FixtureMetadata): Record<string, unknown> {
  return {
    encoding: 'UTF-8',
    sobjects: [
      ...store.seed.objects.map((o) => ({
        name: o.name,
        label: o.label,
        keyPrefix: o.keyPrefix,
        custom: o.name.endsWith('__c'),
        customSetting: false,
        queryable: true,
      })),
      ...meta.globalExtras,
    ],
  };
}
