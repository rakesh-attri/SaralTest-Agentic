import { z } from 'zod';
import { IsoDate } from './common.js';
import { ReviewStatus } from './testCase.js';

/**
 * Test IR (Phase 4): the Test Generator's model fills this structure; code renders the Playwright spec from it.
 * The model never writes TypeScript. Elements are page-object members (`<pageId>.<member>`) generated from the
 * locator registry; values are references to recipe data, grounded literals or generated lengths.
 */

/** `<pageId>.<member>`, e.g. `contact-new.lastName`. */
export const ElementRef = z.string().regex(/^[a-z][a-z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$/, '<pageId>.<member>');

/** `contactLastName` / `Contact Last_Name` → `contact-last-name`. */
export function toLabel(raw: string): string {
  const k = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(k) ? k : `v-${k || 'value'}`;
}

/**
 * Shorthand value objects some models emit without `kind` (NIM coder, run-p4-coder-nim-7: `{"data":"Contact",
 * "field":"FirstName"}`) are mapped to the canonical form when the mapping is unambiguous; anything else is left for
 * the schema to reject.
 */
function canonicalValue(v: unknown): unknown {
  if (typeof v !== 'object' || v === null || 'kind' in v) return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (typeof o['data'] === 'string' && typeof o['field'] === 'string')
    return { kind: 'data', ref: o['data'], field: o['field'] };
  if (typeof o['recordId'] === 'string' && keys.length === 1) return { kind: 'recordId', ref: o['recordId'] };
  if (typeof o['unique'] === 'string')
    return { kind: 'unique', label: o['unique'], ...(o['format'] ? { format: o['format'] } : {}) };
  if (typeof o['length'] === 'number')
    return { kind: 'length', length: o['length'], evidenceIds: o['evidenceIds'] ?? [] };
  if (typeof o['literal'] === 'string')
    return { kind: 'literal', value: o['literal'], evidenceIds: o['evidenceIds'] ?? [] };
  return v;
}

export const ValueRefUnion = z.discriminatedUnion('kind', [
  /** A field value of a record from the data plan (recipe step alias + field). */
  z.object({ kind: z.literal('data'), ref: z.string().min(1), field: z.string().min(1) }),
  /** The record id of a data-plan record or of a record the test created through the UI. */
  z.object({ kind: z.literal('recordId'), ref: z.string().min(1) }),
  /** A literal value; must be grounded in the cited evidence (src/oracles/grounding.ts). */
  // evidenceIds may be omitted by the model: normalizeIr fills them with the case step's own evidence, and the
  // checks require a non-empty list afterwards.
  z.object({ kind: z.literal('literal'), value: z.string(), evidenceIds: z.array(z.string()).default([]) }),
  /** A run-unique string of exactly `length` characters (boundary values), length cited from evidence. */
  z.object({
    kind: z.literal('length'),
    length: z.number().int().min(0).max(100_000),
    evidenceIds: z.array(z.string()).default([]),
  }),
  /**
   * A run-unique synthetic value for data the test types itself (e.g. a Contact last name created via the UI).
   * `phone` = 10 digits (valid for the org's phone format rule), `email` = an address at example.invalid.
   */
  z.object({
    kind: z.literal('unique'),
    /** Normalised to lowercase-kebab (models often answer `contactLastName`): meaning-preserving. */
    label: z
      .string()
      .min(1)
      .transform(toLabel)
      .pipe(z.string().regex(/^[a-z][a-z0-9-]*$/)),
    format: z.enum(['text', 'email', 'phone']).default('text'),
  }),
]);
export const ValueRef = z.preprocess(canonicalValue, ValueRefUnion);
export type ValueRef = z.infer<typeof ValueRef>;

export const IrAction = z.discriminatedUnion('do', [
  z.object({ do: z.literal('openRecord'), ref: z.string().min(1), object: z.string().min(1) }),
  z.object({ do: z.literal('openNewFromRelatedList'), parentRef: z.string().min(1), relatedList: z.string().min(1) }),
  z.object({ do: z.literal('fill'), element: ElementRef, value: ValueRef }),
  /** Choose an option of a picklist combobox (value = the option label; checked against the snapshot's picklist). */
  z.object({ do: z.literal('select'), element: ElementRef, value: ValueRef }),
  z.object({ do: z.literal('clear'), element: ElementRef }),
  z.object({ do: z.literal('click'), element: ElementRef }),
  z.object({ do: z.literal('selectTab'), element: ElementRef }),
  /** Update a data-plan record through the guarded API (e.g. to produce field history). */
  z.object({ do: z.literal('apiUpdate'), ref: z.string().min(1), fields: z.record(z.string(), ValueRef) }),
  /**
   * Register a record the test created through the UI (found by a unique field value), tag it with the run and
   * add it to the ledger so it is cleaned up.
   */
  z.object({
    do: z.literal('adopt'),
    as: z.string().min(1),
    object: z.string().min(1),
    field: z.string(),
    value: ValueRef,
  }),
]);
export type IrAction = z.infer<typeof IrAction>;

/** Which expected result of the case an assertion implements (index into TestCase.steps, 0-based). */
export const ExpectationRef = z.object({
  caseStep: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()).default([]),
});

export const IrAssertion = z.discriminatedUnion('check', [
  z.object({ check: z.literal('visible'), element: ElementRef, expect: ExpectationRef }),
  z.object({ check: z.literal('hidden'), element: ElementRef, expect: ExpectationRef }),
  z.object({ check: z.literal('inputValue'), element: ElementRef, equals: ValueRef, expect: ExpectationRef }),
  /**
   * The field is marked invalid. `message.rule` names the active validation rule (API name) whose error message the
   * field must show: code reads the text from the org snapshot — the model never writes message text.
   */
  z.object({
    check: z.literal('fieldError'),
    element: ElementRef,
    /**
     * Where the message text comes from — never from the model: `rule` = an active validation rule's errorMessage
     * (snapshot); `observed` = the id of a UI-observed message a human accepted (Phase 5).
     */
    message: z.union([z.object({ rule: z.string().min(1) }), z.object({ observed: z.string().min(1) })]).optional(),
    expect: ExpectationRef,
  }),
  /**
   * Lightning's save warning popover (e.g. "Similar Records Exist" of an active duplicate rule) shows the accepted
   * observed text (`observed` = message id). Code renders the text and closes the popover afterwards.
   */
  z.object({ check: z.literal('saveWarning'), observed: z.string().min(1), expect: ExpectationRef }),
  z.object({ check: z.literal('toast'), contains: ValueRef.optional(), expect: ExpectationRef }),
  /**
   * After a create-dialog Save: the record was saved. Never a URL or record-id check — code renders the operator
   * rule (2026-11-26): toast names the record → it is in the related list with that name → opened from the list,
   * its header shows the name → SOQL by the run tag returns exactly it with the values typed. Elsewhere: the record
   * page of `object` is shown. `as` names the saved record for later checks.
   */
  z.object({
    check: z.literal('recordView'),
    object: z.string().min(1),
    as: z.string().optional(),
    expect: ExpectationRef,
  }),
  /** The record page's details show the value for a field (element = a `<field>Field` member of a record page). */
  z.object({ check: z.literal('recordField'), element: ElementRef, contains: ValueRef, expect: ExpectationRef }),
  /** The record page header (h1) shows the value. */
  z.object({ check: z.literal('recordTitle'), contains: ValueRef, expect: ExpectationRef }),
  z.object({
    check: z.literal('relatedListHasRecord'),
    parentRef: z.string().min(1),
    relatedList: z.string().min(1),
    name: ValueRef,
    expect: ExpectationRef,
  }),
  /** Independent API oracle: SOQL field value of a record (by ref). */
  z.object({
    check: z.literal('soqlField'),
    ref: z.string().min(1),
    object: z.string().min(1),
    field: z.string().min(1),
    equals: ValueRef,
    expect: ExpectationRef,
  }),
  /** SOQL: no record of `object` with `field = value` exists (a rejected save). */
  z.object({
    check: z.literal('soqlNoRecord'),
    object: z.string().min(1),
    field: z.string().min(1),
    value: ValueRef,
    expect: ExpectationRef,
  }),
  /**
   * Phase 7 (BR-08): the run-created record `ref` still exists (exists: true) or no longer exists (exists: false) —
   * SOQL by its id. For delete flows: blocked → still exists; allowed → gone.
   */
  z.object({
    check: z.literal('recordExists'),
    ref: z.string().min(1),
    object: z.string().min(1),
    exists: z.boolean(),
    expect: ExpectationRef,
  }),
  /** API create with this field value is rejected with one of the error codes (metadata-derived). */
  z.object({
    check: z.literal('apiRejects'),
    object: z.string().min(1),
    basedOn: z.string().min(1),
    fields: z.record(z.string(), ValueRef).default({}),
    remove: z.array(z.string()).default([]),
    errorCodes: z.array(z.string()).min(1),
    expect: ExpectationRef,
  }),
  /** `<Object>History` rows exist for each field after an update of record `ref`. */
  z.object({
    check: z.literal('historyTracked'),
    ref: z.string().min(1),
    object: z.string().min(1),
    fields: z.array(z.string()).min(1),
    expect: ExpectationRef,
  }),
  /** axe scan scoped to a dialog/region element; only custom-namespace violations fail (operator rule). */
  z.object({ check: z.literal('a11yScan'), scope: ElementRef, expect: ExpectationRef }),
  /** Keyboard: every listed element reachable by Tab, focus stays in scope, visual reading order. */
  z.object({
    check: z.literal('tabOrder'),
    scope: ElementRef,
    elements: z.array(ElementRef).min(2),
    expect: ExpectationRef,
  }),
]);
export type IrAssertion = z.infer<typeof IrAssertion>;

export const IrStep = z.object({
  /** Case step index this test.step implements (0-based). */
  caseStep: z.number().int().nonnegative(),
  title: z.string().min(3),
  actions: z.array(IrAction).default([]),
  assertions: z.array(IrAssertion).default([]),
});
export type IrStep = z.infer<typeof IrStep>;

export const TestIR = z.object({
  caseId: z.string(),
  /** Data-plan step aliases created through the API before the test (from the bound recipe). */
  data: z.array(z.string()).default([]),
  steps: z.array(IrStep).min(1),
  /** Free-text notes for the reviewer (substitutions, scope rules). Never used as an oracle. */
  notes: z.array(z.string()).default([]),
});
export type TestIR = z.infer<typeof TestIR>;

// ------------------------------------------------------------------ generated artifacts

export const ArtifactKind = z.enum(['spec', 'page-object', 'api-test', 'fixture', 'support']);

/**
 * One org component a spec depends on, with its content hash when the spec was built: `ValidationRule:<Obj.Rule>`,
 * `Field:<Obj.Field>` (snapshot hashes) or `Locator:<page>/<element>` (hash of the registry expression).
 */
export const SpecDependency = z.object({ component: z.string().min(1), hash: z.string().min(1) });
export type SpecDependency = z.infer<typeof SpecDependency>;

/** A spec whose dependencies changed after it was built: never executed until rebuilt. */
export const SpecStale = z.object({
  /** `<component> changed` / `removed` / `RE_VERIFY` lines. */
  components: z.array(z.string()).min(1),
  /** Snapshot in which the change was found. */
  snapshotId: z.string(),
  markedAt: z.string(),
});
export type SpecStale = z.infer<typeof SpecStale>;

export const GeneratedArtifact = z.object({
  kind: ArtifactKind,
  /** Repo-relative path with forward slashes. */
  path: z.string(),
  hash: z.string(),
  testCaseIds: z.array(z.string()),
  /** Hash of the source TestCase (lineage: spec ↔ case version). */
  caseHash: z.string().optional(),
  irHash: z.string().optional(),
  snapshotId: z.string().optional(),
  /** `<pageId>.<member>` elements the spec uses (checked by the locator dry-run). */
  locatorsUsed: z.array(z.string()).default([]),
  /** Recipe names the spec's data comes from. */
  dataBindings: z.array(z.string()).default([]),
  /** generated = model IR; mechanical = test.fixme skeleton (degrade); deterministic = code only (page objects). */
  origin: z.enum(['generated', 'mechanical', 'deterministic']).default('deterministic'),
  /** Test Reviewer pass 2 verdict (specs only). */
  reviewStatus: ReviewStatus.optional(),
  reviewReasons: z.array(z.string()).default([]),
  /** Org components (with hashes) the spec depends on; `snapshotId` is the snapshot they were read from. Absent on
   * specs built before dependency tracking (2026-11-26): their staleness is unknown until rebuilt or backfilled. */
  dependsOn: z.array(SpecDependency).optional(),
  /** Set by `qa discover` / `qa build` when a dependency changed; cleared only by a rebuild of the spec. */
  stale: SpecStale.optional(),
});
export type GeneratedArtifact = z.infer<typeof GeneratedArtifact>;

/** One locator dry-run check: resolved in its page state as the persona, without running any test. */
export const LocatorCheck = z.object({
  element: z.string(),
  page: z.string(),
  persona: z.string(),
  expression: z.string(),
  count: z.number().int().nonnegative(),
  visible: z.boolean(),
  enabled: z.boolean(),
  ok: z.boolean(),
  note: z.string().optional(),
});
export type LocatorCheck = z.infer<typeof LocatorCheck>;

export const DryRunReport = z.object({
  orgAlias: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE']),
  persona: z.string(),
  at: IsoDate,
  checks: z.array(LocatorCheck),
  /** Pages that could not be opened (with the reason); their elements are not counted as resolved. */
  pageErrors: z.array(z.object({ page: z.string(), error: z.string() })).default([]),
  ok: z.boolean(),
});
export type DryRunReport = z.infer<typeof DryRunReport>;
