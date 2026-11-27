import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLabelRenames, applyRuleFaults, FixtureFaults } from './faults.js';
import { startFixtureServer, type FixtureServer } from './server.js';

const fixtureDir = join(import.meta.dirname, '..', '..', 'examples', 'fixture');
const ADMIN = 'fixture-admin-token';
const api = (fx: FixtureServer, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${fx.url}/services/data/v62.0${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
  });

describe('fault helpers', () => {
  it('renames button and label text and aria-labels only', () => {
    const html =
      '<button type="submit" name="SaveEdit" class="brand">Save</button><label for="x">Phone</label><div aria-label="Save">';
    const out = applyLabelRenames(html, [{ from: 'Save', to: 'Save Record' }]);
    expect(out).toContain('class="brand">Save Record</button>');
    expect(out).toContain('aria-label="Save Record"');
    expect(out).toContain('name="SaveEdit"');
  });

  it('disables and adds rules', () => {
    const f = FixtureFaults.parse({
      disableRules: ['Phone_Must_Be_10_Digits'],
      extraRules: [{ object: 'Account', name: 'Need_Phone', formula: 'ISBLANK(Phone)', message: 'Phone required' }],
    });
    const rules = applyRuleFaults(
      [{ object: 'Contact', name: 'Phone_Must_Be_10_Digits', formula: 'x', message: 'm' }],
      f,
    );
    expect(rules.map((r) => r.name)).toEqual(['Need_Phone']);
  });
});

describe('fixture with faults', () => {
  let fx: FixtureServer | undefined;
  afterEach(async () => {
    await fx?.close();
    fx = undefined;
  });

  it('Case.IsClosed follows Status; BR-08 off (default) deletes the Contact and keeps the Case unlinked', async () => {
    fx = await startFixtureServer({ fixtureDir, port: 0 });
    const acc = (await (
      await api(fx, '/sobjects/Account', { method: 'POST', body: JSON.stringify({ Name: 'A' }) })
    ).json()) as { id: string };
    const con = (await (
      await api(fx, '/sobjects/Contact', { method: 'POST', body: JSON.stringify({ LastName: 'C', AccountId: acc.id }) })
    ).json()) as { id: string };
    const cs = (await (
      await api(fx, '/sobjects/Case', {
        method: 'POST',
        body: JSON.stringify({ Subject: 'S', Status: 'New', ContactId: con.id }),
      })
    ).json()) as { id: string };
    expect(fx.store.get('Case', cs.id)['IsClosed']).toBe(false);
    expect((await api(fx, `/sobjects/Contact/${con.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(fx.store.get('Case', cs.id)['ContactId']).toBeNull();
  });

  it('BR-08 on: a Contact with an open Case cannot be deleted; with only closed Cases it can', async () => {
    fx = await startFixtureServer({
      fixtureDir,
      port: 0,
      faults: FixtureFaults.parse({ behaviour: { blockContactDeleteWithOpenCases: true } }),
    });
    const con = (await (
      await api(fx, '/sobjects/Contact', { method: 'POST', body: JSON.stringify({ LastName: 'C' }) })
    ).json()) as { id: string };
    const cs = (await (
      await api(fx, '/sobjects/Case', {
        method: 'POST',
        body: JSON.stringify({ Subject: 'S', Status: 'Working', ContactId: con.id }),
      })
    ).json()) as { id: string };
    const refused = await api(fx, `/sobjects/Contact/${con.id}`, { method: 'DELETE' });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(await refused.json())).toContain('open Cases');
    await api(fx, `/sobjects/Case/${cs.id}`, { method: 'PATCH', body: JSON.stringify({ Status: 'Closed' }) });
    expect(fx.store.get('Case', cs.id)['IsClosed']).toBe(true);
    expect((await api(fx, `/sobjects/Contact/${con.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('503 on matching Lightning paths, read-only objects, renamed Save, toast delay script', async () => {
    fx = await startFixtureServer({
      fixtureDir,
      port: 0,
      faults: FixtureFaults.parse({
        unavailablePaths: ['^/lightning/r/Account/'],
        readOnlyObjects: ['Account'],
        labelRenames: [{ from: 'Save', to: 'Save Record' }],
        toastDelayMs: 30000,
      }),
    });
    const page = await fetch(`${fx.url}/lightning/r/Account/001FX0000000001AAA/view`, {
      headers: { cookie: `sid=${ADMIN}` },
    });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('Service Unavailable');
    const denied = await api(fx, '/sobjects/Account', { method: 'POST', body: JSON.stringify({ Name: 'A' }) });
    expect(denied.status).toBe(403);
    expect(((await (await api(fx, '/sobjects/Account/describe')).json()) as { createable: boolean }).createable).toBe(
      false,
    );
    const con = (await (
      await api(fx, '/sobjects/Contact', { method: 'POST', body: JSON.stringify({ LastName: 'C' }) })
    ).json()) as { id: string };
    const html = await (
      await fetch(`${fx.url}/lightning/r/Contact/${con.id}/view`, { headers: { cookie: `sid=${ADMIN}` } })
    ).text();
    expect(html).toContain('>Save Record</button>');
    expect(html).toContain('"toastDelayMs":30000');
    expect(html).toContain('Delete Contact');
  });
});
