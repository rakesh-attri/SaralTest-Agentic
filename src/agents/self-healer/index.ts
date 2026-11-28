// Self-Healer (PLAN.md §3, CLAUDE.md rule 7): repairs only SCRIPT_LOCATOR (registry locator → page objects) and
// SCRIPT_TIMING (per-case wait factor) failures. Never assertions, expected values or test intent:
//   1. back up every file a repair can touch (page objects, catalog, story manifest, wait overrides) byte-for-byte;
//   2. fingerprint the spec's assertions + IR assertions; change the locator / wait; fingerprint again — any
//      difference refuses and reverts the repair;
//   3. the page-object catalog must keep every member name; only the repaired member's locator may change;
//   4. verify by rerunning the case (fresh data, same persona); a failed verification reverts;
//   5. behaviour-changing repairs (role changed / dissimilar name) wait for the `behaviour-changing-locator-repairs`
//      checkpoint at L1/L2;
//   6. a repair found on the FIXTURE is verified and then reverted: fixture observations never change the live
//      org's locators (rule 13).
// Every repair and revert is audited and written to `.qa-memory/heal/repairs.jsonl`.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { PolicyConfig } from '../../config/schemas.js';
import type { Autonomy } from '../../core/state.js';
import {
  HealRepair,
  StoryManifest,
  TestIR,
  type AssertionFingerprint,
  type Environment,
  type Investigation,
  type LocatorFacts,
} from '../../core/schemas/index.js';
import type { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import { fileSource } from '../../knowledge/evidenceLedger.js';
import { LocatorRegistry, type LocatorEntry } from '../../knowledge/locatorRegistry.js';
import { ApprovalStore, checkpointRequired } from '../../security/approvals.js';
import type { AuditLog } from '../../security/audit.js';
import { readWaitOverrides, waitOverridesFile } from '../../runner/waitOverrides.js';
import { storyOf } from '../failure-investigator/context.js';
import {
  ariaLocate,
  locatorTarget,
  nameSimilarity,
  STRONG_SIMILARITY,
  type RerunOutcome,
} from '../failure-investigator/experiments.js';
import { extractSignals } from '../failure-investigator/signals.js';
import { locatorHash } from '../test-generator/dependencies.js';
import { buildCatalog, PageCatalog, writePageObjects, type CatalogMember } from '../test-generator/pageObjects.js';
import { storyManifestFile } from '../test-generator/staleness.js';
import { assertionFingerprint, fingerprintDiff, sameFingerprint } from './fingerprint.js';

export const BEHAVIOUR_CHECKPOINT = 'behaviour-changing-locator-repairs';
const CATALOG = join('tests', 'pages', 'page-catalog.json');

export interface HealDeps {
  root: string;
  /** Heal run id (rerun ids derive from it). */
  runId: string;
  environment: Environment;
  autonomy: Autonomy;
  policy: Pick<PolicyConfig, 'healing' | 'approvals'>;
  registryFile: string;
  approvals: ApprovalStore;
  ledger: EvidenceLedger;
  audit?: AuditLog;
  /** Who is approving behaviour-changing repairs in this command (operator, in chat). */
  approvedBy?: string;
  orgIdForApprovals: string;
  rerun?: (o: { caseId: string; label: string }) => Promise<RerunOutcome>;
  say: (m: string) => void;
  now?: () => Date;
}

export interface LocatorPlan {
  kind: 'locator';
  member: CatalogMember;
  pageId: string;
  row: LocatorEntry;
  newName: string;
  newRole: string;
  similarity: number;
  behaviourChanging: boolean;
  /** Derived members built from the same registry row (record page `<field>Field` of an "Edit <Field>" button). */
  alsoChanges: string[];
}
export interface WaitPlan {
  kind: 'wait';
  factor: number;
  target: string;
}
export type RepairPlan = LocatorPlan | WaitPlan;

const repairsFile = (root: string): string => join(root, '.qa-memory', 'heal', 'repairs.jsonl');
const backupDir = (root: string, id: string): string => join(root, '.qa-memory', 'heal', id);
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

export function readCatalog(root: string): PageCatalog | undefined {
  const f = join(root, CATALOG);
  return existsSync(f) ? PageCatalog.parse(JSON.parse(readFileSync(f, 'utf8'))) : undefined;
}

/** Every repair record (latest state per id last). */
export function readRepairs(root: string): HealRepair[] {
  const f = repairsFile(root);
  if (!existsSync(f)) return [];
  const byId = new Map<string, HealRepair>();
  for (const l of readFileSync(f, 'utf8').split('\n'))
    if (l.trim()) {
      const r = HealRepair.parse(JSON.parse(l));
      byId.set(r.id, r);
    }
  return [...byId.values()];
}

function persist(root: string, r: HealRepair): HealRepair {
  const v = HealRepair.parse(r);
  mkdirSync(dirname(repairsFile(root)), { recursive: true });
  appendFileSync(repairsFile(root), `${JSON.stringify(v)}\n`, 'utf8');
  return v;
}

// ---------------------------------------------------------------- planning

/** Repair plans for an investigation (most similar candidate first, at most healing.maxAttemptsPerTest). */
export function planRepairs(
  root: string,
  inv: Investigation,
  maxAttempts: number,
  registry: LocatorRegistry,
): { plans: RepairPlan[]; refused?: string } {
  if (inv.verdict !== 'SCRIPT_LOCATOR' && inv.verdict !== 'SCRIPT_TIMING') {
    return {
      plans: [],
      refused: `verdict ${inv.verdict} is not a script problem — never healed (defect-investigation SKILL)`,
    };
  }
  if (inv.verdict === 'SCRIPT_TIMING') {
    const x = inv.experiments.find((e) => e.kind === 'rerun-extended-waits' && e.outcome === 'SUPPORTS');
    if (!x) return { plans: [], refused: 'no rerun with longer waits passed: the wait factor is unproven' };
    const factor = Number(
      /waits ×?(\d+(?:\.\d+)?)|with (\d+(?:\.\d+)?)× waits/.exec(x.result)?.slice(1).find(Boolean) ?? 3,
    );
    return { plans: [{ kind: 'wait', factor, target: `${inv.caseId ?? '?'} helper / action / navigation waits` }] };
  }
  const aria = inv.experiments.find((e) => e.kind === 'aria-locate');
  const locator = typeof aria?.data['locator'] === 'string' ? aria.data['locator'] : undefined;
  const cands = z
    .array(z.object({ role: z.string(), name: z.string(), similarity: z.number() }))
    .safeParse(aria?.data['candidates'] ?? []);
  if (!locator || !cands.success || !cands.data.length)
    return { plans: [], refused: 'no candidate element in the ARIA snapshot' };
  const target = locatorTarget(locator);
  const catalog = readCatalog(root);
  if (!catalog || !target) return { plans: [], refused: 'no page-object catalog or unparseable locator' };
  const used = usedRefs(root, inv.caseId);
  const wantName = target.name ?? target.label ?? target.text ?? '';
  const matches: { member: CatalogMember; pageId: string }[] = [];
  for (const p of catalog.pages)
    for (const m of p.members)
      if ((!used || used.has(m.ref)) && m.accessibleName === wantName && (!target.role || m.role === target.role))
        matches.push({ member: m, pageId: p.id });
  if (!matches.length) {
    // A derived member the spec uses (record page `titleField` = list item holding the "Edit Title" button) quotes the
    // failing name: repair its base registry row (run-p7-live-l1, TC-036).
    for (const p of catalog.pages)
      for (const m of p.members) {
        if ((used && !used.has(m.ref)) || !m.registryElement || !m.expression.includes(`name: '${wantName}'`)) continue;
        const base = p.members.find(
          (b) =>
            b.ref !== m.ref &&
            b.registryElement === m.registryElement &&
            b.accessibleName === wantName &&
            (!target.role || b.role === target.role),
        );
        if (base && !matches.some((x) => x.member.ref === base.ref)) matches.push({ member: base, pageId: p.id });
      }
  }
  if (matches.length !== 1) {
    return {
      plans: [],
      refused: matches.length
        ? `the locator matches ${matches.length} page-object members`
        : `no page-object member is "${wantName}"`,
    };
  }
  const { member, pageId } = matches[0] as { member: CatalogMember; pageId: string };
  if (!member.registryElement) return { plans: [], refused: `${member.ref} has no registry row` };
  const row = registry.get(catalog.org, pageId, member.registryElement, catalog.persona);
  if (!row) return { plans: [], refused: `registry row ${pageId}/${member.registryElement} not found` };
  if (!row.expression.includes(`'${wantName}'`))
    return { plans: [], refused: `registry expression does not quote "${wantName}" (regex names are not auto-healed)` };
  const plans: LocatorPlan[] = cands.data.slice(0, maxAttempts).map((c) => {
    const roleChanged = Boolean(member.role) && c.role !== member.role;
    // Only a name that keeps the old one ("Save" → "Save Record") is the same element; a shorter one may be another.
    const contains = c.name.toLowerCase().includes(wantName.toLowerCase());
    return {
      kind: 'locator',
      member,
      pageId,
      row,
      newName: c.name,
      newRole: c.role,
      similarity: c.similarity,
      behaviourChanging: roleChanged || !(contains || nameSimilarity(wantName, c.name) >= STRONG_SIMILARITY),
      alsoChanges: (catalog.pages.find((x) => x.id === pageId)?.members ?? [])
        .filter((x) => x.ref !== member.ref && x.registryElement === member.registryElement)
        .map((x) => x.ref),
    };
  });
  return { plans };
}

function usedRefs(root: string, caseId: string | undefined): Set<string> | undefined {
  const story = caseId ? storyOf(caseId) : undefined;
  if (!story || !caseId) return undefined;
  const f = storyManifestFile(root, story);
  if (!existsSync(f)) return undefined;
  const m = StoryManifest.safeParse(JSON.parse(readFileSync(f, 'utf8')));
  const a = m.success ? m.data.artifacts.find((x) => x.kind === 'spec' && x.testCaseIds.includes(caseId)) : undefined;
  return a?.locatorsUsed ? new Set(a.locatorsUsed) : undefined;
}

// ---------------------------------------------------------------- fingerprints + backups

function specAndIr(root: string, inv: Investigation): { specText: string; irAssertions: unknown[] } {
  const specPath = inv.specPath ? join(root, inv.specPath) : undefined;
  const specText = specPath && existsSync(specPath) ? readFileSync(specPath, 'utf8') : '';
  let irAssertions: unknown[] = [];
  const story = inv.caseId ? storyOf(inv.caseId) : undefined;
  if (story && inv.caseId) {
    const mf = storyManifestFile(root, story);
    if (existsSync(mf)) {
      const m = StoryManifest.safeParse(JSON.parse(readFileSync(mf, 'utf8')));
      const a = m.success
        ? m.data.artifacts.find((x) => x.kind === 'spec' && x.testCaseIds.includes(inv.caseId ?? ''))
        : undefined;
      const buildRun = a?.buildRun ?? (m.success ? m.data.buildRun : undefined);
      const irf = buildRun ? join(root, 'runs', buildRun, 'build', 'ir', `${inv.caseId}.json`) : undefined;
      if (irf && existsSync(irf)) {
        const ir = TestIR.safeParse(JSON.parse(readFileSync(irf, 'utf8')));
        if (ir.success) irAssertions = ir.data.steps.flatMap((s) => s.assertions);
      }
    }
  }
  return { specText, irAssertions };
}

export function fingerprintOf(root: string, inv: Investigation): AssertionFingerprint {
  const { specText, irAssertions } = specAndIr(root, inv);
  return assertionFingerprint(specText, irAssertions);
}

/** Files a repair may touch (relative to root). */
function touchable(root: string, inv: Investigation): string[] {
  const cat = readCatalog(root);
  const story = inv.caseId ? storyOf(inv.caseId) : undefined;
  return [
    CATALOG,
    ...(cat?.pages.map((p) => p.file) ?? []),
    ...(story ? [join('tests', 'generated', story, 'manifest.json')] : []),
    join('tests', 'support', 'wait-overrides.json'),
  ];
}

interface BackupIndex {
  files: { path: string; existed: boolean; sha256?: string }[];
}

function backup(root: string, id: string, files: readonly string[]): void {
  const dir = backupDir(root, id);
  mkdirSync(dir, { recursive: true });
  const idx: BackupIndex = { files: [] };
  files.forEach((rel, i) => {
    const abs = join(root, rel);
    if (existsSync(abs)) {
      copyFileSync(abs, join(dir, `${i}.bak`));
      idx.files.push({ path: rel, existed: true, sha256: sha(readFileSync(abs)) });
    } else idx.files.push({ path: rel, existed: false });
  });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(idx, null, 2));
}

/** Restore every backed-up file byte-for-byte; files that did not exist are removed. */
function restore(root: string, id: string): string[] {
  const dir = backupDir(root, id);
  const idx = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as BackupIndex;
  const out: string[] = [];
  idx.files.forEach((f, i) => {
    const abs = join(root, f.path);
    if (f.existed) {
      mkdirSync(dirname(abs), { recursive: true });
      copyFileSync(join(dir, `${i}.bak`), abs);
      out.push(f.path);
    } else if (existsSync(abs)) {
      rmSync(abs);
      out.push(f.path);
    }
  });
  return out;
}

// ---------------------------------------------------------------- apply

/** Replace the quoted accessible name in the LAST locator segment of an expression. */
export function renameInExpression(expr: string, oldName: string, newName: string): string {
  const q = `'${oldName}'`;
  const i = expr.lastIndexOf(q);
  if (i < 0) return expr;
  return `${expr.slice(0, i)}'${newName.replace(/'/g, "\\'")}'${expr.slice(i + q.length)}`;
}

/** Only `target` may differ between two catalogs, and only in expression / accessible name. */
/** Only `targets` (the repaired member and the members derived from its registry row) may change their locator. */
export function catalogScopeCheck(
  before: PageCatalog,
  after: PageCatalog,
  targetRef: string | readonly string[],
): string[] {
  const targets = new Set(typeof targetRef === 'string' ? [targetRef] : targetRef);
  const problems: string[] = [];
  const names = (c: PageCatalog): string[] => c.pages.flatMap((p) => p.members.map((m) => m.ref)).sort();
  const b = names(before);
  const a = names(after);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    problems.push(
      `page-object members changed: -[${b.filter((x) => !a.includes(x)).join(', ')}] +[${a.filter((x) => !b.includes(x)).join(', ')}]`,
    );
  }
  const index = (c: PageCatalog): Map<string, CatalogMember> =>
    new Map(c.pages.flatMap((p) => p.members.map((m) => [m.ref, m] as const)));
  const ia = index(after);
  for (const [ref, m] of index(before)) {
    const n = ia.get(ref);
    if (!n) continue;
    const strip = (x: CatalogMember): string =>
      JSON.stringify({ ...x, expression: '', accessibleName: '', lastVerifiedAt: '' });
    if (targets.has(ref)) {
      if (strip(m) !== strip(n)) problems.push(`${ref}: more than the locator changed`);
    } else if (JSON.stringify(m) !== JSON.stringify(n)) problems.push(`${ref}: changed but is not the repaired member`);
  }
  return problems;
}

function newRepairId(root: string, caseId: string, now: Date): string {
  return `HR-${sha(`${root}|${caseId}|${now.toISOString()}|${Math.random()}`).slice(0, 10)}`;
}

function facts(p: LocatorPlan, expression: string, name: string, role: string): LocatorFacts {
  return {
    page: p.pageId,
    element: p.row.element,
    persona: p.row.persona,
    expression,
    role,
    accessibleName: name,
    strategy: p.row.strategy,
    ...(p.row.fieldApiName ? { fieldApiName: p.row.fieldApiName } : {}),
  };
}

async function regeneratePageObjects(root: string, registry: LocatorRegistry, cat: PageCatalog): Promise<void> {
  const next = buildCatalog({
    entries: registry.list({ org: cat.org }),
    org: cat.org,
    orgAlias: cat.orgAlias,
    environment: cat.environment,
    persona: cat.persona,
  });
  await writePageObjects(root, next, (abs, text) => {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  });
}

/** Re-bind the spec's dependency hash for the repaired locator (the heal verified the new expression). */
function rebindDependency(root: string, caseId: string, component: string, hash: string): void {
  const story = storyOf(caseId);
  if (!story) return;
  const f = storyManifestFile(root, story);
  if (!existsSync(f)) return;
  const m = JSON.parse(readFileSync(f, 'utf8')) as {
    artifacts?: { testCaseIds?: string[]; dependsOn?: { component: string; hash: string }[] }[];
  };
  let changed = false;
  for (const a of m.artifacts ?? []) {
    if (!a.testCaseIds?.includes(caseId)) continue;
    for (const d of a.dependsOn ?? [])
      if (d.component === component && d.hash !== hash) {
        d.hash = hash;
        changed = true;
      }
  }
  if (changed) writeFileSync(f, `${JSON.stringify(m, null, 2)}\n`);
}

export interface HealOutcome {
  repairs: HealRepair[];
  final?: HealRepair;
  refused?: string;
}

/** Heal one investigated failure: plan → (approval) → apply → fingerprint check → verify → keep / revert. */
export async function healFailure(inv: Investigation, d: HealDeps): Promise<HealOutcome> {
  const now = d.now ?? (() => new Date());
  const registry = new LocatorRegistry(d.registryFile);
  const out: HealRepair[] = [];
  try {
    const max = d.policy.healing.maxAttemptsPerTest;
    let current = inv;
    let { plans, refused } = planRepairs(d.root, current, max, registry);
    if (refused || !plans.length) return { repairs: [], refused: refused ?? 'no repair plan' };
    let attempt = 0;
    /** Applied repairs kept while the next renamed element is healed (run-p7-live-l1: Title + Edit Title). */
    const chain: HealRepair[] = [];
    const revertChain = (why: string): void => {
      for (const c of [...chain].reverse()) out.push(revertRepair(d.root, c.id, d, why));
      chain.length = 0;
    };
    while (attempt < max) {
      let advanced = false;
      for (const plan of plans) {
        if (attempt >= max) break;
        attempt++;
        const ctl: { keepOnFail: boolean; rerun?: RerunOutcome } = { keepOnFail: plan.kind === 'locator' };
        const r = await applyOne(current, plan, attempt, d, registry, now, ctl);
        out.push(r);
        if (r.status === 'PROPOSED' || r.status === 'REFUSED') {
          revertChain('an earlier repair of this chain is undone: the chain did not complete');
          return { repairs: out, final: r };
        }
        if (r.status === 'VERIFIED') {
          // Earlier links are verified by this rerun too.
          for (const c of chain)
            out.push(
              persist(d.root, {
                ...c,
                status: 'VERIFIED',
                reason: `${c.reason}; verified with ${r.id}`,
                ...(r.verification ? { verification: r.verification } : {}),
              }),
            );
          if (d.environment !== 'LIVE') {
            // Fixture / mock: proven, then reverted — never changes the live org's page objects.
            out.push(revertRepair(d.root, r.id, d, `${d.environment} repair verified, reverted (rule 13)`));
            for (const c of [...chain].reverse())
              out.push(revertRepair(d.root, c.id, d, `${d.environment} repair verified, reverted (rule 13)`));
          }
          return { repairs: out, final: r };
        }
        if (r.status === 'FAILED' && plan.kind === 'locator') {
          const next = nextLocatorFailure(current, plan, ctl.rerun, d);
          if (next) {
            chain.push(r);
            current = next;
            ({ plans, refused } = planRepairs(d.root, current, max, registry));
            advanced = plans.length > 0;
            if (!advanced) revertChain(`chain stopped: ${refused ?? 'no plan for the next element'}`);
            break;
          }
          out.push(revertRepair(d.root, r.id, d, 'verification failed and no further renamed element was found'));
        }
      }
      if (!advanced) break;
    }
    revertChain('the chain did not reach a passing rerun within healing.maxAttemptsPerTest');
    const last = out.filter((x) => !x.revertOf).at(-1); // the repair itself, not its revert record
    return { repairs: out, ...(last ? { final: last } : {}) };
  } finally {
    registry.close();
  }
}

/**
 * After a failed verification rerun: is the new failure another renamed element (different locator, strong ARIA
 * candidate in the rerun's own snapshot)? Then a synthetic investigation for the next link of the chain.
 */
function nextLocatorFailure(
  prev: Investigation,
  plan: LocatorPlan,
  rerun: RerunOutcome | undefined,
  d: HealDeps,
): Investigation | undefined {
  const res = rerun?.result;
  if (!res || res.state !== 'FAIL') return undefined;
  const signals = extractSignals(res);
  if (!signals.some((x) => x.kind === 'LOCATOR_NOT_FOUND' || x.kind === 'LOCATOR_NOT_UNIQUE')) return undefined;
  const loc = signals.find((x) => x.locator)?.locator;
  const target = loc ? locatorTarget(loc) : undefined;
  if (
    !target ||
    (target.name ?? target.label) === plan.row.accessibleName ||
    (target.name ?? target.label) === plan.newName
  )
    return undefined;
  const run = ariaLocate(
    {
      root: d.root,
      runId: d.runId,
      sourceRunDir: join(d.root, 'runs', rerun.runId),
      environment: d.environment,
      failureId: prev.failureId,
      providers: {},
      waitFactor: 3,
      flakyReruns: 3,
      reproductions: 2,
    },
    res,
    signals,
  );
  if (run.experiment.outcome !== 'SUPPORTS') return undefined;
  for (const e of run.evidence) d.ledger.add(e);
  return {
    ...prev,
    signals,
    experiments: [run.experiment],
    evidenceIds: [...prev.evidenceIds, ...run.evidence.map((e) => e.id)],
  };
}

async function applyOne(
  inv: Investigation,
  plan: RepairPlan,
  attempt: number,
  d: HealDeps,
  registry: LocatorRegistry,
  now: () => Date,
  /** Chained repairs: a failed verification keeps the change (the chain decides) and hands back the rerun. */
  chain?: { keepOnFail: boolean; rerun?: RerunOutcome },
): Promise<HealRepair> {
  const caseId = inv.caseId ?? inv.failureId;
  const id = newRepairId(d.root, caseId, now());
  const before = fingerprintOf(d.root, inv);
  const base = {
    id,
    runId: d.runId,
    caseId,
    specPath: inv.specPath ?? '',
    failureId: inv.failureId,
    kind: plan.kind,
    fingerprintBefore: before,
    attempt,
    environment: d.environment,
    createdAt: now().toISOString(),
  } as const;
  const locBefore =
    plan.kind === 'locator'
      ? facts(plan, plan.row.expression, plan.row.accessibleName ?? '', plan.row.role ?? '')
      : undefined;
  const newExpr =
    plan.kind === 'locator' ? renameInExpression(plan.row.expression, plan.row.accessibleName ?? '', plan.newName) : '';
  const locAfter = plan.kind === 'locator' ? facts(plan, newExpr, plan.newName, plan.newRole) : undefined;
  const waitBefore =
    plan.kind === 'wait'
      ? { target: plan.target, timeoutMs: 20_000 * (readWaitOverrides(d.root)[caseId]?.factor ?? 1) }
      : undefined;
  const waitAfter =
    plan.kind === 'wait' ? { target: plan.target, timeoutMs: Math.round(20_000 * plan.factor) } : undefined;
  const describe =
    plan.kind === 'locator'
      ? `${plan.member.ref}: "${plan.row.accessibleName ?? ''}" → "${plan.newName}" (similarity ${plan.similarity.toFixed(2)})`
      : `${caseId}: waits ×${plan.factor}`;

  // Behaviour-changing locator repairs wait for a human at L1/L2.
  let approvalId: string | undefined;
  if (
    plan.kind === 'locator' &&
    plan.behaviourChanging &&
    checkpointRequired(d.policy as PolicyConfig, d.autonomy, BEHAVIOUR_CHECKPOINT)
  ) {
    const subject = `heal:${caseId}:${plan.member.ref}:${plan.newRole}:${plan.newName}`;
    const existing = d.approvals.find(BEHAVIOUR_CHECKPOINT, subject, d.orgIdForApprovals);
    const approval =
      existing ??
      (d.approvedBy
        ? d.approvals.record({
            checkpoint: BEHAVIOUR_CHECKPOINT,
            subject,
            orgId: d.orgIdForApprovals,
            approvedBy: d.approvedBy,
            runId: d.runId,
          })
        : undefined);
    if (!approval) {
      d.say(`  ${caseId}: behaviour-changing repair needs approval (${describe}) — rerun with --approve-by "<name>"`);
      return persist(d.root, {
        ...base,
        ...(locBefore ? { locatorBefore: locBefore } : {}),
        ...(locAfter ? { locatorAfter: locAfter } : {}),
        fingerprintAfter: before,
        assertionsUnchanged: true,
        behaviourChanging: true,
        reason: `PROPOSED ${describe}; waits for ${BEHAVIOUR_CHECKPOINT}`,
        status: 'PROPOSED',
      });
    }
    approvalId = approval.id;
  }

  backup(d.root, id, touchable(d.root, inv));
  const catBefore = readCatalog(d.root);
  if (plan.kind === 'locator') {
    registry.saveHistory(id, [plan.row], now());
    registry.upsert([
      {
        ...plan.row,
        expression: newExpr,
        accessibleName: plan.newName,
        ...(plan.newRole ? { role: plan.newRole } : {}),
        memberName: plan.row.memberName ?? plan.member.name,
        verifiedBy: 'healer',
        lastVerifiedAt: now().toISOString(),
        observationId: `heal:${id}`,
        status: 'ACTIVE',
      },
    ]);
    if (catBefore) await regeneratePageObjects(d.root, registry, catBefore);
    rebindDependency(d.root, caseId, `Locator:${plan.pageId}/${plan.row.element}`, locatorHash(newExpr, 'ACTIVE'));
  } else {
    const f = waitOverridesFile(d.root);
    const all = readWaitOverrides(d.root);
    all[caseId] = { factor: plan.factor, repairId: id };
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${JSON.stringify(all, null, 2)}\n`);
  }

  // Rule 7 proof.
  const after = fingerprintOf(d.root, inv);
  const scope =
    plan.kind === 'locator' && catBefore
      ? catalogScopeCheck(catBefore, readCatalog(d.root) ?? catBefore, [plan.member.ref, ...plan.alsoChanges])
      : [];
  const unchanged = sameFingerprint(before, after);
  const audit = (outcome: 'SUCCEEDED' | 'FAILED' | 'REFUSED', extra: Record<string, unknown> = {}): void => {
    d.audit?.append({
      runId: d.runId,
      orgId: d.orgIdForApprovals,
      user: 'self-healer',
      persona: inv.persona ?? '?',
      action: 'mutate',
      tool: `heal:${plan.kind}`,
      object: caseId,
      before: plan.kind === 'locator' ? locBefore : waitBefore,
      after: { ...(plan.kind === 'locator' ? locAfter : waitAfter), ...extra },
      ...(approvalId ? { approvalId } : {}),
      outcome,
    });
  };
  if (!unchanged || scope.length) {
    restore(d.root, id);
    if (plan.kind === 'locator') registry.restoreHistory(id);
    const diff = fingerprintDiff(before, after);
    audit('REFUSED', { problems: [...scope, ...diff.removed.map((x) => `-${x}`), ...diff.added.map((x) => `+${x}`)] });
    return persist(d.root, {
      ...base,
      ...(locBefore ? { locatorBefore: locBefore } : {}),
      ...(locAfter ? { locatorAfter: locAfter } : {}),
      ...(waitBefore ? { waitBefore } : {}),
      ...(waitAfter ? { waitAfter } : {}),
      fingerprintAfter: after,
      assertionsUnchanged: unchanged,
      behaviourChanging: plan.kind === 'locator' && plan.behaviourChanging,
      reason: `REFUSED ${describe}: ${[...scope, ...(unchanged ? [] : ['assertion fingerprint changed'])].join('; ')}`,
      ...(approvalId ? { approvalId } : {}),
      status: 'REFUSED',
    });
  }

  // Verify by rerun.
  let verification: HealRepair['verification'];
  let status: HealRepair['status'] = 'APPLIED';
  if (d.rerun) {
    const x = await d.rerun({ caseId, label: `heal${attempt}` });
    if (chain) chain.rerun = x;
    verification = { runId: x.runId, state: x.result?.state ?? 'NO_RESULT', attempts: x.result?.attempts ?? 0 };
    status = x.result?.state === 'PASS' ? 'VERIFIED' : 'FAILED';
  }
  if (status === 'FAILED' && !chain?.keepOnFail) {
    restore(d.root, id);
    if (plan.kind === 'locator') registry.restoreHistory(id);
  }
  audit(status === 'FAILED' ? 'FAILED' : 'SUCCEEDED', { status, ...(verification ? { verification } : {}) });
  const evId = `EV-${id}`;
  d.ledger.add({
    id: evId,
    runId: d.runId,
    kind: 'heal',
    claim: `${status} ${describe}; assertions unchanged (fingerprint ${after.sha256.slice(0, 12)}, ${after.count} items)${verification ? `; rerun ${verification.state}` : ''}`,
    sources: [
      ...(inv.specPath ? [fileSource(d.root, inv.specPath)] : []),
      ...(plan.kind === 'locator'
        ? [fileSource(d.root, CATALOG)]
        : [fileSource(d.root, join('tests', 'support', 'wait-overrides.json'))]),
      ...(verification
        ? [{ type: 'result' as const, ref: `${verification.runId}/${caseId}: ${verification.state}` }]
        : []),
    ],
    agent: 'self-healer',
    confidence: status === 'VERIFIED' ? 0.95 : 0.5,
    environment: d.environment,
    createdAt: now().toISOString(),
    subject: inv.failureId,
  });
  d.say(`  ${caseId}: ${status} ${describe}${verification ? ` (rerun ${verification.state})` : ''}`);
  return persist(d.root, {
    ...base,
    ...(locBefore ? { locatorBefore: locBefore } : {}),
    ...(locAfter ? { locatorAfter: locAfter } : {}),
    ...(waitBefore ? { waitBefore } : {}),
    ...(waitAfter ? { waitAfter } : {}),
    fingerprintAfter: after,
    assertionsUnchanged: true,
    behaviourChanging: plan.kind === 'locator' && plan.behaviourChanging,
    reason: `${status} ${describe}`,
    ...(approvalId ? { approvalId } : {}),
    ...(verification ? { verification } : {}),
    status,
  });
}

/** Undo a repair: files restored byte-for-byte, registry rows put back. Recorded as its own REVERTED entry. */
export function revertRepair(
  root: string,
  repairId: string,
  d: Pick<HealDeps, 'registryFile' | 'audit' | 'runId' | 'orgIdForApprovals' | 'say' | 'now'>,
  reason = 'reverted by the operator',
): HealRepair {
  const now = d.now ?? (() => new Date());
  const orig = readRepairs(root).find((r) => r.id === repairId);
  if (!orig) throw new Error(`no repair ${repairId}`);
  if (!existsSync(join(backupDir(root, repairId), 'index.json')))
    throw new Error(`repair ${repairId} has no backup (it was never applied)`);
  const files = restore(root, repairId);
  if (orig.kind === 'locator') {
    const reg = new LocatorRegistry(d.registryFile);
    try {
      reg.restoreHistory(repairId);
    } finally {
      reg.close();
    }
  }
  d.audit?.append({
    runId: d.runId,
    orgId: d.orgIdForApprovals,
    user: 'self-healer',
    persona: '-',
    action: 'mutate',
    tool: `heal-revert:${orig.kind}`,
    object: orig.caseId,
    before: orig.locatorAfter ?? orig.waitAfter,
    after: orig.locatorBefore ?? orig.waitBefore,
    outcome: 'SUCCEEDED',
  });
  d.say(`  reverted ${repairId}: ${files.length} file(s) restored — ${reason}`);
  return persist(root, {
    ...orig,
    id: `${repairId}-revert`,
    runId: d.runId,
    revertOf: repairId,
    status: 'REVERTED',
    reason,
    createdAt: now().toISOString(),
  });
}
