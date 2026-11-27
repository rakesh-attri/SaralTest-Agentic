// Real providers for the investigator's experiments: GuardedSalesforce (observe calls), the snapshot store, the
// locator registry, the Runner for reruns (fresh data, same persona, assertions untouched) and the registered API
// reproductions. Built per investigation run; each provider fails soft (the experiment becomes ERROR / SKIPPED).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HardStopError } from '../../core/errors.js';
import { StoryManifest } from '../../core/schemas/index.js';
import { registryFile } from '../../cli/locators.js';
import { LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../../knowledge/snapshotStore.js';
import { executeStory, type ExecuteDeps } from '../../runner/execute.js';
import type { GuardedSalesforce } from '../../sf/client.js';
import type { SfContext } from '../../sf/context.js';
import { SnapshotFacts } from '../../sf/data/plan.js';
import { staleDependencies } from '../test-generator/dependencies.js';
import { registryLookup, storyManifestFile } from '../test-generator/staleness.js';
import { storyOf } from './context.js';
import type { ApiReproduction, InvestigationProviders, ObjectAccess, RerunOutcome } from './experiments.js';

/** API reproductions by case id (registered in T6 for BR-08). */
export type ApiReproducer = (o: { sf: GuardedSalesforce; ctx: SfContext; runId: string }) => Promise<ApiReproduction>;
export const API_REPRODUCERS = new Map<string, ApiReproducer>();

export interface ProviderOptions {
  root: string;
  /** Investigation run id; reruns get `<runId>-<label>` (≤ 40 chars). */
  runId: string;
  orgAlias: string;
  ctx: SfContext;
  sf: GuardedSalesforce;
  /** Reruns execute tests (data created through the guard, cleaned up). Off with --no-reruns. */
  reruns: boolean;
  say: (m: string) => void;
  executeDeps?: ExecuteDeps;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createProviders(o: ProviderOptions): InvestigationProviders {
  const snapshots = new SnapshotStore(join(o.root, '.qa-memory', 'knowledge.db'));
  const info = snapshots.latest(o.ctx.org.orgId);
  const snap = info ? snapshots.get(info.id) : undefined;
  const facts = snap ? new SnapshotFacts(snap) : undefined;
  const registry = existsSync(registryFile(o.root)) ? new LocatorRegistry(registryFile(o.root)) : undefined;
  let rerunSeq = 0;
  return {
    probe: async () => {
      try {
        const sf = await o.ctx.connect(); // identity check (org, user, instance)
        try {
          await sf.query('SELECT Id FROM Organization LIMIT 1');
          return { identityOk: true, healthy: true, detail: 'identity verified; REST answers' };
        } catch (e) {
          const t = errText(e);
          return {
            identityOk: true,
            healthy: false,
            detail: t,
            ...(/\b(5\d\d)\b/.exec(t)?.[1] ? { status: Number(/\b(5\d\d)\b/.exec(t)?.[1]) } : {}),
          };
        }
      } catch (e) {
        if (e instanceof HardStopError) return { identityOk: false, healthy: true, detail: errText(e) };
        return { identityOk: true, healthy: false, detail: errText(e) };
      }
    },
    query: (soql) => o.sf.query(soql),
    access: async (object): Promise<ObjectAccess | undefined> => {
      try {
        const d = await o.sf.describe(object);
        return {
          queryable: d['queryable'] !== false,
          createable: d['createable'] !== false,
          updateable: d['updateable'] !== false,
          deletable: d['deletable'] !== false,
        };
      } catch {
        return undefined;
      }
    },
    ...(facts
      ? {
          validationRules: (object: string) =>
            facts.activeValidationRules(object).map((c) => ({
              name: c.apiName.split('.').slice(1).join('.') || c.apiName,
              ...(typeof c.body?.['errorMessage'] === 'string' ? { errorMessage: c.body['errorMessage'] } : {}),
            })),
        }
      : {}),
    staleComponents: (caseId) => {
      const story = storyOf(caseId);
      if (!story) return [];
      const file = storyManifestFile(o.root, story);
      if (!existsSync(file)) return [];
      const m = StoryManifest.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      const a = m.success
        ? m.data.artifacts.find((x) => x.kind === 'spec' && x.testCaseIds.includes(caseId))
        : undefined;
      if (!a) return [];
      const marked = a.stale?.components ?? [];
      const now =
        facts && registry && a.dependsOn && (!m.success || m.data.org === o.orgAlias)
          ? staleDependencies(a.dependsOn, facts, registryLookup(registry.list({ org: o.ctx.org.orgId })))
          : [];
      return [...new Set([...marked, ...now])];
    },
    ...(o.reruns
      ? {
          rerun: async ({ caseId, label, waitFactor }): Promise<RerunOutcome> => {
            const story = storyOf(caseId);
            const runId = `${o.runId}-${label}${++rerunSeq}`.slice(0, 40);
            if (!story) return { runId, result: undefined };
            o.say(`    rerun ${caseId} → ${runId}${waitFactor ? ` (waits ×${waitFactor})` : ''}`);
            try {
              const out = await executeStory(
                {
                  root: o.root,
                  runId,
                  storyKey: story,
                  orgAlias: o.orgAlias,
                  cases: [caseId],
                  echo: false,
                  say: () => undefined,
                  redact: (s) => o.ctx.redactor.redactText(s),
                  extraEnv: { QA_RETRIES: '0', ...(waitFactor ? { QA_WAIT_FACTOR: String(waitFactor) } : {}) },
                },
                o.executeDeps ?? {},
              );
              return { runId, result: out.results.find((r) => r.caseId === caseId) };
            } catch (e) {
              if (e instanceof HardStopError) throw e;
              o.say(`    rerun failed: ${errText(e)}`);
              return { runId, result: undefined };
            }
          },
        }
      : {}),
    apiReproduce: async (caseId) => {
      const f = API_REPRODUCERS.get(caseId);
      if (!f) return undefined;
      return f({ sf: o.sf, ctx: o.ctx, runId: `${o.runId}-api`.slice(0, 40) });
    },
  };
}
