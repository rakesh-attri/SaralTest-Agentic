// API reproductions (defect-investigation SKILL: "ideally once via API to exclude UI issues"). Each reproducer does
// the failing business action through the REST API with fresh, run-tagged data from an approved recipe, records the
// SOQL facts before and after as evidence sources, and always cleans up (verified re-query).
import { join } from 'node:path';
import { QAError } from '../../core/errors.js';
import { querySource, type SourceRef } from '../../knowledge/evidenceLedger.js';
import { WriteLedger } from '../../security/idempotency.js';
import { DataEngine, soqlString } from '../../sf/data/engine.js';
import { dataDir, planData, recipeApproval, writeDataOutputs } from '../../sf/dataFactory.js';
import type { ApiReproduction } from './experiments.js';
import type { ApiReproducer } from './providers.js';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * BR-08 (SF-219-R22, TC-SF-219-031): "A Contact that has open Cases cannot be deleted."
 * Account → Contact → open Case (recipe contact-open-case), then DELETE the Contact through REST.
 * Reproduced = the delete succeeded although the Contact had an open Case.
 */
export const br08DeleteWithOpenCase: ApiReproducer = async ({ sf, ctx, runId, autonomy }) => {
  const { plan } = planData({ ctx, recipe: 'contact-open-case', runId });
  if (!plan.valid)
    throw new QAError('DATA', `recipe contact-open-case is invalid: ${plan.issues.map((i) => i.code).join(', ')}`);
  const approval = recipeApproval(ctx, plan, autonomy);
  if (approval.required && !approval.approval) {
    throw new QAError('DATA', `recipe contact-open-case is not approved for ${ctx.org.alias}: ${approval.command}`);
  }
  const dir = join(dataDir(ctx.run.dir), 'api-repro');
  const engine = new DataEngine({
    sf,
    plan: { ...plan, negatives: [] },
    ledger: new WriteLedger(join(dir, 'writes.jsonl')),
    org: ctx.org,
  });
  writeDataOutputs(dir, { plan: engine.plan });
  const sources: SourceRef[] = [];
  const data: Record<string, unknown> = {};
  try {
    await engine.create();
    const contactId = engine.recordId('Contact');
    const caseId = engine.recordId('Case');
    const qBefore = `SELECT Id, IsClosed, ContactId FROM Case WHERE Id = ${soqlString(caseId)}`;
    const before = await sf.query<{ IsClosed?: boolean; ContactId?: string | null }>(qBefore);
    sources.push(querySource('soql', qBefore, before));
    const open = before[0]?.IsClosed === false && before[0].ContactId === contactId;
    data['caseOpenAndLinked'] = open;
    if (!open)
      return {
        reproduced: false,
        detail: 'precondition not met: the Case is not open and linked to the Contact',
        data,
        sources,
      };
    let deleted = false;
    let refusal: string | undefined;
    try {
      await sf.destroy('Contact', contactId, { untaggedCount: 0 });
      deleted = true;
    } catch (e) {
      refusal = errText(e);
    }
    sources.push({
      type: 'api',
      ref: `DELETE /sobjects/Contact/<run record> → ${deleted ? 'success' : `refused: ${refusal ?? ''}`}`,
    });
    const qAfter = `SELECT Id FROM Contact WHERE Id = ${soqlString(contactId)}`;
    const after = await sf.query(qAfter);
    sources.push(querySource('soql', qAfter, after));
    data['deleteSucceeded'] = deleted;
    data['contactStillExists'] = after.length === 1;
    const r: ApiReproduction =
      deleted && after.length === 0
        ? {
            reproduced: true,
            detail:
              'DELETE of a Contact with an open Case succeeded through the REST API; the Contact no longer exists (BR-08 not enforced)',
            data,
            sources,
          }
        : {
            reproduced: false,
            detail: `the API refused the delete (${refusal ?? 'record still exists'}) — BR-08 enforced`,
            data,
            sources,
          };
    return r;
  } finally {
    const cleanup = await engine.cleanup();
    writeDataOutputs(dir, { plan: engine.plan, created: engine.createdRecords(), cleanup });
    data['cleanup'] = cleanup.status;
  }
};

/** Registered reproductions by case id. */
export const REPRODUCERS: Record<string, ApiReproducer> = {
  'TC-SF-219-031': br08DeleteWithOpenCase,
};
