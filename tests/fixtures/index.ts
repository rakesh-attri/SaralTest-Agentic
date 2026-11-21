// Playwright fixtures for generated tests (playwright-standards skill): tests import `test, expect` from here.
// - persona: the project's persona (config/personas.yaml)
// - sf:      identity-checked GuardedSalesforce for that persona (SOQL oracles; observe only in tests)
// - data:    the data factory (src/sf/dataFactory.ts), one data sub-run per test: approved recipe → plan → create
//            in order → … → reverse-order cleanup verified by re-query in teardown (salesforce-test-data skill).
import { test as base, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Persona } from '../../src/config/schemas.js';
import { QAError } from '../../src/core/errors.js';
import { WriteLedger } from '../../src/security/idempotency.js';
import type { GuardedSalesforce } from '../../src/sf/client.js';
import { createSfContext, type SfContext } from '../../src/sf/context.js';
import { DataEngine } from '../../src/sf/data/engine.js';
import { dataDir, planData, recipeApproval, writeDataOutputs } from '../../src/sf/dataFactory.js';
import { runSettings, type RunSettings } from '../support/runConfig.js';

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
  unique(label: string, format?: 'text' | 'email' | 'phone'): string;
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
    const hash = createHash('sha256').update(testInfo.testId).digest('hex').slice(0, 6);
    const runId = `${sfContext.run.runId}-${hash}`.slice(-50);
    const dir = join(dataDir(sfContext.run.dir), hash);
    const ledger = new WriteLedger(join(dir, 'writes.jsonl'));
    const engines: DataEngine[] = [];
    let uniques = 0;
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
        const status = recipeApproval(sfContext, plan, sfContext.policy.autonomy);
        if (status.required && !status.approval) {
          throw new QAError('DATA', `recipe ${recipe} is not approved for ${sfContext.org.alias}: ${status.command}`);
        }
        const engine = new DataEngine({ sf, plan: { ...plan, negatives: [] }, ledger, org: sfContext.org });
        engines.push(engine);
        await engine.create(steps);
      },
      id: (stepId) => find(stepId).recordId(stepId),
      value(stepId, field) {
        const v = find(stepId).plan.steps.find((s) => s.stepId === stepId)?.fields[field];
        if (typeof v !== 'string') throw new QAError('DATA', `no planned string value for ${stepId}.${field}`);
        return v;
      },
      unique(label, format = 'text') {
        const token = randomBytes(3).toString('hex');
        if (format === 'email') return `qa+${runId}-${label}-${token}@example.invalid`.toLowerCase();
        if (format === 'phone') return `55${String(parseInt(token, 16) % 100_000_000).padStart(8, '0')}`;
        return `QA-${runId}-${label}-${token}`;
      },
      attempt: (stepId, set, remove) => find(stepId).attempt(stepId, set, remove),
      ofLength(length) {
        const seed = `QA-${runId}-`;
        if (length < seed.length)
          return randomBytes(Math.ceil(length / 2))
            .toString('hex')
            .slice(0, length);
        return (seed + 'x'.repeat(length)).slice(0, length);
      },
      update: (stepId, fields) => find(stepId).update(stepId, fields),
      async adopt(as, object, field, value) {
        const e = engines[0];
        if (!e) throw new QAError('DATA', 'adopt needs data.create first (the run tag comes from the plan)');
        uniques++;
        return e.adopt(as, object, field, value);
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
