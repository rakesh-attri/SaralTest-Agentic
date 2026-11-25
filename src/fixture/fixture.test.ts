import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyError } from '../core/classifyError.js';
import { parseSoql, SoqlError } from './soql.js';
import { startFixtureServer, type FixtureServer } from './server.js';

const fixtureDir = join(import.meta.dirname, '..', '..', 'examples', 'fixture');
const ADMIN = { authorization: 'Bearer fixture-admin-token' };
const READONLY = { authorization: 'Bearer fixture-readonly-token' };
const SEED_ACCOUNT = '001FX0000000001AAA';

describe('SOQL subset parser', () => {
  it('parses fields, relationship fields, WHERE/AND/IN/LIKE/null, ORDER BY, LIMIT, COUNT()', () => {
    expect(
      parseSoql(
        "SELECT Id, LastName, Account.Name FROM Contact WHERE AccountId = '001X' AND Email LIKE '%@x.invalid' AND Phone = null AND Id IN ('a','b') ORDER BY LastName DESC LIMIT 5",
      ),
    ).toEqual({
      object: 'Contact',
      fields: ['Id', 'LastName', 'Account.Name'],
      count: false,
      where: [
        { field: 'AccountId', op: '=', value: '001X' },
        { field: 'Email', op: 'LIKE', value: '%@x.invalid' },
        { field: 'Phone', op: '=', value: null },
        { field: 'Id', op: 'IN', value: ['a', 'b'] },
      ],
      orderBy: { field: 'LastName', dir: 'DESC' },
      limit: 5,
    });
    expect(parseSoql('SELECT COUNT() FROM Account').count).toBe(true);
    expect(parseSoql("SELECT Id FROM Account WHERE Name = 'It\\'s AND fine'").where).toEqual([
      { field: 'Name', op: '=', value: "It's AND fine" },
    ]);
  });

  it.each([
    'SELECT Id FROM Account WHERE Name = 1',
    "SELECT Id FROM Account WHERE Name = 'a' OR Name = 'b'",
    'SELECT Id, (SELECT Id FROM Contacts) FROM Account',
    'DELETE FROM Account',
  ])('rejects unsupported SOQL: %s', (q) => {
    expect(() => parseSoql(q)).toThrow(SoqlError);
  });
});

describe('fixture server', () => {
  let fx: FixtureServer;
  const api = (p: string): string => `${fx.url}/services/data/v62.0${p}`;
  const query = async (q: string, headers = ADMIN): Promise<Response> =>
    fetch(`${api('/query')}?q=${encodeURIComponent(q)}`, { headers });
  const post = async (obj: string, body: unknown, headers = ADMIN): Promise<Response> =>
    fetch(api(`/sobjects/${obj}`), {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    fx = await startFixtureServer({ fixtureDir, port: 0 });
  });
  afterAll(async () => {
    await fx.close();
  });

  it('labels every response FIXTURE and answers the identity checks', async () => {
    const info = await fetch(`${fx.url}/services/oauth2/userinfo`, { headers: ADMIN });
    expect(info.headers.get('x-qa-environment')).toBe('FIXTURE');
    expect(await info.json()).toMatchObject({ organization_id: '00DFIXTURE00000001', environment: 'FIXTURE' });
    const org = (await (await query('SELECT Id, IsSandbox FROM Organization')).json()) as {
      records: { Id: string; IsSandbox: boolean }[];
    };
    expect(org.records[0]).toMatchObject({ Id: '00DFIXTURE00000001', IsSandbox: true });
  });

  it('rejects requests without a session (INVALID_SESSION_ID → AUTH)', async () => {
    const r = await query('SELECT Id FROM Account', {} as typeof ADMIN);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { errorCode: string }[];
    expect(classifyError(Object.assign(new Error('x'), { status: r.status, body })).kind).toBe('AUTH');
  });

  it('Account → Contact: create, link, verify Contact.AccountId by SOQL, clean up', async () => {
    const acc = (await (
      await post('Account', { Name: 'QA-run-1-Acme', Industry: 'Technology', QA_Run_Id__c: 'run-1' })
    ).json()) as {
      id: string;
      success: boolean;
    };
    expect(acc.success).toBe(true);
    expect(acc.id).toMatch(/^001[A-Za-z0-9]{15}$/);
    const con = (await (
      await post('Contact', { LastName: 'QA-run-1-Doe', AccountId: acc.id, QA_Run_Id__c: 'run-1' })
    ).json()) as {
      id: string;
    };
    const verify = (await (
      await query(`SELECT Id, AccountId, Account.Name FROM Contact WHERE Id = '${con.id}'`)
    ).json()) as { totalSize: number; records: { AccountId: string; Account: { Name: string } }[] };
    expect(verify.totalSize).toBe(1);
    expect(verify.records[0]).toMatchObject({ AccountId: acc.id, Account: { Name: 'QA-run-1-Acme' } });

    // reverse-order cleanup, then re-query proves it
    for (const [o, id] of [
      ['Contact', con.id],
      ['Account', acc.id],
    ] as const) {
      expect((await fetch(api(`/sobjects/${o}/${id}`), { method: 'DELETE', headers: ADMIN })).status).toBe(204);
    }
    const left = (await (await query("SELECT COUNT() FROM Contact WHERE QA_Run_Id__c = 'run-1'")).json()) as {
      totalSize: number;
    };
    expect(left.totalSize).toBe(0);
  });

  it('Last Name is required (REQUIRED_FIELD_MISSING → DATA)', async () => {
    const r = await post('Contact', { FirstName: 'NoLast', AccountId: SEED_ACCOUNT });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errorCode: string; fields: string[] }[];
    expect(body[0]).toMatchObject({ errorCode: 'REQUIRED_FIELD_MISSING', fields: ['LastName'] });
    expect(classifyError(Object.assign(new Error('x'), { body })).kind).toBe('DATA');
  });

  it('validates picklists, references and unknown fields', async () => {
    expect(
      ((await (await post('Account', { Name: 'x', Industry: 'Nope' })).json()) as { errorCode: string }[])[0]
        ?.errorCode,
    ).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(
      (
        (await (await post('Contact', { LastName: 'x', AccountId: '001FX9999999999AAA' })).json()) as {
          errorCode: string;
        }[]
      )[0]?.errorCode,
    ).toBe('INVALID_CROSS_REFERENCE_KEY');
    expect(
      ((await (await post('Account', { Name: 'x', Bogus__c: 1 })).json()) as { errorCode: string }[])[0]?.errorCode,
    ).toBe('INVALID_FIELD');
  });

  it('read-only persona cannot create or edit (AC 4)', async () => {
    const r = await post('Contact', { LastName: 'Blocked', AccountId: SEED_ACCOUNT }, READONLY);
    expect(r.status).toBe(403);
    const q = await query('SELECT Id FROM Account', READONLY);
    expect(q.status).toBe(200);
  });

  it('unsupported SOQL → 400 MALFORMED_QUERY', async () => {
    const r = await query("SELECT Id FROM Account WHERE Name = 'a' OR Name = 'b'");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { errorCode: string }[])[0]?.errorCode).toBe('MALFORMED_QUERY');
  });

  it('describe returns a Salesforce-shaped view of the fixture object model', async () => {
    const d = (await (await fetch(api('/sobjects/Contact/describe'), { headers: ADMIN })).json()) as {
      fields: { name: string; nillable: boolean; referenceTo: string[] }[];
      recordTypeInfos: unknown[];
    };
    expect(d.fields.find((f) => f.name === 'LastName')?.nillable).toBe(false);
    expect(d.fields.find((f) => f.name === 'AccountId')?.referenceTo).toEqual(['Account']);
    expect(d.recordTypeInfos.length).toBeGreaterThan(0);
  });

  it('answers Tooling queries from examples/fixture/metadata.json (projection + WHERE)', async () => {
    const q = encodeURIComponent(
      "SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE EntityDefinition.QualifiedApiName IN ('Contact') AND Active = true",
    );
    const r = (await (await fetch(api(`/tooling/query?q=${q}`), { headers: ADMIN })).json()) as {
      records: { ValidationName: string; EntityDefinition: { QualifiedApiName: string }; Metadata?: unknown }[];
    };
    expect(r.records.length).toBeGreaterThan(0);
    expect(r.records[0]?.EntityDefinition.QualifiedApiName).toBe('Contact');
    expect(r.records[0]?.Metadata).toBeUndefined(); // not selected → not returned
    const bad = await fetch(api(`/tooling/query?q=${encodeURIComponent('SELECT Id FROM Network')}`), {
      headers: ADMIN,
    });
    expect(bad.status).toBe(400);
  });

  it('frontdoor sets a session cookie; the record page is accessible, labelled FIXTURE, and role-based', async () => {
    const fd = await fetch(
      `${fx.url}/secur/frontdoor.jsp?sid=fixture-admin-token&retURL=/lightning/r/Account/${SEED_ACCOUNT}/view`,
      {
        redirect: 'manual',
      },
    );
    expect(fd.status).toBe(302);
    const cookie = fd.headers.get('set-cookie')?.split(';')[0] ?? '';
    const html = await (
      await fetch(`${fx.url}/lightning/r/Account/${SEED_ACCOUNT}/view`, { headers: { cookie } })
    ).text();
    expect(html).toContain('OFFLINE FIXTURE');
    expect(html).toContain('<h1><span class="record-title">Fixture Seed Account</span></h1>');
    expect(html).toContain('role="grid" aria-label="Contacts"');
    expect(html).toContain('<button type="button" name="NewContact">New</button>');
    // Required marker hidden from the accessible name, as on live Lightning ("Last Name", not "*Last Name").
    expect(html).toMatch(
      /<label for="input-[0-9a-f]{6}-2"><abbr title="required" aria-hidden="true">\*<\/abbr>Last Name<\/label>/,
    );
    expect(html).toMatch(/role="tabpanel" id="related-[0-9a-f]{6}"[^>]*hidden>/);
    expect(html).not.toMatch(/\{\{/);

    const contactHtml = await (
      await fetch(`${fx.url}/lightning/r/Contact/003FX0000000001AAA/view`, { headers: { cookie } })
    ).text();
    expect(contactHtml).toContain('<h1><span class="record-title">Seed Contact</span></h1>');
    expect(contactHtml).toContain('href="/lightning/r/Account/001FX0000000001AAA/view"');
    expect(contactHtml).not.toMatch(/\{\{/);

    const ro = await fetch(`${fx.url}/lightning/r/Account/${SEED_ACCOUNT}/view`, {
      headers: { cookie: 'sid=fixture-readonly-token' },
    });
    expect(await ro.text()).not.toContain('name="NewContact"');
  });

  it('static assets are served, traversal is not', async () => {
    expect((await fetch(`${fx.url}/fixture/static/record-page.js`)).status).toBe(200);
    expect((await fetch(`${fx.url}/fixture/static/..%2F..%2Fseed.json`)).status).toBe(404);
  });

  it('escapes HTML in record data', async () => {
    const acc = (await (await post('Account', { Name: '<script>alert(1)</script>' })).json()) as { id: string };
    const html = await (await fetch(`${fx.url}/lightning/r/Account/${acc.id}/view`, { headers: ADMIN })).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
