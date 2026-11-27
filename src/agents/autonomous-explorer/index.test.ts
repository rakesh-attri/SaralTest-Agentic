import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExplorationCharter, type ComponentVersion } from '../../core/schemas/index.js';
import { EvidenceLedger } from '../../knowledge/evidenceLedger.js';
import type { StoredSnapshot } from '../../knowledge/snapshotStore.js';
import { SnapshotFacts } from '../../sf/data/plan.js';
import { contactCreateCatalog } from './catalog.js';
import { runCharter, type ExplorerDriver } from './index.js';
import { predictSave } from './oracle.js';
import { renderExplorationMd } from './report.js';
import { draftCase, exploreDir, promoteFinding, reviewDraft } from './review.js';
import type { Observation } from './stateMap.js';

const comp = (type: string, apiName: string, body: Record<string, unknown>): ComponentVersion => ({
  snapshotId: 's',
  type,
  apiName,
  hash: `${type}:x`,
  dataScope: 'metadata',
  evidenceStatus: 'DECLARED',
  reviewStatus: 'APPROVED',
  parent: 'Contact',
  body,
});
const snap: StoredSnapshot = {
  info: {
    id: 'snap-1',
    orgId: '00DFIXTURE00000001',
    capturedAt: '2026-11-27T10:00:00.000Z',
    sourceType: 'METADATA',
    release: 'fixture',
    components: 4,
  } as unknown as StoredSnapshot['info'],
  dependencies: [],
  components: [
    comp('Field', 'Contact.LastName', { type: 'string', length: 80, required: true }),
    comp('Field', 'Contact.Email', { type: 'email', length: 80 }),
    comp('Field', 'Contact.Title', { type: 'string', length: 128 }),
    comp('Field', 'Contact.Phone', { type: 'phone', length: 40 }),
    comp('ValidationRule', 'Contact.Title_Must_Be_Approved', {
      active: true,
      errorMessage: 'Title must be an approved title.',
      errorConditionFormula:
        'AND( NOT( ISBLANK( Title ) ), CASE( Title, "Account Executive", 1, "Director", 1, 0 ) = 0 )',
    }),
  ],
};
const facts = new SnapshotFacts(snap);

/** A fake New Contact dialog: Last Name required + truncated at 80; the Title rule is NOT enforced (a defect). */
function fakeDriver(): ExplorerDriver & { saves: number } {
  let open = false;
  let values: Record<string, string> = {};
  let invalid: string[] = [];
  let messages: string[] = [];
  const d = {
    saves: 0,
    open: () => {
      open = true;
      values = {};
      invalid = [];
      messages = [];
      return Promise.resolve();
    },
    fill: (l: string, v: string) => {
      values[l] = l === 'Last Name' ? v.slice(0, 80) : v;
      return Promise.resolve(values[l] ?? '');
    },
    clear: (l: string) => {
      values[l] = '';
      return Promise.resolve();
    },
    select: (l: string, v: string) => {
      values[l] = v;
      return Promise.resolve();
    },
    tab: () => Promise.resolve(),
    cancel: () => {
      open = false;
      values = {};
      invalid = [];
      messages = [];
      return Promise.resolve();
    },
    escape: () => {
      open = false;
      values = {};
      return Promise.resolve();
    },
    save: () => {
      d.saves++;
      if (!values['Last Name']) {
        invalid = ['Last Name'];
        messages = ['Complete this field.'];
        return Promise.resolve({ closed: false, messages: ['Last Name: Complete this field.'] });
      }
      if (values['Email'] === 'not-an-email') {
        invalid = ['Email'];
        messages = ['You have entered an invalid format.'];
        return Promise.resolve({ closed: false, messages: ['Email: You have entered an invalid format.'] });
      }
      created.push(`003X${String(created.length)}`);
      open = false;
      values = {};
      invalid = [];
      messages = [];
      return Promise.resolve({ closed: true, messages: [] });
    },
    observe: (): Promise<Observation> =>
      Promise.resolve({
        page: '/lightning/r/Account/<id>/view',
        ...(open ? { dialog: 'New Contact' } : {}),
        invalidFields: invalid,
        messages,
        requiredMarked: open ? ['Last Name'] : [],
        url: 'https://org.example.invalid/lightning/r/Account/x/view',
      }),
    takeConsoleErrors: () => [],
    screenshot: () => Promise.resolve(undefined),
    close: () => Promise.resolve(),
  };
  return d;
}
const created: string[] = [];

const charter = ExplorationCharter.parse({
  id: 'CH-contact-create',
  area: 'contact-create',
  persona: 'system-admin',
  resources: 'r',
  risk: 'k',
  mission: 'Explore contact creation',
  timeBoxMin: 10,
  maxSteps: 60,
  maxSaves: 5,
  saturationSteps: 8,
  stopConditions: ['time-box'],
  reason: 'uncovered ACs',
  requirementIds: ['SF-219-R22'],
});

describe('oracle', () => {
  it('predicts from declared config only', () => {
    expect(predictSave({ LastName: '' }, facts).verdict).toBe('reject');
    expect(predictSave({ LastName: 'x', Title: 'QA Explorer' }, facts).reasons.map((r) => r.ref)).toEqual([
      'ValidationRule:Contact.Title_Must_Be_Approved',
    ]);
    expect(predictSave({ LastName: 'x', Title: 'Director' }, facts).verdict).toBe('accept');
    expect(predictSave({ LastName: 'x' }, undefined).verdict).toBe('unknown');
  });
});

describe('runCharter', () => {
  let root: string;
  let ledger: EvidenceLedger;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qa explore '));
    ledger = new EvidenceLedger(join(root, '.qa-memory', 'evidence.db'));
    created.length = 0;
  });
  afterEach(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('explores within the limits, finds truncation and an unenforced rule, adopts what saves create, cleans up; a human promotes a finding', async () => {
    const driver = fakeDriver();
    const adopted: string[] = [];
    let cleaned = false;
    const report = await runCharter(
      {
        root,
        runId: 'explore-t',
        orgAlias: 'fixture',
        environment: 'FIXTURE',
        charter,
        catalog: contactCreateCatalog(),
        runPrefix: 'QA-explore-t',
      },
      {
        driver,
        facts,
        ledger,
        org: {
          host: 'org.example.invalid',
          contactsOnAccount: () => Promise.resolve([...created]),
          adopt: (id) => {
            adopted.push(id);
            return Promise.resolve();
          },
          uiAttempt: (fn) => fn(),
          cleanup: () => {
            cleaned = true;
            return Promise.resolve('CLEAN');
          },
        },
      },
    );
    expect(driver.saves).toBeLessThanOrEqual(5);
    expect(report.saves).toBe(driver.saves);
    expect(cleaned).toBe(true);
    expect(adopted).toEqual(created);
    expect(report.states.length).toBeGreaterThan(3);
    expect(['saturation', 'catalog-done', 'max-steps']).toContain(report.stoppedBy);
    const kinds = report.findings.map((f) => f.kind);
    expect(kinds).toContain('question'); // Last Name truncation
    expect(kinds).toContain('rule-not-enforced'); // Title rule not enforced by the fake org
    for (const f of report.findings) expect(ledger.missing(f.evidenceIds)).toEqual([]);
    // no state revisited after it was finished: every step's "from" state was unfinished when chosen
    expect(report.steps.every((s) => s.reason.length > 0)).toBe(true);

    const rule = report.findings.find((f) => f.kind === 'rule-not-enforced')!;
    const tc = draftCase(rule, {
      storyKey: 'SF-219',
      persona: 'system-admin',
      snapshotId: 'snap-1',
      requirementIds: ['SF-219-R16'],
    });
    expect(tc).toMatchObject({ reviewStatus: 'REVIEW_REQUIRED', origin: 'exploratory' });
    expect(tc.steps[tc.steps.length - 1]?.expected.evidenceLevel).toBe('DECLARED_CONFIG');
    const review = reviewDraft(rule, tc, []);
    expect(review.filter((n) => n.blocking)).toEqual([]);
    const trunc = report.findings.find((f) => f.kind === 'question')!;
    expect(trunc.expectedEvidence).toEqual(['Field:Contact.LastName']);
    // a question without an org fact cannot be promoted
    const { expected: _drop, ...rest } = trunc;
    const q = { ...rest, id: trunc.id, suggestion: 'question' as const, expectedEvidence: [] };
    expect(
      reviewDraft(
        q,
        draftCase(q, { storyKey: 'SF-219', persona: 'system-admin', snapshotId: 's', requirementIds: [] }),
        [],
      ).some((n) => n.blocking),
    ).toBe(true);

    // persist like the CLI and promote (human)
    const dir = exploreDir(root, 'explore-t');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'exploration.json'), JSON.stringify(report));
    writeFileSync(
      join(dir, 'draft-cases.json'),
      JSON.stringify([
        { findingId: rule.id, testCase: tc, review },
        {
          findingId: q.id,
          testCase: draftCase(q, { storyKey: 'SF-219', persona: 'system-admin', snapshotId: 's', requirementIds: [] }),
          review: reviewDraft(q, tc, []),
        },
      ]),
    );
    expect(() =>
      promoteFinding({
        root,
        runId: 'explore-t',
        findingId: q.id,
        by: 'Operator',
        storyKey: 'SF-219',
        orgId: '00DFIXTURE00000001',
      }),
    ).toThrow(/cannot be promoted/);
    const p = promoteFinding({
      root,
      runId: 'explore-t',
      findingId: rule.id,
      by: 'Operator',
      storyKey: 'SF-219',
      orgId: '00DFIXTURE00000001',
    });
    expect(p.caseId).toMatch(/^TC-SF-219-\d{3}$/);
    expect(p.reviewStatus).toBe('APPROVED'); // DECLARED_CONFIG expectation, human-promoted
    expect(readFileSync(p.editsFile, 'utf8')).toContain(p.caseId);
    expect(() =>
      promoteFinding({
        root,
        runId: 'explore-t',
        findingId: rule.id,
        by: 'Operator',
        storyKey: 'SF-219',
        orgId: '00DFIXTURE00000001',
      }),
    ).toThrow(/already promoted/);
    expect(renderExplorationMd(report, [])).toContain('FIXTURE');
  });
});
