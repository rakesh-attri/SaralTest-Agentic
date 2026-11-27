import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyLayout, loadFixtureLayout, sectionFields } from './layout.js';
import { salesforceDateTime, startFixtureServer, type FixtureServer } from './server.js';

const fixtureDir = join(import.meta.dirname, '..', '..', 'examples', 'fixture');
const layouts = join(fixtureDir, 'layouts');
const tpl = `<dl><!--fields:details-->
<!--field:A--><div>A</div><!--/field-->
<!--field:B--><div>B</div><!--/field-->
<!--field:C--><div>C</div><!--/field-->
<!--/fields--></dl>`;

describe('fixture layout (pure)', () => {
  it('reorders and drops field blocks; no order = template unchanged', () => {
    expect(sectionFields(tpl, 'details')).toEqual(['A', 'B', 'C']);
    expect(sectionFields(applyLayout(tpl, 'details', ['C', 'A']), 'details')).toEqual(['C', 'A']);
    expect(applyLayout(tpl, 'details', undefined)).toBe(tpl);
  });

  it('fails loudly on an unknown field or section', () => {
    expect(() => applyLayout(tpl, 'details', ['A', 'Phnoe'])).toThrow(/unknown field\(s\) Phnoe/);
    expect(() => applyLayout(tpl, 'form', ['A'])).toThrow(/section "form" not found/);
  });

  it('the shipped default layout matches the templates; the seeded one only moves Phone', () => {
    const record = readFileSync(join(fixtureDir, 'pages', 'contact-record.html'), 'utf8');
    const form = readFileSync(join(fixtureDir, 'partials', 'contact-form.html'), 'utf8');
    const def = loadFixtureLayout(join(layouts, 'contact-default.json'));
    expect(def.contact.details).toEqual(sectionFields(record, 'details'));
    expect(def.contact.form).toEqual(sectionFields(form, 'form'));
    const moved = loadFixtureLayout(join(layouts, 'contact-moved-field.json'));
    expect([...(moved.contact.details ?? [])].sort()).toEqual([...(def.contact.details ?? [])].sort());
    expect(moved.contact.details?.filter((f) => f !== 'Phone')).toEqual(
      def.contact.details?.filter((f) => f !== 'Phone'),
    );
    expect(moved.contact.form?.filter((f) => f !== 'Phone')).toEqual(def.contact.form?.filter((f) => f !== 'Phone'));
  });

  it('formats a datetime like Lightning (en_US)', () => {
    expect(salesforceDateTime('2026-11-27T15:05:00.000Z')).toBe('11/27/2026, 3:05 PM');
    expect(salesforceDateTime('2026-01-02T00:09:00.000Z')).toBe('1/2/2026, 12:09 AM');
  });
});

describe('fixture server with a seeded layout (FIXTURE)', () => {
  let fx: FixtureServer;
  beforeAll(async () => {
    fx = await startFixtureServer({ fixtureDir, port: 0, layoutFile: join(layouts, 'contact-moved-field.json') });
  });
  afterAll(async () => {
    await fx.close();
  });

  it('renders Phone after Lead Source on the Details panel and in the form', async () => {
    const res = await fetch(
      `${fx.url}/secur/frontdoor.jsp?sid=fixture-admin-token&retURL=/lightning/r/Contact/003FX0000000001AAA/view`,
      {
        redirect: 'manual',
      },
    );
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const html = await (
      await fetch(`${fx.url}/lightning/r/Contact/003FX0000000001AAA/view`, { headers: { cookie } })
    ).text();
    const details = html.slice(html.indexOf('<!--fields:details-->'), html.indexOf('<!--/fields-->'));
    expect(details.indexOf('<dt>Lead Source</dt>')).toBeLessThan(details.indexOf('<dt>Phone</dt>'));
    expect(details).toContain('<dt>Created By</dt>');
    const form = html.slice(html.indexOf('<!--fields:form-->'));
    expect(form.indexOf('data-field="LeadSource"')).toBeLessThan(form.indexOf('data-field="Phone"'));
  });
});
