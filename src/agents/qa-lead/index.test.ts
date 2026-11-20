import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { projectPaths, requireConfig } from '../../config/loader.js';
import type { PolicyResponse } from '../../config/schemas.js';
import { createIssue } from '../../core/issues.js';
import { ISSUE_KINDS, type IssueKind } from '../../core/schemas/index.js';
import { applyReorder, triageIssue, type NodeCapabilities } from './triage.js';

const policy = await requireConfig('policy', projectPaths(REPO_ROOT));
const ALL: NodeCapabilities = { retry: true, fallback: true, degrade: true, ask: true };
const NONE: NodeCapabilities = { retry: false, fallback: false, degrade: false, ask: false };
const issue = (kind: IssueKind, detail?: unknown) =>
  createIssue({ kind, node: 'understand', message: 'x', ...(detail !== undefined ? { detail } : {}) });

describe('QA Lead triage (config/policy.yaml)', () => {
  it.each(ISSUE_KINDS)(
    '%s → only a response from its policy list (or report-only), never anything else',
    async (kind) => {
      for (const caps of [ALL, NONE]) {
        const d = await triageIssue(issue(kind), policy, caps, { applied: {} });
        const allowed: readonly string[] = policy.issues[kind] ?? [];
        expect(d.response === 'report-only' || allowed.includes(d.response)).toBe(true);
        expect(d.reason.length).toBeGreaterThan(5);
      }
    },
  );

  it('HARD_STOP → halt, always', async () => {
    expect((await triageIssue(issue('HARD_STOP'), policy, ALL, { applied: {} })).response).toBe('halt');
  });

  it('retries with policy backoff until the limit, then moves to the next response', async () => {
    const steps: string[] = [];
    const applied: Partial<Record<PolicyResponse, number>> = {};
    for (let i = 0; i < 5; i++) {
      const d = await triageIssue(issue('TRANSIENT'), policy, { ...ALL, fallback: false }, { applied });
      steps.push(`${d.response}${d.delaySeconds !== undefined ? `@${d.delaySeconds}` : ''}`);
      if (d.response !== 'report-only') applied[d.response] = (applied[d.response] ?? 0) + 1;
    }
    expect(steps).toEqual(['retry@2', 'retry@8', 'retry@30', 'escalate', 'escalate']);
  });

  it('skips responses already performed inside the component (reflect-retry + fallback model) → degrade', async () => {
    const d = await triageIssue(issue('INVALID_LLM_OUTPUT', { handled: ['retry', 'fallback'] }), policy, ALL, {
      applied: {},
    });
    expect(d.response).toBe('degrade');
    expect(d.resolution).toBe('DEGRADED');
    expect(d.reason).toMatch(/retry skipped \(already done inside the component\)/);
  });

  it('non-retryable input errors (DATA) skip retry; AMBIGUOUS_SPEC asks; nothing applicable → report-only', async () => {
    expect(
      (await triageIssue(issue('DATA', { retryable: false }), policy, { ...ALL, fallback: false }, { applied: {} }))
        .response,
    ).toBe('degrade');
    expect((await triageIssue(issue('AMBIGUOUS_SPEC'), policy, ALL, { applied: {} })).response).toBe('ask');
    const d = await triageIssue(issue('LOCATOR'), policy, NONE, { applied: {} });
    expect(d.response).toBe('report-only');
    expect(d.reason).toMatch(/investigate skipped \(handled by a later-phase agent\)/);
  });

  it('a reorder hook may reorder the allowed list but cannot add responses (PLAN.md §5)', async () => {
    expect(applyReorder(['retry', 'fallback', 'escalate'], ['escalate', 'file_bug', 'retry'])).toEqual({
      order: ['escalate', 'retry', 'fallback'],
      rejected: ['file_bug'],
    });
    const d = await triageIssue(issue('TRANSIENT'), policy, ALL, { applied: {} }, () =>
      Promise.resolve({ order: ['halt', 'escalate'], reason: 'org is down for everyone' }),
    );
    expect(d.response).toBe('escalate');
    expect(d.reason).toMatch(/rejected responses not in policy: halt/);
  });
});
