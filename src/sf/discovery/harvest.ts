import { createHash } from 'node:crypto';
import { z } from 'zod';
import { formulaFieldRefs, type RelationshipMap } from './formula.js';
import type { ComponentType, Dependency, DiscoveredComponent } from './types.js';

/** Observe-only Salesforce surface discovery needs (GuardedSalesforce satisfies it; tests may fake it). */
export interface SfReader {
  query<T = Record<string, unknown>>(soql: string, opts?: { tooling?: boolean }): Promise<T[]>;
  describe(sobject: string): Promise<Record<string, unknown>>;
  describeGlobal(): Promise<Record<string, unknown>>;
}

export interface HarvestContext {
  sf: SfReader;
  objects: string[];
  components: DiscoveredComponent[];
  dependencies: Dependency[];
  /** Filled by the describe harvester: object API name → relationships, labels. */
  relationships: Map<string, RelationshipMap>;
  labels: Map<string, string>;
  /** Tooling CustomField Id (15-char) → `Object.Field__c`, to resolve MetadataComponentDependency rows. */
  fieldIds: Map<string, string>;
  mapLimit: <T, R>(items: readonly T[], fn: (item: T) => Promise<R>) => Promise<R[]>;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean => v === true;
const inList = (names: readonly string[]): string => names.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',');
const id15 = (id: string): string => id.slice(0, 15);

function add(ctx: HarvestContext, c: DiscoveredComponent): void {
  ctx.components.push(c);
}
function dep(ctx: HarvestContext, d: Dependency): void {
  ctx.dependencies.push(d);
}

// ------------------------------------------------------------------ describe: objects, fields, record types
const DescribeField = z.looseObject({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  length: z.number().optional(),
  precision: z.number().optional(),
  scale: z.number().optional(),
  nillable: z.boolean().optional(),
  createable: z.boolean().optional(),
  updateable: z.boolean().optional(),
  defaultedOnCreate: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  unique: z.boolean().optional(),
  externalId: z.boolean().optional(),
  calculated: z.boolean().optional(),
  calculatedFormula: z.string().nullable().optional(),
  custom: z.boolean().optional(),
  referenceTo: z.array(z.string()).optional(),
  relationshipName: z.string().nullable().optional(),
  restrictedPicklist: z.boolean().optional(),
  dependentPicklist: z.boolean().optional(),
  controllerName: z.string().nullable().optional(),
  inlineHelpText: z.string().nullable().optional(),
  picklistValues: z
    .array(
      z.looseObject({
        value: z.string(),
        label: z.string().nullable().optional(),
        active: z.boolean().optional(),
        defaultValue: z.boolean().optional(),
        validFor: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
const Describe = z.looseObject({
  name: z.string(),
  label: z.string(),
  labelPlural: z.string().optional(),
  keyPrefix: z.string().nullable().optional(),
  custom: z.boolean().optional(),
  createable: z.boolean().optional(),
  updateable: z.boolean().optional(),
  deletable: z.boolean().optional(),
  queryable: z.boolean().optional(),
  fields: z.array(DescribeField),
  recordTypeInfos: z
    .array(
      z.looseObject({
        name: z.string(),
        developerName: z.string().optional(),
        active: z.boolean().optional(),
        available: z.boolean().optional(),
        master: z.boolean().optional(),
        defaultRecordTypeMapping: z.boolean().optional(),
      }),
    )
    .optional(),
  childRelationships: z
    .array(
      z.looseObject({
        childSObject: z.string(),
        field: z.string(),
        relationshipName: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

/** Decode a dependent picklist `validFor` bitmap into the controlling values it is valid for. */
export function decodeValidFor(validFor: string, controllingValues: readonly string[]): string[] {
  const bytes = Buffer.from(validFor, 'base64');
  const out: string[] = [];
  controllingValues.forEach((v, i) => {
    const byte = bytes[i >> 3] ?? 0;
    if ((byte & (0x80 >> (i % 8))) !== 0) out.push(v);
  });
  return out;
}

export async function harvestDescribe(ctx: HarvestContext): Promise<number> {
  let n = 0;
  for (const object of ctx.objects) {
    const d = Describe.parse(await ctx.sf.describe(object));
    ctx.labels.set(d.name, d.label);
    const rels: RelationshipMap = new Map();
    for (const f of d.fields) {
      if (f.relationshipName && f.referenceTo?.[0]) {
        rels.set(f.relationshipName.toLowerCase(), { field: f.name, target: f.referenceTo[0] });
      }
    }
    ctx.relationships.set(d.name, rels);
    add(ctx, {
      type: 'SObject',
      apiName: d.name,
      label: d.label,
      body: {
        label: d.label,
        labelPlural: d.labelPlural ?? null,
        keyPrefix: d.keyPrefix ?? null,
        custom: bool(d.custom),
        createable: bool(d.createable),
        updateable: bool(d.updateable),
        deletable: bool(d.deletable),
        queryable: bool(d.queryable),
        childRelationships: (d.childRelationships ?? []).map((c) => `${c.childSObject}.${c.field}`).sort(),
      },
      evidenceStatus: 'DECLARED',
    });
    n++;
    const controllerValues = new Map<string, string[]>();
    for (const f of d.fields) {
      if (f.type === 'boolean') controllerValues.set(f.name, ['false', 'true']);
      else if (f.picklistValues?.length)
        controllerValues.set(
          f.name,
          f.picklistValues.map((p) => p.value),
        );
    }
    for (const f of d.fields) {
      const required =
        f.nillable === false && f.createable !== false && f.defaultedOnCreate !== true && f.type !== 'boolean';
      const controller = f.controllerName ?? null;
      const picklist = f.picklistValues?.length
        ? f.picklistValues.map((p) => ({
            value: p.value,
            label: p.label ?? p.value,
            active: p.active !== false,
            default: p.defaultValue === true,
            ...(controller && p.validFor
              ? { validFor: decodeValidFor(p.validFor, controllerValues.get(controller) ?? []) }
              : {}),
          }))
        : undefined;
      add(ctx, {
        type: 'Field',
        apiName: `${d.name}.${f.name}`,
        label: f.label,
        parent: d.name,
        body: {
          label: f.label,
          type: f.type,
          length: f.length ?? 0,
          precision: f.precision ?? 0,
          scale: f.scale ?? 0,
          required,
          nillable: f.nillable !== false,
          createable: f.createable !== false,
          updateable: f.updateable !== false,
          defaultValue: f.defaultValue ?? null,
          unique: bool(f.unique),
          externalId: bool(f.externalId),
          calculated: bool(f.calculated),
          formula: f.calculatedFormula ?? null,
          custom: bool(f.custom),
          referenceTo: f.referenceTo ?? [],
          relationshipName: f.relationshipName ?? null,
          restrictedPicklist: bool(f.restrictedPicklist),
          controller,
          helpText: f.inlineHelpText ?? null,
          ...(picklist ? { picklistValues: picklist } : {}),
        },
        evidenceStatus: 'DECLARED',
      });
      n++;
      dep(ctx, {
        fromType: 'Field',
        fromName: `${d.name}.${f.name}`,
        toType: 'SObject',
        toName: d.name,
        kind: 'field-of',
        source: 'describe',
      });
      for (const target of f.referenceTo ?? []) {
        dep(ctx, {
          fromType: 'Field',
          fromName: `${d.name}.${f.name}`,
          toType: 'SObject',
          toName: target,
          kind: 'lookup',
          source: 'describe',
        });
      }
      if (controller) {
        dep(ctx, {
          fromType: 'Field',
          fromName: `${d.name}.${f.name}`,
          toType: 'Field',
          toName: `${d.name}.${controller}`,
          kind: 'controlled-by',
          source: 'describe',
        });
      }
      if (f.calculatedFormula) {
        for (const ref of formulaFieldRefs(
          f.calculatedFormula,
          d.name,
          rels,
          (o) => ctx.relationships.get(o) ?? (new Map() as RelationshipMap),
        ).fields) {
          dep(ctx, {
            fromType: 'Field',
            fromName: `${d.name}.${f.name}`,
            toType: 'Field',
            toName: ref,
            kind: 'references',
            source: 'formula',
          });
        }
      }
    }
    for (const rt of d.recordTypeInfos ?? []) {
      const dev = rt.developerName ?? rt.name;
      add(ctx, {
        type: 'RecordType',
        apiName: `${d.name}.${dev}`,
        label: rt.name,
        parent: d.name,
        body: {
          name: rt.name,
          active: rt.active !== false,
          available: rt.available !== false,
          master: bool(rt.master),
          defaultMapping: bool(rt.defaultRecordTypeMapping),
        },
        evidenceStatus: 'DECLARED',
      });
      n++;
    }
  }
  return n;
}

const GlobalDescribe = z.looseObject({
  sobjects: z.array(z.looseObject({ name: z.string(), label: z.string(), customSetting: z.boolean().optional() })),
});

export async function harvestCustomMetadata(ctx: HarvestContext): Promise<number> {
  const g = GlobalDescribe.parse(await ctx.sf.describeGlobal());
  let n = 0;
  for (const o of g.sobjects) {
    const type: ComponentType | undefined = o.name.endsWith('__mdt')
      ? 'CustomMetadataType'
      : o.customSetting === true
        ? 'CustomSetting'
        : undefined;
    if (!type) continue;
    add(ctx, { type, apiName: o.name, label: o.label, body: { label: o.label }, evidenceStatus: 'DECLARED' });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ Tooling: validation rules, Apex, flows, UI
const VrRow = z.looseObject({
  Id: z.string(),
  ValidationName: z.string(),
  Active: z.boolean().optional(),
  Description: z.string().nullable().optional(),
  ErrorDisplayField: z.string().nullable().optional(),
  ErrorMessage: z.string().nullable().optional(),
  EntityDefinition: z.looseObject({ QualifiedApiName: z.string() }).nullable().optional(),
});
const VrMeta = z.looseObject({
  Metadata: z
    .looseObject({
      errorConditionFormula: z.string().nullable().optional(),
      errorMessage: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export async function harvestValidationRules(ctx: HarvestContext): Promise<number> {
  const rows = (
    await ctx.sf.query(
      `SELECT Id, ValidationName, Active, Description, ErrorDisplayField, ErrorMessage, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName IN (${inList(ctx.objects)})`,
      { tooling: true },
    )
  ).map((r) => VrRow.parse(r));
  const formulas = await ctx.mapLimit(rows, async (r) => {
    const m = await ctx.sf.query(`SELECT Id, Metadata FROM ValidationRule WHERE Id = '${r.Id}'`, { tooling: true });
    return VrMeta.parse(m[0] ?? {}).Metadata?.errorConditionFormula ?? null;
  });
  rows.forEach((r, i) => {
    const object = r.EntityDefinition?.QualifiedApiName ?? 'Unknown';
    const formula = formulas[i] ?? null;
    const apiName = `${object}.${r.ValidationName}`;
    add(ctx, {
      type: 'ValidationRule',
      apiName,
      label: r.ValidationName,
      parent: object,
      body: {
        active: r.Active !== false,
        description: r.Description ?? null,
        errorDisplayField: r.ErrorDisplayField ?? null,
        errorMessage: r.ErrorMessage ?? null,
        errorConditionFormula: formula,
        sfId: id15(r.Id),
      },
      evidenceStatus: 'DECLARED',
    });
    dep(ctx, {
      fromType: 'ValidationRule',
      fromName: apiName,
      toType: 'SObject',
      toName: object,
      kind: 'validates',
      source: 'formula',
    });
    if (formula) {
      const refs = formulaFieldRefs(
        formula,
        object,
        ctx.relationships.get(object) ?? (new Map() as RelationshipMap),
        (o) => ctx.relationships.get(o) ?? (new Map() as RelationshipMap),
      );
      for (const f of refs.fields) {
        dep(ctx, {
          fromType: 'ValidationRule',
          fromName: apiName,
          toType: 'Field',
          toName: f,
          kind: 'references',
          source: 'formula',
        });
      }
    }
    if (r.ErrorDisplayField) {
      dep(ctx, {
        fromType: 'ValidationRule',
        fromName: apiName,
        toType: 'Field',
        toName: `${object}.${r.ErrorDisplayField}`,
        kind: 'error-on',
        source: 'formula',
      });
    }
  });
  return rows.length;
}

const TriggerRow = z.looseObject({
  Id: z.string(),
  Name: z.string(),
  TableEnumOrId: z.string(),
  NamespacePrefix: z.string().nullable().optional(),
  Status: z.string().optional(),
  ApiVersion: z.number().optional(),
  Body: z.string().nullable().optional(),
});
const EVENTS = [
  'BeforeInsert',
  'AfterInsert',
  'BeforeUpdate',
  'AfterUpdate',
  'BeforeDelete',
  'AfterDelete',
  'AfterUndelete',
];

export async function harvestApex(ctx: HarvestContext): Promise<number> {
  let n = 0;
  const triggers = await ctx.sf.query(
    `SELECT Id, Name, TableEnumOrId, NamespacePrefix, Status, ApiVersion, ${EVENTS.map((e) => `Usage${e}`).join(', ')}, Body FROM ApexTrigger WHERE TableEnumOrId IN (${inList(ctx.objects)})`,
    { tooling: true },
  );
  for (const raw of triggers) {
    const t = TriggerRow.parse(raw);
    const apiName = `${t.TableEnumOrId}.${t.Name}`;
    add(ctx, {
      type: 'ApexTrigger',
      apiName,
      label: t.Name,
      parent: t.TableEnumOrId,
      version: t.ApiVersion !== undefined ? String(t.ApiVersion) : undefined,
      body: {
        status: t.Status ?? null,
        apiVersion: t.ApiVersion ?? null,
        events: EVENTS.filter((e) => raw[`Usage${e}`] === true),
        bodyHash: sha(t.Body ?? ''),
        namespace: t.NamespacePrefix ?? null,
        sfId: id15(t.Id),
      },
      evidenceStatus: 'DECLARED',
    });
    dep(ctx, {
      fromType: 'ApexTrigger',
      fromName: apiName,
      toType: 'SObject',
      toName: t.TableEnumOrId,
      kind: 'trigger-on',
      source: 'apex',
    });
    n++;
  }
  const classes = await ctx.sf.query(
    'SELECT Id, Name, NamespacePrefix, ApiVersion, Status, Body FROM ApexClass WHERE NamespacePrefix = null',
    { tooling: true },
  );
  for (const raw of classes) {
    const c = z
      .looseObject({
        Id: z.string(),
        Name: z.string(),
        ApiVersion: z.number().optional(),
        Status: z.string().optional(),
        Body: z.string().nullable().optional(),
      })
      .parse(raw);
    const body = c.Body ?? '';
    add(ctx, {
      type: 'ApexClass',
      apiName: c.Name,
      label: c.Name,
      version: c.ApiVersion !== undefined ? String(c.ApiVersion) : undefined,
      body: {
        status: c.Status ?? null,
        apiVersion: c.ApiVersion ?? null,
        bodyHash: sha(body),
        isTest: /@isTest/i.test(body),
        // Objects named in the class body (heuristic, for impact only — never asserted)
        mentions: ctx.objects.filter((o) => new RegExp(`\\b${o}\\b`).test(body)),
        sfId: id15(c.Id),
      },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  return n;
}

const FlowDef = z.looseObject({
  Id: z.string(),
  ApiName: z.string(),
  Label: z.string().optional(),
  ProcessType: z.string().nullable().optional(),
  TriggerType: z.string().nullable().optional(),
  TriggerObjectOrEventLabel: z.string().nullable().optional(),
  IsActive: z.boolean().optional(),
  ActiveVersionId: z.string().nullable().optional(),
  LatestVersionId: z.string().nullable().optional(),
  RecordTriggerType: z.string().nullable().optional(),
  NamespacePrefix: z.string().nullable().optional(),
});

interface FlowRefs {
  objects: { object: string; kind: string }[];
  fields: { field: string; kind: string }[];
  triggerObject?: string;
}

/** Objects and fields a flow version reads or writes (start, record lookups/creates/updates/deletes). */
export function flowRefs(meta: Record<string, unknown>): FlowRefs {
  const out: FlowRefs = { objects: [], fields: [] };
  const start = meta['start'] as Record<string, unknown> | undefined;
  const startObject = str(start?.['object']);
  if (startObject) {
    out.triggerObject = startObject;
    out.objects.push({ object: startObject, kind: 'flow-on' });
    for (const f of (start?.['filters'] as Record<string, unknown>[] | undefined) ?? []) {
      const field = str(f['field']);
      if (field) out.fields.push({ field: `${startObject}.${field}`, kind: 'flow-reads-field' });
    }
  }
  const sections: [string, string, string][] = [
    ['recordLookups', 'flow-reads', 'flow-reads-field'],
    ['recordCreates', 'flow-writes', 'flow-writes-field'],
    ['recordUpdates', 'flow-writes', 'flow-writes-field'],
    ['recordDeletes', 'flow-writes', 'flow-reads-field'],
  ];
  for (const [key, objKind, fieldKind] of sections) {
    for (const el of (meta[key] as Record<string, unknown>[] | undefined) ?? []) {
      const object = str(el['object']) ?? startObject;
      if (!object) continue;
      out.objects.push({ object, kind: objKind });
      for (const a of (el['inputAssignments'] as Record<string, unknown>[] | undefined) ?? []) {
        const field = str(a['field']);
        if (field) out.fields.push({ field: `${object}.${field}`, kind: fieldKind });
      }
      for (const f of (el['filters'] as Record<string, unknown>[] | undefined) ?? []) {
        const field = str(f['field']);
        if (field) out.fields.push({ field: `${object}.${field}`, kind: 'flow-reads-field' });
      }
      for (const q of (el['queriedFields'] as unknown[] | undefined) ?? []) {
        if (typeof q === 'string') out.fields.push({ field: `${object}.${q}`, kind: 'flow-reads-field' });
      }
    }
  }
  return out;
}

export async function harvestFlows(ctx: HarvestContext): Promise<number> {
  const defs = (
    await ctx.sf.query(
      'SELECT Id, ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel, IsActive, ActiveVersionId, LatestVersionId, RecordTriggerType, NamespacePrefix FROM FlowDefinitionView',
    )
  ).map((r) => FlowDef.parse(r));
  const scopeLabels = new Map([...ctx.labels].map(([api, label]) => [label.toLowerCase(), api]));
  const inScope = (d: z.infer<typeof FlowDef>): boolean =>
    !d.NamespacePrefix &&
    d.IsActive === true &&
    !!d.ActiveVersionId &&
    scopeLabels.has((d.TriggerObjectOrEventLabel ?? '').toLowerCase());
  const metas = await ctx.mapLimit(defs, async (d) => {
    if (!inScope(d) || !d.ActiveVersionId) return undefined;
    const rows = await ctx.sf.query(`SELECT Id, Metadata FROM Flow WHERE Id = '${d.ActiveVersionId}'`, {
      tooling: true,
    });
    const m = (rows[0])?.['Metadata'];
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : undefined;
  });
  defs.forEach((d, i) => {
    const meta = metas[i];
    const refs = meta ? flowRefs(meta) : undefined;
    const apiName = d.NamespacePrefix ? `${d.NamespacePrefix}__${d.ApiName}` : d.ApiName;
    const triggerObject =
      refs?.triggerObject ?? scopeLabels.get((d.TriggerObjectOrEventLabel ?? '').toLowerCase()) ?? null;
    add(ctx, {
      type: 'Flow',
      apiName,
      label: d.Label ?? d.ApiName,
      ...(triggerObject ? { parent: triggerObject } : {}),
      body: {
        label: d.Label ?? null,
        processType: d.ProcessType ?? null,
        triggerType: d.TriggerType ?? null,
        triggerObjectLabel: d.TriggerObjectOrEventLabel ?? null,
        recordTriggerType: d.RecordTriggerType ?? null,
        isActive: d.IsActive === true,
        activeVersionId: d.ActiveVersionId ? id15(d.ActiveVersionId) : null,
        latestVersionId: d.LatestVersionId ? id15(d.LatestVersionId) : null,
        namespace: d.NamespacePrefix ?? null,
        ...(meta
          ? {
              metadataHash: sha(JSON.stringify(meta)),
              objects: [...new Set(refs?.objects.map((o) => o.object))].sort(),
              fields: [...new Set(refs?.fields.map((f) => f.field))].sort(),
            }
          : {}),
        sfId: id15(d.Id),
      },
      evidenceStatus: 'DECLARED',
    });
    for (const o of refs?.objects ?? [])
      dep(ctx, {
        fromType: 'Flow',
        fromName: apiName,
        toType: 'SObject',
        toName: o.object,
        kind: o.kind,
        source: 'flow',
      });
    for (const f of refs?.fields ?? [])
      dep(ctx, { fromType: 'Flow', fromName: apiName, toType: 'Field', toName: f.field, kind: f.kind, source: 'flow' });
  });
  return defs.length;
}

export async function harvestUiBundles(ctx: HarvestContext): Promise<number> {
  let n = 0;
  const lwc = await ctx.sf.query(
    'SELECT Id, DeveloperName, NamespacePrefix, ApiVersion, IsExposed, MasterLabel, LastModifiedDate FROM LightningComponentBundle WHERE NamespacePrefix = null',
    { tooling: true },
  );
  for (const r of lwc) {
    const name = str(r['DeveloperName']) ?? 'unknown';
    add(ctx, {
      type: 'LightningComponentBundle',
      apiName: name,
      label: str(r['MasterLabel']) ?? name,
      body: {
        apiVersion: r['ApiVersion'] ?? null,
        isExposed: bool(r['IsExposed']),
        lastModified: r['LastModifiedDate'] ?? null,
      },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  const aura = await ctx.sf.query(
    'SELECT Id, DeveloperName, NamespacePrefix, ApiVersion, MasterLabel, LastModifiedDate FROM AuraDefinitionBundle WHERE NamespacePrefix = null',
    { tooling: true },
  );
  for (const r of aura) {
    const name = str(r['DeveloperName']) ?? 'unknown';
    add(ctx, {
      type: 'AuraDefinitionBundle',
      apiName: name,
      label: str(r['MasterLabel']) ?? name,
      body: { apiVersion: r['ApiVersion'] ?? null, lastModified: r['LastModifiedDate'] ?? null },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  return n;
}

interface LayoutItem {
  field?: string;
  behavior?: string;
}

export async function harvestLayouts(ctx: HarvestContext): Promise<number> {
  const rows = await ctx.sf.query(
    `SELECT Id, Name, TableEnumOrId, NamespacePrefix FROM Layout WHERE TableEnumOrId IN (${inList(ctx.objects)})`,
    { tooling: true },
  );
  const metas = await ctx.mapLimit(rows, async (r) => {
    const m = await ctx.sf.query(`SELECT Id, Metadata FROM Layout WHERE Id = '${str(r['Id']) ?? ''}'`, {
      tooling: true,
    });
    return (m[0])?.['Metadata'] as Record<string, unknown> | undefined;
  });
  rows.forEach((r, i) => {
    const object = str(r['TableEnumOrId']) ?? 'Unknown';
    const name = str(r['Name']) ?? 'unknown';
    const meta = metas[i] ?? {};
    const items: LayoutItem[] = [];
    for (const s of (meta['layoutSections'] as Record<string, unknown>[] | undefined) ?? []) {
      for (const col of (s['layoutColumns'] as Record<string, unknown>[] | undefined) ?? []) {
        for (const it of (col['layoutItems'] as LayoutItem[] | undefined) ?? []) if (it.field) items.push(it);
      }
    }
    const relatedLists = ((meta['relatedLists'] as Record<string, unknown>[] | undefined) ?? [])
      .map((rl) => str(rl['relatedList']))
      .filter((x): x is string => !!x)
      .sort();
    const apiName = `${object}.${name}`;
    add(ctx, {
      type: 'Layout',
      apiName,
      label: name,
      parent: object,
      body: {
        fields: items
          .map((it) => ({ field: it.field ?? '', behavior: it.behavior ?? 'Edit' }))
          .sort((a, b) => a.field.localeCompare(b.field)),
        relatedLists,
        sfId: id15(str(r['Id']) ?? ''),
      },
      evidenceStatus: 'DECLARED',
    });
    for (const it of items) {
      dep(ctx, {
        fromType: 'Layout',
        fromName: apiName,
        toType: 'Field',
        toName: `${object}.${it.field ?? ''}`,
        kind: 'layout-field',
        source: 'layout',
      });
    }
  });
  return rows.length;
}

export async function harvestFlexiPages(ctx: HarvestContext): Promise<number> {
  const rows = await ctx.sf.query(
    `SELECT Id, DeveloperName, MasterLabel, Type, EntityDefinitionId, NamespacePrefix, LastModifiedDate FROM FlexiPage WHERE EntityDefinitionId IN (${inList(ctx.objects)})`,
    { tooling: true },
  );
  for (const r of rows) {
    const name = str(r['DeveloperName']) ?? 'unknown';
    const object = str(r['EntityDefinitionId']);
    add(ctx, {
      type: 'FlexiPage',
      apiName: name,
      label: str(r['MasterLabel']) ?? name,
      ...(object ? { parent: object } : {}),
      body: { type: r['Type'] ?? null, entity: object ?? null, lastModified: r['LastModifiedDate'] ?? null },
      evidenceStatus: 'DECLARED',
    });
  }
  return rows.length;
}

/** CustomField ids for scope objects, so MetadataComponentDependency rows (which carry ids) resolve to API names. */
export async function harvestCustomFieldIds(ctx: HarvestContext): Promise<number> {
  const rows = await ctx.sf.query(
    `SELECT Id, DeveloperName, TableEnumOrId FROM CustomField WHERE TableEnumOrId IN (${inList(ctx.objects)})`,
    { tooling: true },
  );
  for (const r of rows) {
    const idv = str(r['Id']);
    const obj = str(r['TableEnumOrId']);
    const dev = str(r['DeveloperName']);
    if (idv && obj && dev) ctx.fieldIds.set(id15(idv), `${obj}.${dev}__c`);
  }
  return rows.length;
}

const MCD_TYPES: Record<string, string> = {
  CustomField: 'Field',
  CustomObject: 'SObject',
  StandardEntity: 'SObject',
  ApexClass: 'ApexClass',
  ApexTrigger: 'ApexTrigger',
  Flow: 'Flow',
  Layout: 'Layout',
  FlexiPage: 'FlexiPage',
  LightningComponentBundle: 'LightningComponentBundle',
  AuraDefinitionBundle: 'AuraDefinitionBundle',
  ValidationRule: 'ValidationRule',
};

export async function harvestDependencies(ctx: HarvestContext): Promise<number> {
  const rows = await ctx.sf.query(
    'SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency',
    { tooling: true },
  );
  const byId = new Map<string, { type: string; apiName: string }>();
  for (const c of ctx.components) {
    const sfId = str(c.body['sfId']);
    if (sfId) byId.set(sfId, { type: c.type, apiName: c.apiName });
  }
  const resolve = (idv: unknown, name: unknown, type: unknown): { type: string; name: string } => {
    const id = typeof idv === 'string' ? id15(idv) : '';
    const known = byId.get(id);
    if (known) return { type: known.type, name: known.apiName };
    const field = ctx.fieldIds.get(id);
    if (field) return { type: 'Field', name: field };
    const t = str(type) ?? 'Unknown';
    return { type: MCD_TYPES[t] ?? t, name: str(name) ?? id };
  };
  let n = 0;
  for (const r of rows) {
    const from = resolve(r['MetadataComponentId'], r['MetadataComponentName'], r['MetadataComponentType']);
    const to = resolve(r['RefMetadataComponentId'], r['RefMetadataComponentName'], r['RefMetadataComponentType']);
    dep(ctx, {
      fromType: from.type,
      fromName: from.name,
      toType: to.type,
      toName: to.name,
      kind: 'depends-on',
      source: 'MetadataComponentDependency',
    });
    n++;
  }
  return n;
}

// ------------------------------------------------------------------ security: profiles, permission sets, FLS/CRUD, sharing
interface PermParent {
  Name?: string;
  IsOwnedByProfile?: boolean;
  Profile?: { Name?: string } | null;
}
function owner(parent: PermParent | null | undefined): string | undefined {
  if (!parent?.Name) return undefined;
  return parent.IsOwnedByProfile ? `Profile:${parent.Profile?.Name ?? parent.Name}` : `PermissionSet:${parent.Name}`;
}

export async function harvestSecurity(ctx: HarvestContext): Promise<number> {
  let n = 0;
  for (const r of await ctx.sf.query('SELECT Id, Name, UserType, UserLicense.Name FROM Profile')) {
    const name = str(r['Name']) ?? 'unknown';
    const lic = r['UserLicense'] as { Name?: string } | null | undefined;
    add(ctx, {
      type: 'Profile',
      apiName: name,
      label: name,
      body: { userType: r['UserType'] ?? null, license: lic?.Name ?? null },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  for (const r of await ctx.sf.query(
    'SELECT Id, Name, Label, IsOwnedByProfile, IsCustom, NamespacePrefix, Type FROM PermissionSet WHERE IsOwnedByProfile = false',
  )) {
    const ns = str(r['NamespacePrefix']);
    const name = `${ns ? `${ns}__` : ''}${str(r['Name']) ?? 'unknown'}`;
    add(ctx, {
      type: 'PermissionSet',
      apiName: name,
      label: str(r['Label']) ?? name,
      body: {
        label: r['Label'] ?? null,
        isCustom: bool(r['IsCustom']),
        namespace: ns ?? null,
        type: r['Type'] ?? null,
      },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  try {
    for (const r of await ctx.sf.query('SELECT Id, DeveloperName, MasterLabel, Status FROM PermissionSetGroup')) {
      const name = str(r['DeveloperName']) ?? 'unknown';
      add(ctx, {
        type: 'PermissionSetGroup',
        apiName: name,
        label: str(r['MasterLabel']) ?? name,
        body: { label: r['MasterLabel'] ?? null, status: r['Status'] ?? null },
        evidenceStatus: 'DECLARED',
      });
      n++;
    }
  } catch {
    add(ctx, {
      type: 'PermissionSetGroup',
      apiName: '*',
      body: { reason: 'PermissionSetGroup not queryable' },
      evidenceStatus: 'UNKNOWN',
    });
  }
  const objectPerms = await ctx.sf.query(
    `SELECT Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, PermissionsCreate, PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE SobjectType IN (${inList(ctx.objects)})`,
  );
  let hiddenParents = 0;
  for (const r of objectPerms) {
    const who = owner(r['Parent'] as PermParent | null);
    const object = str(r['SobjectType']) ?? 'Unknown';
    if (!who) {
      hiddenParents++;
      continue;
    }
    add(ctx, {
      type: 'ObjectPermissions',
      apiName: `${who}.${object}`,
      parent: object,
      body: {
        create: bool(r['PermissionsCreate']),
        read: bool(r['PermissionsRead']),
        edit: bool(r['PermissionsEdit']),
        delete: bool(r['PermissionsDelete']),
        viewAll: bool(r['PermissionsViewAllRecords']),
        modifyAll: bool(r['PermissionsModifyAllRecords']),
      },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  if (hiddenParents) {
    // Rows whose parent we cannot see: recorded as UNKNOWN, never as "no access".
    for (const o of ctx.objects) {
      add(ctx, {
        type: 'ObjectPermissions',
        apiName: `Hidden:*.${o}`,
        parent: o,
        body: { reason: `${hiddenParents} rows with an inaccessible parent` },
        evidenceStatus: 'UNKNOWN',
      });
    }
  }
  const fieldPerms = await ctx.sf.query(
    `SELECT Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType IN (${inList(ctx.objects)})`,
  );
  const grouped = new Map<string, Record<string, string>>();
  for (const r of fieldPerms) {
    const who = owner(r['Parent'] as PermParent | null);
    const object = str(r['SobjectType']) ?? 'Unknown';
    const field = str(r['Field']);
    if (!who || !field) continue;
    const key = `${who}.${object}`;
    const g = grouped.get(key) ?? {};
    g[field] = bool(r['PermissionsEdit']) ? 'RE' : bool(r['PermissionsRead']) ? 'R' : '-';
    grouped.set(key, g);
  }
  for (const [key, fields] of grouped) {
    const object = key.slice(key.lastIndexOf('.') + 1);
    const sorted = Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
    add(ctx, {
      type: 'FieldPermissions',
      apiName: key,
      parent: object,
      body: { fields: sorted },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  // Org-wide defaults (sharing) → onto the SObject components
  const owd = await ctx.sf.query(
    `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName IN (${inList(ctx.objects)})`,
  );
  for (const r of owd) {
    const obj = ctx.components.find((c) => c.type === 'SObject' && c.apiName === str(r['QualifiedApiName']));
    if (obj)
      obj.body['sharing'] = {
        internal: r['InternalSharingModel'] ?? null,
        external: r['ExternalSharingModel'] ?? null,
      };
  }
  for (const r of await ctx.sf.query(
    `SELECT Id, DeveloperName, MasterLabel, SobjectType, IsActive, NamespacePrefix FROM DuplicateRule WHERE SobjectType IN (${inList(ctx.objects)})`,
  )) {
    const object = str(r['SobjectType']) ?? 'Unknown';
    const name = str(r['DeveloperName']) ?? 'unknown';
    add(ctx, {
      type: 'DuplicateRule',
      apiName: `${object}.${name}`,
      label: str(r['MasterLabel']) ?? name,
      parent: object,
      body: { label: r['MasterLabel'] ?? null, active: bool(r['IsActive']) },
      evidenceStatus: 'DECLARED',
    });
    n++;
  }
  return n;
}
