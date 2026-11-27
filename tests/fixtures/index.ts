// Playwright fixtures for generated tests (playwright-standards skill): tests import `test, expect` from here.
// - persona: the project's persona (config/personas.yaml)
// - sf:      identity-checked GuardedSalesforce for that persona (SOQL oracles; observe only in tests)
// - data:    the data factory (src/sf/dataFactory.ts), one data sub-run per test: approved recipe → plan → create
//            in order → … → reverse-order cleanup verified by re-query in teardown (salesforce-test-data skill).
import { test as base, expect } from '@playwright/test';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { join } from 'node:path';
import type { Persona } from '../../src/config/schemas.js';
import { QAError } from '../../src/core/errors.js';
import { WriteLedger } from '../../src/security/idempotency.js';
import type { GuardedSalesforce } from '../../src/sf/client.js';
import { createSfContext, type SfContext } from '../../src/sf/context.js';
import { DataEngine, soqlString } from '../../src/sf/data/engine.js';
import { dataDir, planData, recipeApproval, writeDataOutputs } from '../../src/sf/dataFactory.js';
import { fitUnique } from '../../src/sf/data/unique.js';
import { runSettings, type RunSettings } from '../support/runConfig.js';
import { waitFactor, waitFactorFor } from '../support/waits.js';

export { expect };

export interface TestData {
  /** Run tag value of this test's data (`<runId>-<test hash>`). */
  readonly runId: string;
  /** Create the steps of an approved recipe (all steps by default) through the guarded API. */
  create(recipe: string, steps?: string[]): Promise<void>;
  /** Record id of a created (or adopted) step. */
  id(stepId: string): string;
  /** A planned field value of a created step (comes from the approved recipe / synthetic values). */
  value(stepId: string, field: string): string;
  /**
   * A run-unique value for data the test types itself. `text` contains the run id; `email` is at example.invalid;
   * `phone` is 10 digits (the org's phone format rule).
   */
  /** Run-unique value; `maxLength` (the field's length) shortens the label so the value is never cut by the field. */
  unique(label: string, format?: 'text' | 'email' | 'phone', maxLength?: number): string;
  /** API oracle: create a variant of a step (fields set/removed); returns whether it was saved and the error codes. */
  attempt(
    stepId: string,
    set?: Record<string, unknown>,
    remove?: string[],
  ): Promise<{ saved: boolean; errorCodes: string[]; message?: string }>;
  /** A run-unique string of exactly `length` characters (boundary values). */
  ofLength(length: number): string;
  /** Guarded update of a run-owned record. */
  update(stepId: string, fields: Record<string, unknown>): Promise<void>;
  /** Register a record the test created through the UI (by a run-unique value) so it is tagged and cleaned up. */
  adopt(as: string, object: string, field: string, value: string): Promise<string>;
  /**
   * Register the record a UI Save created, by the id on its record page (generated tests call it after every
   * create-dialog Save, by code). Proven ours by creator + time, then tagged and cleaned up with the rest.
   */
  adoptCreated(as: string, object: string, id: string): Promise<string>;
  /**
   * SOQL by this test's run tag (never by URL or id): records of `object` carrying the tag and matching `where`, with
   * the `select` fields (parent fields such as `Account.Name` flattened to that key).
   */
  tagged(object: string, where: Record<string, string>, select: string[]): Promise<Record<string, unknown>[]>;
}

interface WorkerFixtures {
  settings: RunSettings;
  sfContext: SfContext;
  sf: GuardedSalesforce;
}
interface TestFixtures {
  persona: Persona;
  data: TestData;
  /** a11y namespaces from config/execution.yaml (custom = fails, standard = baseline). */
  a11y: RunSettings['execution']['a11y'];
}

const personaId = (meta: Record<string, unknown>): string =>
  typeof meta['persona'] === 'string' ? meta['persona'] : 'system-admin';

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Phase 7: a Self-Healer SCRIPT_TIMING repair (tests/support/wait-overrides.json) lengthens this case's action /
  // navigation / test timeouts. Assertions and expected values are never touched (rule 7).
  page: async ({ page, settings }, use, testInfo) => {
    const f = waitFactorFor(settings.root, testInfo.file);
    const run = waitFactor();
    if (f > run) {
      page.setDefaultTimeout(20_000 * f);
      page.setDefaultNavigationTimeout(60_000 * f);
      testInfo.setTimeout(Math.round((testInfo.timeout * f) / run));
    }
    await use(page);
  },
  settings: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
    async ({}, use) => {
      await use(runSettings());
    },
    { scope: 'worker' },
  ],
  sfContext: [
    async ({ settings }, use, workerInfo) => {
      const ctx = await createSfContext({
        root: settings.root,
        runId: settings.runId,
        orgAlias: settings.orgAlias,
        personaId: personaId(workerInfo.project.metadata),
      });
      await use(ctx);
    },
    { scope: 'worker' },
  ],
  sf: [
    async ({ sfContext }, use) => {
      await use(await sfContext.connect()); // identity check: HARD_STOP on a wrong org / user / instance
    },
    { scope: 'worker' },
  ],
  persona: async ({ sfContext }, use) => {
    await use(sfContext.persona);
  },
  a11y: async ({ settings }, use) => {
    await use(settings.execution.a11y);
  },
  data: async ({ sfContext, sf }, use, testInfo) => {
    // One data sub-run per ATTEMPT: a retry must not reuse the records (already cleaned) of the failed attempt.
    const hash = createHash('sha256').update(`${testInfo.testId}#${testInfo.retry}`).digest('hex').slice(0, 6);
    const runId = `${sfContext.run.runId}-${hash}`.slice(-50);
    const dir = join(dataDir(sfContext.run.dir), hash);
    const ledger = new WriteLedger(join(dir, 'writes.jsonl'));
    const engines: DataEngine[] = [];
    let uniques = 0;
    // Server clocks differ from ours: records created up to 5 minutes before the test started still count.
    const since = new Date(Date.now() - 5 * 60_000);
    const find = (stepId: string): DataEngine => {
      const e = engines.find((x) => x.plan.steps.some((s) => s.stepId === stepId) || hasId(x, stepId));
      if (!e) throw new QAError('DATA', `no data step ${stepId} in this test (call data.create first)`);
      return e;
    };
    const hasId = (e: DataEngine, stepId: string): boolean => {
      try {
        e.recordId(stepId);
        return true;
      } catch {
        return false;
      }
    };
    const data: TestData = {
      runId,
      async create(recipe, steps) {
        const { plan } = planData({ ctx: sfContext, recipe, runId });
        if (!plan.valid) {
          throw new QAError('DATA', `data plan ${recipe} is invalid: ${plan.issues.map((i) => i.code).join(', ')}`);
        }
        const autonomy =
          process.env['QA_AUTONOMY'] === 'L1' ||
          process.env['QA_AUTONOMY'] === 'L2' ||
          process.env['QA_AUTONOMY'] === 'L3'
            ? process.env['QA_AUTONOMY']
            : sfContext.policy.autonomy;
        const status = recipeApproval(sfContext, plan, autonomy);
        if (status.required && !status.approval) {
          throw new QAError('DATA', `recipe ${recipe} is not approved for ${sfContext.org.alias}: ${status.command}`);
        }
        const engine = new DataEngine({ sf, plan: { ...plan, negatives: [] }, ledger, org: sfContext.org });
        engines.push(engine);
        // Written before any record exists: the Runner's post-run reconciliation needs the plan even when the
        // worker dies before teardown.
        writeDataOutputs(dir, { plan: engine.plan });
        await engine.create(steps);
      },
      id: (stepId) => find(stepId).recordId(stepId),
      value(stepId, field) {
        const v = find(stepId).plan.steps.find((s) => s.stepId === stepId)?.fields[field];
        if (typeof v !== 'string') throw new QAError('DATA', `no planned string value for ${stepId}.${field}`);
        return v;
      },
      unique(label, format = 'text', maxLength) {
        const token = randomBytes(3).toString('hex');
        if (format === 'email') {
          const domain = '@example.invalid';
          const local = fitUnique(
            `qa+${runId}`,
            label,
            token,
            maxLength === undefined ? undefined : maxLength - domain.length,
          );
          return `${local}${domain}`.toLowerCase();
        }
        if (format === 'phone') return `55${String(parseInt(token, 16) % 100_000_000).padStart(8, '0')}`;
        return fitUnique(`QA-${runId}`, label, token, maxLength);
      },
      attempt: (stepId, set, remove) => find(stepId).attempt(stepId, set, remove),
      ofLength(length) {
        const seed = `QA-${runId}-`;
        // Shorter than the run prefix: random DIGITS (Phase 5 fix, run-p5-fx-try-4). Hex mixed in letters, so a
        // "10-digit phone" boundary value broke the phone rule for the wrong reason; digits are a valid value of that
        // length for text and phone fields alike.
        if (length < seed.length) return Array.from({ length }, () => String(randomInt(10))).join('');
        return (seed + 'x'.repeat(length)).slice(0, length);
      },
      update: (stepId, fields) => find(stepId).update(stepId, fields),
      async adopt(as, object, field, value) {
        const e = engines[0];
        if (!e) throw new QAError('DATA', 'adopt needs data.create first (the run tag comes from the plan)');
        uniques++;
        return e.adopt(as, object, field, value);
      },
      async tagged(object, where, select) {
        const e = engines[0];
        if (!e) throw new QAError('DATA', 'tagged needs data.create first (the run tag comes from the plan)');
        const tag = e.plan.runTag;
        if (!tag.field) throw new QAError('DATA', 'this org has no run-tag field (orgs.yaml runTagField)');
        const ident = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
        for (const f of [object, ...Object.keys(where), ...select])
          if (!ident.test(f)) throw new QAError('DATA', `tagged: invalid name ${f}`);
        const conds = [
          `${tag.field} = ${soqlString(tag.value)}`,
          ...Object.entries(where).map(([k, v]) => `${k} = ${soqlString(v)}`),
        ];
        const fields = [...new Set(['Id', ...select])];
        const rows = await sf.query(`SELECT ${fields.join(', ')} FROM ${object} WHERE ${conds.join(' AND ')}`);
        return rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const f of select) {
            const [head, tail] = f.split('.');
            const v = r[head ?? f];
            out[f] = tail ? (v && typeof v === 'object' ? (v as Record<string, unknown>)[tail] : null) : v;
          }
          return out;
        });
      },
      async adoptCreated(as, object, id) {
        const e = engines[0];
        if (!e) throw new QAError('DATA', 'adoptCreated needs data.create first (the run tag comes from the plan)');
        uniques++;
        return e.adoptCreated(as, object, id, sf.identity.userId, since);
      },
    };
    await use(data);

    // Teardown: reverse-order cleanup of everything this test created or adopted, verified by re-query.
    const keep = process.env['QA_KEEP_DATA'] === '1';
    const last = engines[engines.length - 1];
    if (!last) return;
    const cleanup = await last.cleanup({ keep });
    writeDataOutputs(dir, { plan: last.plan, created: last.createdRecords(), cleanup });
    await testInfo.attach('data-cleanup.json', {
      body: JSON.stringify(cleanup, null, 2),
      contentType: 'application/json',
    });
    testInfo.annotations.push({ type: 'data-cleanup', description: `${cleanup.status} (${uniques} adopted)` });
    if (!keep && cleanup.status !== 'CLEAN') {
      throw new QAError('DATA', `cleanup ${cleanup.status}: ${cleanup.verify.remaining.length} record(s) remain`);
    }
  },
});
