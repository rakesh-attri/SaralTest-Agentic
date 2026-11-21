import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyError } from '../core/classifyError.js';
import { AuditLog } from './audit.js';
import { WriteLedger, idempotencyKey } from './idempotency.js';
import { REDACTED, Redactor } from './redact.js';

const SECRET = 'my-very-secret-jira-token-xyz';

describe('Redactor — secrets (never recoverable)', () => {
  const r = new Redactor({ secrets: [SECRET] });
  it.each([
    ['exact configured secret', `token=${SECRET} end`],
    ['Google API key', 'key AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['Anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'],
    ['OpenAI key', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123'],
    ['Langfuse secret', 'sk-lf-1234abcd-5678-90ef-aaaa-bbbbccccdddd'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['Bearer header', 'Authorization: Bearer abcdefghijklmnop123456'],
    ['Salesforce session id', '00D5g000004ABCD!AQ8AQPx1yZbcdefghijklmnopqrstuvwxyz0123456789'],
    ['Atlassian token', 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz'],
    ['private key', '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----'],
  ])('%s', (_label, text) => {
    const out = r.redactText(text);
    expect(out).toContain(REDACTED);
    expect(r.reveal(out)).toBe(out); // secrets are never in the mapping
  });

  it('secret-named keys are redacted whatever the value', () => {
    expect(
      r.redactValue({ password: 'hunter2', 'x-api-key': 'k', access_token: 't', headers: { Authorization: 'x' } }),
    ).toEqual({
      password: REDACTED,
      'x-api-key': REDACTED,
      access_token: REDACTED,
      headers: { Authorization: REDACTED },
    });
  });

  it('secrets are masked even with PII masking disabled', () => {
    const off = new Redactor({ secrets: [SECRET], piiEnabled: false });
    expect(off.redactText(`${SECRET} a@b.com`)).toBe(`${REDACTED} a@b.com`);
  });
});

describe('Redactor — PII (stable local tokens)', () => {
  let r: Redactor;
  beforeEach(() => {
    r = new Redactor();
  });

  it('emails, phones and Salesforce IDs get stable tokens', () => {
    const t1 = r.redactText('Mail jane.doe@acme.example or call +1 (415) 555-0134 about 0015g00000XyZabAAB');
    expect(t1).toBe('Mail <EMAIL_1> or call <PHONE_1> about <SFID_1>');
    expect(r.redactText('again jane.doe@acme.example')).toBe('again <EMAIL_1>');
    expect(r.redactText('second bob@acme.example')).toBe('second <EMAIL_2>');
  });

  it('does not mangle dates, versions, times or plain words', () => {
    const s = 'Run on 2026-11-20 at 12:30:45 with v1.4.2, 127.0.0.1, AccountId and ContactRelation';
    expect(r.redactText(s)).toBe(s);
  });

  it('masks known personal fields in nested objects (Salesforce record shape)', () => {
    const rec = {
      attributes: { type: 'Contact' },
      Id: '0035g00000AbCdEAAZ',
      FirstName: 'Jane',
      LastName: 'Doe',
      Email: 'jane@acme.example',
      MailingStreet: '1 Market St',
      Account: { Name: 'Acme Corp', Phone: '415-555-0100' },
      Industry: 'Banking',
      tags: ['call 415-555-0199'],
    };
    const out = r.redactValue(rec);
    expect(out).toEqual({
      attributes: { type: 'Contact' },
      Id: '<SFID_1>',
      FirstName: '<NAME_1>',
      LastName: '<NAME_2>',
      Email: '<EMAIL_1>',
      MailingStreet: '<ADDRESS_1>',
      Account: { Name: '<NAME_3>', Phone: '<PHONE_1>' },
      Industry: 'Banking',
      tags: ['call <PHONE_2>'],
    });
    expect(JSON.stringify(out)).not.toMatch(/Jane|Doe|acme\.example|Market|415-555/);
  });

  it('mapping stays local and reveal() restores values for the operator', async () => {
    const red = r.redactText('ping jane@acme.example');
    expect(r.reveal(red)).toBe('ping jane@acme.example');
    const dir = await mkdtemp(join(tmpdir(), 'qa redact '));
    const file = join(dir, 'runs', 'r1', 'redaction-map.json');
    r.saveMapping(file);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ '<EMAIL_1>': 'jane@acme.example' });
    await rm(dir, { recursive: true, force: true });
  });

  it('handles circular structures and Errors', () => {
    const a: Record<string, unknown> = { email: 'x@y.example' };
    a['self'] = a;
    expect(r.redactValue(a)).toEqual({ email: '<EMAIL_1>', self: '[Circular]' });
    expect(r.redactValue(new Error('failed for x@y.example'))).toEqual({
      name: 'Error',
      message: 'failed for <EMAIL_1>',
    });
  });

  it('record-id masking can be turned off', () => {
    expect(new Redactor({ maskRecordIds: false }).redactText('id 0015g00000XyZabAAB')).toBe('id 0015g00000XyZabAAB');
  });
});

describe('AuditLog', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa audit '));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends validated, redacted JSONL entries', () => {
    const log = new AuditLog(join(dir, 'runs', 'run-x', 'audit.jsonl'), new Redactor());
    log.append({
      runId: 'run-x',
      orgId: '00DFIXTURE00000001',
      user: 'qa.admin',
      persona: 'system-admin',
      action: 'mutate',
      tool: 'salesforce.create_record',
      object: 'Contact',
      after: { LastName: 'Doe', Email: 'jane@acme.example' },
      outcome: 'SUCCEEDED',
    });
    const entries = log.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.after).toEqual({ LastName: '<NAME_1>', Email: '<EMAIL_1>' });
    expect(entries[0]?.at).toMatch(/Z$/);
  });

  it('rejects malformed entries', () => {
    const log = new AuditLog(join(dir, 'a.jsonl'), new Redactor());
    expect(() =>
      log.append({ runId: 'r', orgId: 'o', user: 'u', persona: 'p', action: 'delete' as 'mutate', tool: 't' }),
    ).toThrow();
  });
});

describe('idempotency', () => {
  it('keys are deterministic and field-order independent', () => {
    const a = idempotencyKey('run-1', 'Account', 'create-account', { Name: 'A', Industry: 'X' });
    const b = idempotencyKey('run-1', 'Account', 'create-account', { Industry: 'X', Name: 'A' });
    expect(a).toBe(b);
    expect(a).toMatch(/^qa-[0-9a-f]{24}$/);
    expect(idempotencyKey('run-2', 'Account', 'create-account', { Name: 'A', Industry: 'X' })).not.toBe(a);
  });

  it('enforces the state machine and blocks blind retries of uncertain writes', async () => {
    const l = new WriteLedger();
    const w = l.plan({ runId: 'run-1', object: 'Account', step: 's1', fields: { Name: 'A' } });
    expect(l.canSend(w.idempotencyKey)).toBe(true);
    l.transition(w.idempotencyKey, 'SENT');
    l.transition(w.idempotencyKey, 'UNCERTAIN');
    expect(l.canSend(w.idempotencyKey)).toBe(false);
    const err = (() => {
      try {
        l.transition(w.idempotencyKey, 'SENT');
      } catch (e) {
        return e;
      }
    })();
    expect(classifyError(err).kind).toBe('DATA');
    // reconcile: record not found → PLANNED, now safe to send again
    await l.reconcile(w.idempotencyKey, () => Promise.resolve(undefined));
    expect(l.canSend(w.idempotencyKey)).toBe(true);
  });

  it('reconcile finds an existing record → CONFIRMED, no second write', async () => {
    const l = new WriteLedger();
    const w = l.plan({ runId: 'run-1', object: 'Contact', step: 's2', fields: {} });
    l.transition(w.idempotencyKey, 'SENT');
    l.transition(w.idempotencyKey, 'UNCERTAIN');
    const done = await l.reconcile(w.idempotencyKey, () => Promise.resolve('003000000000001AAA'));
    expect(done).toMatchObject({ state: 'CONFIRMED', recordId: '003000000000001AAA' });
    expect(l.canSend(w.idempotencyKey)).toBe(false);
  });

  it('a rejected write is FAILED (final, nothing to clean) and keeps its step metadata and error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa ledger '));
    const file = join(dir, 'writes.jsonl');
    const l = new WriteLedger(file);
    const w = l.plan({ runId: 'r', object: 'Contact', step: 'Contact', fields: {}, order: 1, parentRef: 'Account' });
    l.transition(w.idempotencyKey, 'SENT');
    l.transition(w.idempotencyKey, 'FAILED', undefined, 'REQUIRED_FIELD_MISSING');
    expect(() => l.transition(w.idempotencyKey, 'CLEANED')).toThrow();
    const replayed = new WriteLedger(file).get(w.idempotencyKey);
    expect(replayed).toMatchObject({ state: 'FAILED', step: 'Contact', order: 1, parentRef: 'Account' });
    expect(replayed?.error).toBe('REQUIRED_FIELD_MISSING');
    await rm(dir, { recursive: true, force: true });
  });

  it('replays the ledger after a crash; in-flight SENT writes become UNCERTAIN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa ledger '));
    const file = join(dir, 'writes.jsonl');
    const l1 = new WriteLedger(file);
    const a = l1.plan({ runId: 'r', object: 'Account', step: 'a', fields: {} });
    const c = l1.plan({ runId: 'r', object: 'Contact', step: 'c', fields: {} });
    l1.transition(a.idempotencyKey, 'SENT');
    l1.transition(a.idempotencyKey, 'CONFIRMED', '001000000000001AAA');
    l1.transition(c.idempotencyKey, 'SENT'); // process "dies" here
    const l2 = new WriteLedger(file);
    expect(l2.get(a.idempotencyKey)).toMatchObject({ state: 'CONFIRMED', recordId: '001000000000001AAA' });
    expect(l2.get(c.idempotencyKey)?.state).toBe('UNCERTAIN');
    expect(l2.plan({ runId: 'r', object: 'Account', step: 'a', fields: {} }).state).toBe('CONFIRMED');
    await rm(dir, { recursive: true, force: true });
  });
});
