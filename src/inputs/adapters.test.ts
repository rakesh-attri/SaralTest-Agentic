import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QAError } from '../core/errors.js';
import { SourceDocument, ManualTestCase } from '../core/schemas/index.js';
import { makeDocx, makePdf, writeXlsx } from '../../tests/helpers/inputDocs.js';
import { adfToText, jiraIssueToDocument, JiraIssue } from './adapters/jira.js';
import { parseCsv, normalizePriority, normalizeStatus } from './adapters/manualTests.js';
import { componentFromPath } from './adapters/other.js';
import { resolveInput } from './index.js';
import type { AdapterContext } from './types.js';

let dir: string;
const ctx = (extra: Partial<AdapterContext> = {}): AdapterContext => ({ root: dir, cwd: dir, env: {}, ...extra });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'qa inputs with spaces '));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const expectQAError = async (p: Promise<unknown>, kind: string): Promise<void> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(QAError);
  expect((err as QAError).kind).toBe(kind);
};

describe('file adapters', () => {
  it('markdown story → valid SourceDocument with AC refs', async () => {
    const f = join(dir, 'story one.md');
    writeFileSync(
      f,
      '**Summary:** Log calls\n\nAs an agent I log calls.\n\nAC1 – Log\nGiven a Case\nThen a Task exists\n',
    );
    const out = await resolveInput({ kind: 'file', value: 'story one.md' }, ctx());
    const doc = SourceDocument.parse(out.documents[0]);
    expect(doc.title).toBe('Log calls');
    expect(doc.sections.map((s) => s.ref)).toContain('AC1');
    expect(doc.source.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('PDF → text with rule ids, header version and doc id; page markers dropped', async () => {
    const f = join(dir, 'rules.pdf');
    writeFileSync(
      f,
      makePdf([
        'Order Rules',
        'Document ID: ORD-7 - Version 2.1',
        '1. Business rules',
        'OR-01 Every Order needs a Customer.',
        'OR-02 Quantity is at most 999.',
      ]),
    );
    const out = await resolveInput({ kind: 'file', value: f }, ctx());
    const doc = SourceDocument.parse(out.documents[0]);
    expect(doc.docId).toBe('ORD-7');
    expect(doc.source.version).toBe('2.1');
    expect(doc.sections.find((s) => s.ref === 'OR-02')?.kind).toBe('rule');
    expect(doc.text).not.toMatch(/-- 1 of 1 --/);
  });

  it('corrupt PDF → DATA QAError (QA Lead skips the input, run continues)', async () => {
    const f = join(dir, 'broken.pdf');
    writeFileSync(f, 'this is not a pdf');
    await expectQAError(resolveInput({ kind: 'file', value: f }, ctx()), 'DATA');
  });

  it('DOCX → headings and paragraphs', async () => {
    const f = join(dir, 'spec.docx');
    writeFileSync(
      f,
      await makeDocx(['# Business rules', 'BR-01 A Case needs a Contact.', '# Assumptions', 'Users are internal.']),
    );
    const out = await resolveInput({ kind: 'file', value: f }, ctx());
    const doc = SourceDocument.parse(out.documents[0]);
    expect(doc.sections.find((s) => s.ref === 'BR-01')?.heading).toBe('Business rules');
    expect(doc.sections.find((s) => s.text === 'Users are internal.')?.kind).toBe('assumption');
  });

  it('Gherkin → scenarios, tag refs and rules', async () => {
    const f = join(dir, 'calls.feature');
    writeFileSync(
      f,
      'Feature: Calls\n  Agents log calls.\n  Rule: Subject required\n    @AC2\n    Scenario: No subject\n      Given a Case\n      When I save without Subject\n      Then an error is shown\n  Scenario Outline: Durations\n    Given duration <d>\n    Examples:\n      | d |\n      | 0 |\n',
    );
    const doc = SourceDocument.parse((await resolveInput({ kind: 'file', value: f }, ctx())).documents[0]);
    expect(doc.sections.map((s) => `${s.ref}:${s.kind}`)).toEqual([
      'S1:description',
      'RULE1:rule',
      'AC2:scenario',
      'SC2:scenario',
    ]);
    expect(doc.sections[3]?.text).toContain('| 0 |');
  });

  it('JSON/YAML spec → typed sections; unknown shape kept as text', async () => {
    const y = join(dir, 'spec.yaml');
    writeFileSync(
      y,
      'key: ORD-9\ntitle: Orders\nversion: 3\nacceptanceCriteria:\n  - Order saves\n  - id: AC7\n    text: Total shown\nrules: [Max 999 items]\n',
    );
    const doc = SourceDocument.parse((await resolveInput({ kind: 'file', value: y }, ctx())).documents[0]);
    expect(doc.docId).toBe('ORD-9');
    expect(doc.sections.map((s) => s.ref)).toEqual(['AC1', 'AC7', 'R1']);
    const j = join(dir, 'other.json');
    writeFileSync(j, JSON.stringify({ anything: 'goes here' }));
    const d2 = SourceDocument.parse((await resolveInput({ kind: 'file', value: j }, ctx())).documents[0]);
    expect(d2.text).toContain('goes here');
  });

  it('unsupported format and missing file → DATA', async () => {
    writeFileSync(join(dir, 'old.doc'), 'x');
    await expectQAError(resolveInput({ kind: 'file', value: 'old.doc' }, ctx()), 'DATA');
    await expectQAError(resolveInput({ kind: 'file', value: 'nope.md' }, ctx()), 'DATA');
  });
});

describe('manual test cases', () => {
  const header = [
    'Test ID',
    'Title',
    'Requirement Ref',
    'Persona',
    'Preconditions',
    'Steps',
    'Expected Result',
    'Priority',
    'Type',
    'Last Run Status',
    'Last Run Date',
    'Owner',
  ];
  it('xlsx: finds the test sheet after a Read Me tab, maps aliases, splits steps, normalizes status/priority', async () => {
    const f = join(dir, 'cases.xlsx');
    await writeXlsx(f, header, [
      [
        'TC-1',
        'Save order',
        'AC1, OR-01',
        'Clerk',
        'Customer exists',
        '1. Open\n2. Save',
        'Saved',
        'High',
        'Functional',
        'Failed',
        '2026-01-02',
        'x',
      ],
      ['TC-2', 'Orphan', '(none)', 'Clerk', '', '1. Do', 'Done', 'P3', 'Negative', '', '', 'x'],
      ['TC-2', 'Dup id', 'AC1', '', '', '', '', '', '', '', '', ''],
    ]);
    const out = await resolveInput({ kind: 'manual-tests', value: f }, ctx());
    const tests = out.tests.map((t) => ManualTestCase.parse(t));
    expect(tests).toHaveLength(2);
    expect(tests[0]).toMatchObject({
      requirementRefs: ['AC1', 'OR-01'],
      steps: ['Open', 'Save'],
      priority: 'P1',
      lastRun: { status: 'FAIL', date: '2026-01-02' },
      row: 2,
    });
    expect(tests[1]?.requirementRefs).toEqual([]);
    expect(tests[1]?.lastRun.status).toBe('NOT_RUN');
    expect(out.notes.join(' ')).toMatch(/ignored columns: Owner/);
    expect(out.notes.join(' ')).toMatch(/duplicate Test ID TC-2/);
    expect(out.documents[0]?.sections.map((s) => s.ref)).toEqual(['TC-1', 'TC-2']);
  });

  it('csv with quoted multi-line steps', async () => {
    const f = join(dir, 'cases.csv');
    writeFileSync(f, 'ID,Name,Covers,Steps,Status\r\nT-9,"Quote ""x""",AC3,"1. a\n2. b",Passed\r\n');
    const out = await resolveInput({ kind: 'manual-tests', value: f }, ctx());
    expect(out.tests[0]).toMatchObject({ id: 'T-9', title: 'Quote "x"', requirementRefs: ['AC3'], steps: ['a', 'b'] });
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('a sheet without Test ID / Title → DATA', async () => {
    const f = join(dir, 'bad.csv');
    writeFileSync(f, 'Foo,Bar\n1,2\n');
    await expectQAError(resolveInput({ kind: 'manual-tests', value: f }, ctx()), 'DATA');
    expect(normalizePriority('critical')).toBe('P0');
    expect(normalizeStatus('Not Run')).toBe('NOT_RUN');
  });
});

describe('JIRA adapter (MCP → REST fallback)', () => {
  const adf = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'As an agent I log calls.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance criteria', marks: [{ type: 'strong' }] }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'AC1 – Log' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Then a Task exists' },
        ],
      },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }] }],
      },
    ],
  };
  const issue = {
    key: 'QA-7',
    fields: {
      summary: 'Log calls',
      description: adf,
      issuetype: { name: 'Story' },
      status: { name: 'To Do' },
      labels: ['calls'],
      components: [{ name: 'Cases' }],
      updated: '2026-11-01T10:00:00.000+0000',
      customfield_100: 'AC2 – Subject required\nThen an error is shown',
      issuelinks: [{ type: { outward: 'blocks' }, outwardIssue: { key: 'QA-8' } }],
      comment: {
        comments: [
          { body: 'Please also cover the duration boundary of zero minutes.', created: '2026-11-02T00:00:00Z' },
        ],
      },
    },
    names: { customfield_100: 'Acceptance Criteria' },
  };
  const env = {
    JIRA_BASE_URL: 'https://example.atlassian.net',
    JIRA_EMAIL: 'qa@example.test',
    JIRA_API_TOKEN: 'tok-123456789',
  };

  it('ADF → text keeps bold labels, line breaks and lists', () => {
    expect(adfToText(adf)).toContain('**Acceptance criteria**');
    expect(adfToText(adf)).toContain('AC1 – Log\nThen a Task exists');
    expect(adfToText(adf)).toContain('- note');
  });

  it('issue → document with ACs from description and AC custom field, links, comments', () => {
    const doc = SourceDocument.parse(jiraIssueToDocument(JiraIssue.parse(issue), env.JIRA_BASE_URL));
    expect(doc.docId).toBe('QA-7');
    expect(doc.source).toMatchObject({
      type: 'jira',
      ref: 'https://example.atlassian.net/browse/QA-7',
      version: '2026-11-01T10:00:00.000+0000',
    });
    expect(doc.sections.filter((s) => s.kind === 'ac').map((s) => s.ref)).toEqual(['AC1', 'AC2']);
    expect(doc.sections.find((s) => s.ref === 'CM-1')?.kind).toBe('text');
    expect(doc.meta['links']).toEqual(['blocks QA-8']);
  });

  it('MCP down → REST fallback (note recorded, Basic auth header, no token in note)', async () => {
    const mcp = { callTool: vi.fn().mockRejectedValue(new QAError('TOOL_UNAVAILABLE', 'connect failed')) };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(issue), { status: 200 }));
    const out = await resolveInput(
      { kind: 'jira', value: 'qa-7' },
      ctx({
        env,
        mcp,
        callCtx: { runId: 'r', orgId: 'o', user: 'u', persona: 'p' },
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );
    expect(out.via).toBe('jira:rest');
    expect(out.notes[0]).toMatch(/Atlassian MCP unavailable \(TOOL_UNAVAILABLE/);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.atlassian.net/rest/api/3/issue/QA-7?expand=names');
    expect(JSON.stringify(init.headers)).toMatch(/Basic /);
    expect(out.notes.join(' ')).not.toContain('tok-123456789');
  });

  it('MCP path used when it answers', async () => {
    const mcp = {
      callTool: vi.fn((_s: string, tool: string) =>
        Promise.resolve({
          result: { content: [] },
          class: 'observe' as const,
          text:
            tool === 'getAccessibleAtlassianResources'
              ? JSON.stringify([{ id: 'cloud-1', url: 'https://example.atlassian.net' }])
              : JSON.stringify(issue),
        }),
      ),
    };
    const out = await resolveInput(
      { kind: 'jira', value: 'QA-7' },
      ctx({ env, mcp, callCtx: { runId: 'r', orgId: 'o', user: 'u', persona: 'p' } }),
    );
    expect(out.via).toBe('jira:mcp');
    expect(mcp.callTool).toHaveBeenLastCalledWith(
      'atlassian-rovo',
      'getJiraIssue',
      { cloudId: 'cloud-1', issueIdOrKey: 'QA-7', expand: 'names' },
      expect.anything(),
    );
  });

  it('REST 401 → AUTH, 404 → DATA, 503 → TRANSIENT; bad key and missing config refused', async () => {
    for (const [status, kind] of [
      [401, 'AUTH'],
      [404, 'DATA'],
      [503, 'TRANSIENT'],
    ] as const) {
      const f = vi.fn().mockResolvedValue(new Response('{}', { status }));
      await expectQAError(
        resolveInput({ kind: 'jira', value: 'QA-7' }, ctx({ env, fetch: f as unknown as typeof fetch })),
        kind,
      );
    }
    await expectQAError(resolveInput({ kind: 'jira', value: 'not a key' }, ctx({ env })), 'DATA');
    await expectQAError(resolveInput({ kind: 'jira', value: 'QA-7' }, ctx()), 'TOOL_UNAVAILABLE');
  });

  it('defects: JQL via REST + past FAIL results', async () => {
    const runDir = join(dir, 'runs', 'run-old');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'results.json'),
      JSON.stringify([
        {
          testId: 'TC-1',
          state: 'FAIL',
          reason: 'timeout',
          evidenceIds: [],
          environment: 'FIXTURE',
          snapshotId: 's',
          runId: 'run-old',
        },
        { testId: 'TC-2', state: 'PASS', evidenceIds: [], environment: 'FIXTURE', snapshotId: 's', runId: 'run-old' },
      ]),
    );
    const f = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ issues: [{ ...issue, key: 'QA-9', fields: { ...issue.fields, summary: 'Bug' } }] }),
          { status: 200 },
        ),
      );
    const out = await resolveInput(
      { kind: 'defects', value: 'project = QA AND type = Bug' },
      ctx({ env, fetch: f as unknown as typeof fetch }),
    );
    expect(out.defects.map((d) => d.key)).toEqual(['QA-9', 'TC-1@run-old']);
    expect(out.defects[1]?.summary).toContain('[FIXTURE]');
  });
});

describe('other adapters', () => {
  it('chat text and exploratory objective', async () => {
    const out = await resolveInput({ kind: 'chat', value: 'Agents log calls.\nAC1 Then a Task exists' }, ctx());
    expect(out.documents[0]?.source.type).toBe('chat');
    expect(out.documents[0]?.sections.map((s) => s.ref)).toContain('AC1');
    const o = await resolveInput({ kind: 'objective', value: 'Explore Contact edit as Read Only' }, ctx());
    expect(o.objectives[0]?.id).toMatch(/^OBJ-/);
    await expectQAError(resolveInput({ kind: 'objective', value: '  ' }, ctx()), 'DATA');
  });

  it('ADO not configured → TOOL_UNAVAILABLE with the missing settings named', async () => {
    const err = await resolveInput({ kind: 'ado', value: '42' }, ctx()).catch((e: unknown) => e);
    expect((err as QAError).kind).toBe('TOOL_UNAVAILABLE');
    expect((err as QAError).message).toMatch(/ADO_ORG_URL and ADO_PAT/);
  });

  it('git diff → metadata components (Windows separators, dedupe, refuses option-like refs)', async () => {
    expect(
      componentFromPath(
        'force-app\\main\\default\\objects\\Contact\\validationRules\\Phone_10.validationRule-meta.xml',
      ),
    ).toEqual({
      type: 'ValidationRule',
      apiName: 'Contact.Phone_10',
      path: 'force-app\\main\\default\\objects\\Contact\\validationRules\\Phone_10.validationRule-meta.xml',
    });
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stderr: '',
      stdout:
        'M\tforce-app/main/default/lwc/contactCard/contactCard.js\nM\tforce-app/main/default/lwc/contactCard/contactCard.html\nA\tforce-app/main/default/classes/ContactSvc.cls\nM\tREADME.md\n',
    });
    const out = await resolveInput({ kind: 'git-diff', value: 'origin/main' }, ctx({ exec }));
    expect(out.changes).toEqual([
      {
        type: 'LightningComponentBundle',
        apiName: 'contactCard',
        path: 'force-app/main/default/lwc/contactCard/contactCard.js',
        change: 'MODIFIED',
      },
      {
        type: 'ApexClass',
        apiName: 'ContactSvc',
        path: 'force-app/main/default/classes/ContactSvc.cls',
        change: 'ADDED',
      },
    ]);
    await expectQAError(resolveInput({ kind: 'git-diff', value: '--output=x' }, ctx({ exec })), 'DATA');
  });
});
