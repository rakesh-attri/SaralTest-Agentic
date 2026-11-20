import { ZodError } from 'zod';
import { classifyError } from '../../core/classifyError.js';
import { withRetry, type RetryOptions } from '../../core/retry.js';
import {
  harvestApex,
  harvestCustomFieldIds,
  harvestCustomMetadata,
  harvestDependencies,
  harvestDescribe,
  harvestFlexiPages,
  harvestFlows,
  harvestLayouts,
  harvestSecurity,
  harvestUiBundles,
  harvestValidationRules,
  type HarvestContext,
  type SfReader,
} from './harvest.js';
import type { AreaResult, ComponentType, DiscoveredComponent, DiscoveryResult } from './types.js';

export * from './types.js';
export { formulaFieldRefs } from './formula.js';
export { decodeValidFor, flowRefs, type SfReader } from './harvest.js';

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

interface Area {
  name: string;
  run: (ctx: HarvestContext) => Promise<number>;
  /** Component types this area produces (UNKNOWN placeholders on failure). */
  types: ComponentType[];
  objectScoped: boolean;
  /** Without this area nothing else makes sense (describe). */
  critical?: boolean;
}

const AREAS: Area[] = [
  {
    name: 'objects+fields+recordTypes+picklists',
    run: harvestDescribe,
    types: ['SObject', 'Field', 'RecordType'],
    objectScoped: true,
    critical: true,
  },
  {
    name: 'customMetadata+customSettings',
    run: harvestCustomMetadata,
    types: ['CustomMetadataType', 'CustomSetting'],
    objectScoped: false,
  },
  { name: 'validationRules', run: harvestValidationRules, types: ['ValidationRule'], objectScoped: true },
  { name: 'apex', run: harvestApex, types: ['ApexTrigger', 'ApexClass'], objectScoped: false },
  { name: 'flows', run: harvestFlows, types: ['Flow'], objectScoped: false },
  {
    name: 'lwc+aura',
    run: harvestUiBundles,
    types: ['LightningComponentBundle', 'AuraDefinitionBundle'],
    objectScoped: false,
  },
  { name: 'layouts', run: harvestLayouts, types: ['Layout'], objectScoped: true },
  { name: 'flexiPages', run: harvestFlexiPages, types: ['FlexiPage'], objectScoped: true },
  {
    name: 'profiles+permissionSets+FLS/CRUD+sharing+duplicateRules',
    run: harvestSecurity,
    types: ['Profile', 'PermissionSet', 'ObjectPermissions', 'FieldPermissions', 'DuplicateRule'],
    objectScoped: false,
  },
  { name: 'customFieldIds', run: harvestCustomFieldIds, types: [], objectScoped: true },
  { name: 'dependencies', run: harvestDependencies, types: [], objectScoped: false },
];

export interface DiscoveryOptions {
  sf: SfReader;
  environment: 'LIVE' | 'FIXTURE';
  orgId: string;
  apiVersion: string;
  objects: string[];
  concurrency?: number;
  retry?: RetryOptions;
  onProgress?: (msg: string) => void;
  now?: () => Date;
}

/** Wrap every read with policy retries (TRANSIENT only — discovery never writes). */
function retrying(sf: SfReader, retry: RetryOptions): SfReader {
  return {
    query: (soql, opts) => withRetry(() => sf.query(soql, opts), retry),
    describe: (o) => withRetry(() => sf.describe(o), retry),
    describeGlobal: () => withRetry(() => sf.describeGlobal(), retry),
  };
}

/**
 * Org discovery for the given objects plus the org-wide components that relate to them (PLAN.md §11 Phase 2,
 * salesforce-platform harvest checklist). Read-only. An area that cannot be read is recorded as UNKNOWN
 * placeholders and an AreaResult error; discovery continues (resilience) and never treats it as "missing".
 */
export async function runDiscovery(o: DiscoveryOptions): Promise<DiscoveryResult> {
  const now = o.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const retry: RetryOptions = o.retry ?? { maxAttempts: 3, backoffSeconds: [2, 8, 30] };
  const ctx: HarvestContext = {
    sf: retrying(o.sf, retry),
    objects: [...new Set(o.objects)],
    components: [],
    dependencies: [],
    relationships: new Map(),
    labels: new Map(),
    fieldIds: new Map(),
    mapLimit: (items, fn) => mapLimit(items, o.concurrency ?? 4, fn),
  };
  const areas: AreaResult[] = [];
  for (const area of AREAS) {
    const t0 = Date.now();
    try {
      const count = await area.run(ctx);
      areas.push({ area: area.name, ok: true, count, durationMs: Date.now() - t0 });
      o.onProgress?.(`  ${area.name}: ${count}`);
    } catch (err) {
      // A response that does not match the expected Salesforce shape is not model output: report it as such.
      const c =
        err instanceof ZodError
          ? {
              kind: 'UNKNOWN',
              message: `unexpected response shape at ${err.issues[0]?.path.join('.') ?? '?'}: ${err.issues[0]?.message ?? ''}`,
            }
          : classifyError(err);
      const error = `${c.kind}: ${c.message}`.slice(0, 300);
      areas.push({ area: area.name, ok: false, count: 0, error, durationMs: Date.now() - t0 });
      o.onProgress?.(`  ${area.name}: UNKNOWN (${error})`);
      const placeholders: DiscoveredComponent[] = area.types.flatMap((type) =>
        area.objectScoped
          ? ctx.objects.map((obj) => ({
              type,
              apiName: `${obj}.*`,
              parent: obj,
              body: { reason: error },
              evidenceStatus: 'UNKNOWN' as const,
            }))
          : [{ type, apiName: '*', body: { reason: error }, evidenceStatus: 'UNKNOWN' as const }],
      );
      ctx.components.push(...placeholders);
      if (area.critical) break;
    }
  }
  // Deterministic order (stable reports, stable snapshot hashes)
  ctx.components.sort((a, b) => a.type.localeCompare(b.type) || a.apiName.localeCompare(b.apiName));
  const seen = new Set<string>();
  const dependencies = ctx.dependencies.filter((d) => {
    const k = `${d.fromType}|${d.fromName}|${d.toType}|${d.toName}|${d.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    environment: o.environment,
    orgId: o.orgId,
    apiVersion: o.apiVersion,
    objects: ctx.objects,
    components: ctx.components,
    dependencies,
    areas,
    startedAt,
    finishedAt: now().toISOString(),
  };
}
