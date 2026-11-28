import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Experiment, Investigation } from '../../core/schemas/index.js';
import { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import { ApprovalStore } from '../../security/approvals.js';
import { AuditLog } from '../../security/audit.js';
import { Redactor } from '../../security/redact.js';
import { gatePassed, judgeGate } from './gate.js';
import { judgeInvestigation, readDefect } from './index.js';
import { defectSubject, publicationRefusals, publishDefect } from './publish.js';

const at = '2026-11-27T10:00:00.000Z';
const x = (
  kind: Experiment['kind'],
  outcome: Experiment['outcome'],
  data: Record<string, unknown> = {},
  ev: string[] = [],
): Experiment => ({
  id: `X-${kind}`,
  kind,
  action: 'observe',
  question: 'q',
  hypothesisIds: [],
  outcome,
  result: `${kind} ${outcome}`,
  data,
  evidenceIds: ev,
  at,
});

const defectInv = (): Investigation => ({
  failureId: 'F-run-TC-SF-219-031',
  caseId: 'TC-SF-219-031',
  persona: 'system-admin',
  observations: ['state FAIL', 'ASSERTION_MISMATCH: Expected: 1 Received: 0'],
  hypotheses: [
    {
      id: 'H1',
      text: 'The org does not enforce BR-08',
      test: 't',
      evidenceIds: [],
      verdict: 'PRODUCT_DEFECT',
      status: 'SUPPORTED',
    },
  ],
  verdict: 'PRODUCT_DEFECT',
  confidence: 0.9,
  status: 'SUSPECTED',
  signals: [{ kind: 'ASSERTION_MISMATCH', detail: 'x', source: 'error' }],
  evidenceIds: ['EV-1'],
  experiments: [
    x('requirement-trace', 'REFUTES', { evidenceLevel: 'APPROVED_REQUIREMENT', caseStep: 1 }, ['EV-1']),
    x('identity-probe', 'REFUTES'),
    x('health-probe', 'REFUTES'),
    x('soql-ledger', 'REFUTES'),
    x('rerun-fresh-data', 'SUPPORTS', { sameFailure: 2, states: ['FAIL', 'FAIL'], runIds: ['inv-r1', 'inv-r2'] }, [
      'EV-1',
    ]),
    x('api-reproduce', 'SUPPORTS', { caseOpenAndLinked: true }, ['EV-1']),
  ],
});

describe('Defect Judge gate', () => {
  it('passes only when every standard item holds', () => {
    const g = judgeGate(defectInv(), { reproductions: 2, missingEvidence: [], sanitized: true });
    expect(gatePassed(g)).toBe(true);
    const noApi = defectInv();
    noApi.experiments = noApi.experiments.filter((e) => e.kind !== 'api-reproduce');
    const env = defectInv();
    env.signals.push({ kind: 'HTTP_5XX', detail: '503', source: 'e' });
    expect(judgeGate(noApi, { reproductions: 2, missingEvidence: [], sanitized: true }).missing).toEqual([
      'reproduced once through the API',
    ]);
    expect(judgeGate(env, { reproductions: 2, missingEvidence: ['EV-X'], sanitized: true }).missing).toHaveLength(2);
  });
});

describe('judgeInvestigation + publication', () => {
  let root: string;
  let ledger: EvidenceLedger;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qa judge '));
    ledger = new EvidenceLedger(join(root, '.qa-memory', 'evidence.db'));
    ledger.add({
      id: 'EV-1',
      runId: 'inv',
      kind: 'experiment',
      claim: 'delete succeeded with an open Case',
      sources: [{ type: 'api', ref: 'DELETE' }],
      agent: 'a',
      confidence: 1,
      environment: 'LIVE',
      createdAt: at,
      subject: 'F-run-TC-SF-219-031',
    });
  });
  afterEach(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('without a judge model the draft stays SUSPECTED; the text is sha-bound; tampering is detected', async () => {
    const out = await judgeInvestigation(
      defectInv(),
      {
        root,
        runId: 'inv',
        environment: 'LIVE',
        org: { alias: 'qa-prod', orgId: '00DdN00000uQ5dKUAS', profile: 'dedicated-qa-prod' },
        reproductions: 2,
      },
      { ledger },
    );
    expect(out.draft.status).toBe('SUSPECTED');
    expect(out.draft.judge?.gate.missing).toEqual([]);
    expect(out.draft.faithfulness?.status).toBe('UNEVALUATED');
    expect(out.text).toContain('Status: SUSPECTED');
    expect(out.text).toContain('nothing is posted without the operator');
    expect(readDefect(root, 'inv', out.draft.id).draft.id).toBe(out.draft.id);
    writeFileSync(out.files[0]!, `${readFileSync(out.files[0]!, 'utf8')}x`);
    expect(() => readDefect(root, 'inv', out.draft.id)).toThrow(/sha256 mismatch/);
  });

  it('publication: refused for FIXTURE / SUSPECTED / unapproved / disabled policy; REST post once with approval', async () => {
    const out = await judgeInvestigation(
      defectInv(),
      {
        root,
        runId: 'inv',
        environment: 'FIXTURE',
        org: { alias: 'fixture', orgId: '00DFIXTURE00000001', profile: 'offline-fixture' },
        reproductions: 2,
      },
      { ledger },
    );
    const disabled = { defectPublication: { enabled: false } };
    expect(publicationRefusals({ draft: out.draft, approval: undefined, policy: disabled })).toHaveLength(4);

    const live = { ...out.draft, environment: 'LIVE' as const, status: 'CONFIRMED' as const };
    const store = new ApprovalStore(join(root, 'approvals.jsonl'));
    const approval = store.record({
      checkpoint: 'publish-defect',
      subject: defectSubject(live.id, live.sha256 ?? ''),
      orgId: '00DdN00000uQ5dKUAS',
      approvedBy: 'Operator',
    });
    const policy = { defectPublication: { enabled: true, project: 'SF', fieldMapping: { labels: ['sf-qa-agent'] } } };
    expect(publicationRefusals({ draft: live, approval, policy })).toEqual([]);
    const calls: string[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push(`${url} ${typeof init.body === 'string' ? init.body : ''.slice(0, 40)}`);
      return Promise.resolve(new Response(JSON.stringify({ key: 'SF-999' }), { status: 201 }));
    }) as unknown as typeof fetch;
    const audit = new AuditLog(join(root, 'audit.jsonl'), new Redactor({ secrets: [] }));
    const args = {
      draft: live,
      text: out.text,
      approval,
      policy,
      env: {
        JIRA_BASE_URL: 'https://example.atlassian.net',
        JIRA_EMAIL: 'qa@example.invalid',
        JIRA_API_TOKEN: 'token-123456',
      },
      audit,
      ctx: { runId: 'inv', orgId: '00DdN00000uQ5dKUAS', user: 'sf-qa-agent', persona: 'defect-judge' },
      ledgerFile: join(root, 'publications.jsonl'),
      fetch: fakeFetch,
    };
    expect(await publishDefect(args)).toMatchObject({ key: 'SF-999', via: 'rest' });
    expect(calls[0]).toContain('/rest/api/3/issue');
    await expect(publishDefect(args)).rejects.toThrow(/already posted/);
    expect(audit.read().map((a) => a.outcome)).toEqual(['ALLOWED', 'SUCCEEDED']);
  });
});
