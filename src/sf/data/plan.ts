// Test data engine — planning (PLAN.md §7e, salesforce-test-data skill steps 1–4):
// approved recipe → snapshot facts (required fields, createable, lengths, picklists, lookups, rules) → synthetic
// values (unique per run) → full plan validation. Nothing here touches the org.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { blocksBlank } from '../../agents/sf-intelligence/crossCheck.js';
import type { OrgEntry } from '../../config/schemas.js';
import { QAError } from '../../core/errors.js';
import {
  DataPlan,
  Recipe,
  type DataPlanIssue,
  type DataPlanStep,
  type NegativePlan,
  type RecipeValue,
} from '../../core/schemas/data.js';
import type { ComponentVersion } from '../../core/schemas/knowledge.js';
import type { StoredSnapshot } from '../../knowledge/snapshotStore.js';
import { idempotencyKey } from '../../security/idempotency.js';

export const RECIPE_DIR = join('examples', 'recipes');

export interface LoadedRecipe {
  recipe: Recipe;
  /** sha256 of the file's canonical JSON (approval subject). */
  hash: string;
  file: string;
}

export function recipeHash(r: Recipe): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex').slice(0, 16);
}

export function loadRecipe(root: string, name: string): LoadedRecipe {
  if (!/^[a-z0-9-]+$/.test(name)) throw new QAError('DATA', `invalid recipe name ${name}`);
  const file = join(root, RECIPE_DIR, `${name}.yaml`);
  let raw: unknown;
  try {
    raw = parse(readFileSync(file, 'utf8')) as unknown;
  } catch (e) {
    throw new QAError('DATA', `recipe ${name} not found or unreadable (${file})`, {
      fix: `add an approved recipe at ${join(RECIPE_DIR, `${name}.yaml`)}; values are never invented from the story`,
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  const parsed = Recipe.safeParse(raw);
  if (!parsed.success) {
    throw new QAError('DATA', `recipe ${name} is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  return { recipe: parsed.data, hash: recipeHash(parsed.data), file };
}

// ------------------------------------------------------------------ snapshot facts

type C = ComponentVersion;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export interface FieldFact {
  apiName: string;
  type: string;
  length?: number;
  required: boolean;
  createable: boolean;
  picklistValues?: string[];
  restricted: boolean;
  referenceTo: string[];
}

/** Read-only view of one snapshot for data planning (UNKNOWN components never count as facts). */
export class SnapshotFacts {
  private readonly byKey = new Map<string, C>();
  constructor(readonly snap: StoredSnapshot) {
    for (const c of snap.components) this.byKey.set(`${c.type}|${c.apiName}`, c);
  }
  get snapshotId(): string {
    return this.snap.info.id;
  }
  private known(type: string, apiName: string): C | undefined {
    const c = this.byKey.get(`${type}|${apiName}`);
    return c && c.evidenceStatus !== 'UNKNOWN' ? c : undefined;
  }
  /** Content hash of a known component (`undefined` when absent or UNKNOWN). */
  hashOf(type: string, apiName: string): string | undefined {
    return this.known(type, apiName)?.hash;
  }
  unreadable(type: string, object?: string): boolean {
    return (
      this.byKey.get(`${type}|*`)?.evidenceStatus === 'UNKNOWN' ||
      (object !== undefined && this.byKey.get(`${type}|${object}.*`)?.evidenceStatus === 'UNKNOWN')
    );
  }
  object(name: string): { createable: boolean; deletable: boolean } | undefined {
    const c = this.known('SObject', name);
    if (!c) return undefined;
    return { createable: c.body?.['createable'] !== false, deletable: c.body?.['deletable'] !== false };
  }
  field(object: string, field: string): FieldFact | undefined {
    const c = this.known('Field', `${object}.${field}`);
    if (!c) return undefined;
    const b = c.body ?? {};
    const pv = Array.isArray(b['picklistValues'])
      ? (b['picklistValues'] as { value?: unknown; active?: unknown }[])
          .filter((p) => p.active !== false)
          .map((p) => str(p.value))
          .filter((v): v is string => v !== undefined)
      : undefined;
    return {
      apiName: c.apiName,
      type: str(b['type']) ?? 'string',
      ...(typeof b['length'] === 'number' && b['length'] > 0 ? { length: b['length'] } : {}),
      required: b['required'] === true,
      createable: b['createable'] !== false,
      ...(pv ? { picklistValues: pv } : {}),
      restricted: b['restrictedPicklist'] === true,
      referenceTo: Array.isArray(b['referenceTo']) ? (b['referenceTo'] as unknown[]).map(String) : [],
    };
  }
  requiredFields(object: string): FieldFact[] {
    return this.snap.components
      .filter((c) => c.type === 'Field' && c.parent === object && c.evidenceStatus !== 'UNKNOWN')
      .map((c) => this.field(object, c.apiName.split('.')[1] ?? ''))
      .filter((f): f is FieldFact => f?.required === true);
  }
  activeValidationRules(object: string): C[] {
    return this.snap.components.filter(
      (c) =>
        c.type === 'ValidationRule' &&
        c.parent === object &&
        c.evidenceStatus !== 'UNKNOWN' &&
        c.body?.['active'] === true,
    );
  }
  activeDuplicateRules(object: string): C[] {
    return this.snap.components.filter(
      (c) =>
        c.type === 'DuplicateRule' &&
        (c.parent === object || c.apiName.startsWith(`${object}.`)) &&
        c.body?.['active'] === true,
    );
  }
}

// ------------------------------------------------------------------ synthetic values

/** Deterministic run-unique token (stable across a crash/resume of the same run). */
export function syntheticToken(runId: string, stepId: string, field: string): string {
  return BigInt(`0x${createHash('sha256').update(`${runId}|${stepId}|${field}`).digest('hex').slice(0, 12)}`)
    .toString(36)
    .padStart(8, '0')
    .slice(0, 8);
}

/** Fill `{runId}` and `{synthetic}` placeholders. A value of only `{synthetic}` becomes a name-like token. */
export function fillPlaceholders(value: RecipeValue, runId: string, stepId: string, field: string): RecipeValue {
  if (typeof value !== 'string') return value;
  const token = syntheticToken(runId, stepId, field);
  if (value.trim() === '{synthetic}') return `Qa${token}`;
  return value.replace(/\{runId\}/g, runId).replace(/\{synthetic\}/g, token);
}

const SFID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

// ------------------------------------------------------------------ plan

export interface BuildPlanInput {
  loaded: LoadedRecipe;
  facts: SnapshotFacts;
  org: OrgEntry;
  runId: string;
  now?: Date;
}

export function buildDataPlan(i: BuildPlanInput): DataPlan {
  const { recipe } = i.loaded;
  const issues: DataPlanIssue[] = [];
  const err = (code: DataPlanIssue['code'], message: string, stepId?: string, field?: string): void => {
    issues.push({
      severity: 'ERROR',
      code,
      message,
      ...(stepId ? { stepId } : {}),
      ...(field ? { field } : {}),
    });
  };
  const warn = (code: DataPlanIssue['code'], message: string, stepId?: string, field?: string): void => {
    issues.push({
      severity: 'WARNING',
      code,
      message,
      ...(stepId ? { stepId } : {}),
      ...(field ? { field } : {}),
    });
  };
  const tagField = i.org.runTagField;
  const allowedDomains = i.org.allowedEmailDomains?.map((d) => d.toLowerCase());
  const steps: DataPlanStep[] = [];

  recipe.objects.forEach((o, order) => {
    const stepId = o.alias ?? o.object;
    const obj = i.facts.object(o.object);
    if (!obj) {
      if (i.facts.unreadable('SObject', o.object)) {
        err('UNREADABLE_METADATA', `${o.object}: object metadata could not be read`, stepId);
      } else err('UNKNOWN_OBJECT', `${o.object} is not in snapshot ${i.facts.snapshotId}`, stepId);
    } else if (!obj.createable) err('OBJECT_NOT_CREATEABLE', `${o.object} is not createable for this user`, stepId);
    if (o.recordType) {
      err(
        'RECORD_TYPE_UNRESOLVED',
        `${o.object}: record type ${o.recordType} — the snapshot has no RecordTypeId yet; use a recipe without one`,
        stepId,
      );
    }

    const fields: DataPlanStep['fields'] = {};
    const sources: DataPlanStep['fieldSources'] = {};
    for (const [name, raw] of Object.entries(o.fields)) {
      const value = fillPlaceholders(raw, i.runId, stepId, name);
      fields[name] = value;
      sources[name] = typeof raw === 'string' && raw.includes('{synthetic}') ? 'synthetic' : 'recipe';
      if (!obj) continue;
      const f = i.facts.field(o.object, name);
      if (!f) {
        if (i.facts.unreadable('Field', o.object))
          err('UNREADABLE_METADATA', `${o.object}.${name}: unreadable`, stepId, name);
        else err('UNKNOWN_FIELD', `${o.object}.${name} is not in the snapshot`, stepId, name);
        continue;
      }
      if (!f.createable) err('FIELD_NOT_CREATEABLE', `${o.object}.${name} is not createable`, stepId, name);
      if (typeof value === 'string' && f.picklistValues && (f.type === 'picklist' || f.type === 'multipicklist')) {
        const vals = f.type === 'multipicklist' ? value.split(';') : [value];
        for (const v of vals) {
          if (!f.picklistValues.includes(v)) {
            err(
              'INVALID_PICKLIST_VALUE',
              `${o.object}.${name}: "${v}" is not an active picklist value (snapshot ${i.facts.snapshotId})`,
              stepId,
              name,
            );
          }
        }
      }
      if (typeof value === 'string' && f.length !== undefined && value.length > f.length) {
        err('VALUE_TOO_LONG', `${o.object}.${name}: ${value.length} > ${f.length} characters`, stepId, name);
      }
      if (f.type === 'email' && typeof value === 'string' && allowedDomains) {
        const domain = value.split('@')[1]?.toLowerCase() ?? '';
        if (!allowedDomains.includes(domain)) {
          err(
            'EMAIL_DOMAIN_NOT_ALLOWED',
            `${o.object}.${name}: domain ${domain || '(none)'} is not in allowedEmailDomains`,
            stepId,
            name,
          );
        }
      }
    }

    // Parent lookup: filled at create time from the parent's record id.
    if (o.parent) {
      const f = obj ? i.facts.field(o.object, o.parent.field) : undefined;
      const parentObject = recipe.objects.find((p) => (p.alias ?? p.object) === o.parent?.ref)?.object;
      if (obj && !f)
        err('UNKNOWN_FIELD', `${o.object}.${o.parent.field} is not in the snapshot`, stepId, o.parent.field);
      else if (f && parentObject && !f.referenceTo.includes(parentObject)) {
        err(
          'UNKNOWN_FIELD',
          `${o.object}.${o.parent.field} does not reference ${parentObject} (references ${f.referenceTo.join(', ') || 'nothing'})`,
          stepId,
          o.parent.field,
        );
      }
      sources[o.parent.field] = 'parent';
    }

    // Run tag (CLAUDE.md rule 4: cleanup only touches records carrying this run's tag).
    if (tagField) {
      const f = obj ? i.facts.field(o.object, tagField) : undefined;
      if (obj && !f) {
        err(
          'RUN_TAG_FIELD_MISSING',
          `${o.object}.${tagField} (runTagField in config/orgs.yaml) is not in snapshot ${i.facts.snapshotId}`,
          stepId,
          tagField,
        );
      } else if (f && f.length !== undefined && i.runId.length > f.length) {
        err(
          'RUN_TAG_TOO_LONG',
          `run id is ${i.runId.length} characters; ${o.object}.${tagField} holds ${f.length}`,
          stepId,
        );
      }
      fields[tagField] = i.runId;
      sources[tagField] = 'run-tag';
    }

    // Required fields the recipe does not cover: never invent business values.
    if (obj) {
      for (const req of i.facts.requiredFields(o.object)) {
        const name = req.apiName.split('.')[1] ?? '';
        if (!(name in fields) && name !== o.parent?.field) {
          err(
            'REQUIRED_FIELD_MISSING',
            `${o.object}.${name} is required but the recipe has no value (ask for an approved value)`,
            stepId,
            name,
          );
        }
      }
      for (const vr of i.facts.activeValidationRules(o.object)) {
        const formula = str(vr.body?.['errorConditionFormula']) ?? '';
        const hits = Object.keys(fields).filter((f) =>
          new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`).test(formula),
        );
        if (hits.length) {
          warn(
            'VALIDATION_RULE_REFERENCES_FIELD',
            `active validation rule ${vr.apiName} references ${hits.join(', ')} ("${str(vr.body?.['errorMessage']) ?? ''}")`,
            stepId,
          );
        }
      }
      for (const dr of i.facts.activeDuplicateRules(o.object)) {
        warn('DUPLICATE_RULE_ACTIVE', `active duplicate rule ${dr.apiName}: values are run-unique`, stepId);
      }
    }

    // A field whose value is unique to this run's write (reconcile UNCERTAIN writes, adopt UI-created records).
    const unique = Object.entries(fields).find(
      ([k, v]) =>
        sources[k] === 'synthetic' &&
        typeof v === 'string' &&
        v.includes(i.runId) &&
        !(i.facts.field(o.object, k)?.type === 'email'),
    );
    if (!unique) {
      err(
        'NO_UNIQUE_KEY',
        `${o.object}: no synthetic field contains the run id (e.g. "QA-{runId}-{synthetic}")`,
        stepId,
      );
    } else if (!tagField && !String(unique[1]).startsWith(`QA-${i.runId}-`)) {
      err(
        'NO_UNIQUE_KEY',
        `${o.object}: without a run-tag field the unique name must start with QA-${i.runId}-`,
        stepId,
      );
    }

    const keyFields = { ...fields };
    steps.push({
      stepId,
      object: o.object,
      order,
      idempotencyKey: idempotencyKey(i.runId, o.object, stepId, keyFields),
      recordType: o.recordType,
      ...(o.parent ? { parent: { field: o.parent.field, stepId: o.parent.ref } } : {}),
      fields,
      fieldSources: sources,
      uniqueKey: unique ? { field: unique[0], value: String(unique[1]) } : { field: '', value: '' },
    });
  });

  const negatives: NegativePlan[] = [];
  for (const v of recipe.negativeVariants) {
    const base = steps.find((s) => s.stepId === v.object);
    if (!base) continue;
    const fields: DataPlanStep['fields'] = Object.fromEntries(
      Object.entries(base.fields).filter(([k]) => !v.remove.includes(k)),
    );
    for (const [k, val] of Object.entries(v.set))
      fields[k] = fillPlaceholders(val, i.runId, `${base.stepId}:${v.name}`, k);
    // Keep the variant's own unique name, so an unexpected save can be found and cleaned up.
    if (base.uniqueKey.field && base.uniqueKey.field in fields) {
      fields[base.uniqueKey.field] = `${base.uniqueKey.value}-neg`;
    }
    const codes = new Set<string>();
    for (const r of v.remove) {
      const f = i.facts.field(base.object, r);
      if (f?.required) codes.add('REQUIRED_FIELD_MISSING');
      for (const vr of i.facts.activeValidationRules(base.object)) {
        if (blocksBlank(str(vr.body?.['errorConditionFormula']) ?? '', r))
          codes.add('FIELD_CUSTOM_VALIDATION_EXCEPTION');
      }
    }
    if (!codes.size) {
      err(
        'NEGATIVE_NOT_REJECTABLE',
        `negative ${v.name}: no metadata says removing ${v.remove.join(', ') || '(nothing)'} is rejected — cannot assert rejection`,
        base.stepId,
      );
      continue;
    }
    negatives.push({
      name: v.name,
      stepId: base.stepId,
      object: base.object,
      idempotencyKey: idempotencyKey(i.runId, base.object, `${base.stepId}:${v.name}`, fields),
      fields,
      removed: v.remove,
      expectedErrorCodes: [...codes],
    });
  }

  return DataPlan.parse({
    recipe: recipe.recipe,
    recipeHash: i.loaded.hash,
    approvedBy: recipe.approvedBy,
    runId: i.runId,
    orgId: i.org.orgId,
    orgAlias: i.org.alias,
    environment: i.org.environment,
    snapshotId: i.facts.snapshotId,
    runTag: { field: tagField, value: i.runId },
    steps,
    negatives,
    issues,
    valid: !issues.some((x) => x.severity === 'ERROR'),
    createdAt: (i.now ?? new Date()).toISOString(),
  });
}

export const isRecordId = (v: unknown): v is string => typeof v === 'string' && SFID.test(v);
