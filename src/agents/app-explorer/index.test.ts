import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgEntry, Persona } from '../../config/schemas.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import { LocatorEntry, LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import { Redactor } from '../../security/redact.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { ensureStorageState } from '../../sf/auth/browserState.js';
import { FixtureSessionProvider } from '../../sf/auth/fixture.js';
import { parseAriaSnapshot } from './aria.js';
import { assetsFromRegistry, explorePages, PAGES } from './explorer.js';

describe('ARIA snapshot parser', () => {
  it('keeps role, name, attributes and the ancestor chain', () => {
    const nodes = parseAriaSnapshot(
      [
        '- main:',
        '  - heading "Acme" [level=1]',
        '  - tabpanel "Related":',
        '    - article "Contacts":',
        '      - button "New"',
        '      - article "Jane Doe":',
        '        - button "Show Actions"',
        '  - tab "Details" [selected]',
      ].join('\n'),
    );
    const nw = nodes.find((n) => n.name === 'New');
    expect(nw?.ancestors.map((a) => `${a.role}:${a.name ?? ''}`)).toEqual([
      'main:',
      'tabpanel:Related',
      'article:Contacts',
    ]);
    expect(nodes.find((n) => n.name === 'Details')?.attrs).toEqual(['selected']);
    expect(nodes.find((n) => n.name === 'Show Actions')?.ancestors.filter((a) => a.role === 'article')).toHaveLength(2);
  });
});

describe('locator registry rules', () => {
  const base = {
    org: '00DFIXTURE00000001',
    page: 'p',
    element: 'button:Edit',
    persona: 'system-admin',
    scope: "getByRole('main')",
    expression: "getByRole('main').getByRole('button', { name: 'Edit', exact: true })",
    strategy: 'role' as const,
    strategyRank: 1,
    lastVerifiedAt: new Date().toISOString(),
    verifiedBy: 'explorer' as const,
    observationId: 'obs-1',
    environment: 'FIXTURE' as const,
  };
  it('rejects fragile expressions, wrong ranks and css without a reason', () => {
    expect(LocatorEntry.safeParse(base).success).toBe(true);
    expect(LocatorEntry.safeParse({ ...base, expression: "locator('//div[1]')" }).success).toBe(false);
    expect(LocatorEntry.safeParse({ ...base, expression: "locator('.slds-button').first()" }).success).toBe(false);
    expect(LocatorEntry.safeParse({ ...base, strategyRank: 2 }).success).toBe(false);
    expect(
      LocatorEntry.safeParse({ ...base, strategy: 'css', strategyRank: 5, expression: "locator('[name=x]')" }).success,
    ).toBe(false);
  });
  it('upserts by (org, page, element, persona) and marks RE_VERIFY by field', () => {
    const reg = new LocatorRegistry(join(mkdtempSync(join(tmpdir(), 'registry ')), 'locators.db'));
    // Same key twice: the later verification replaces the earlier one.
    reg.upsert([
      { ...base, status: 'ACTIVE' },
      { ...base, fieldApiName: 'Contact.Phone', status: 'ACTIVE' },
    ]);
    expect(reg.list()).toHaveLength(1);
    expect(reg.markReverify(base.org, { fieldApiName: 'Contact.Phone' })).toBe(1);
    expect(reg.list({ status: 'RE_VERIFY' })).toHaveLength(1);
    reg.upsert([{ ...base, element: 'button:Save', status: 'ACTIVE' }]);
    expect(reg.markAssetReverify(base.org, 'p/button:Save')).toBe(1);
    expect(reg.list({ status: 'RE_VERIFY' })).toHaveLength(2);
    expect(assetsFromRegistry(reg, base.org)[0]?.explicit?.[0]).toMatchObject({
      type: 'Field',
      apiName: 'Contact.Phone',
      kind: 'locates',
    });
    reg.close();
  });
});

describe('Application Explorer on the offline fixture (real Chromium, FIXTURE)', () => {
  let server: FixtureServer;
  let browser: Browser;
  const seed = loadSeed(join(REPO_ROOT, 'examples', 'fixture', 'seed.json'));
  const persona: Persona = {
    id: 'system-admin',
    username: 'qa.admin@fixture.example.invalid',
    sfAlias: 'fixture',
    profile: 'System Administrator',
    permissionSets: [],
    use: ['x'],
  };

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });

  it('registers unique role-based locators on the record page and the New Contact dialog, never record data', async () => {
    const org: OrgEntry = {
      orgId: seed.organization.Id,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      release: 'fixture',
      runTagField: null,
      environment: 'FIXTURE',
    };
    const dir = mkdtempSync(join(tmpdir(), 'explorer '));
    const state = await ensureStorageState({
      provider: new FixtureSessionProvider(seed),
      request: { persona, org },
      authDir: join(dir, '.auth'),
      ttlMinutes: 60,
      browser: 'chromium',
    });
    const fields = [
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Contact.LastName',
        label: 'Last Name',
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
      {
        snapshotId: 's',
        type: 'Field',
        apiName: 'Contact.Email',
        label: 'Email',
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: {},
      },
    ];
    const rawName = seed.records['Account']?.[0]?.['Name'];
    const accountName = typeof rawName === 'string' ? rawName : '';
    const out = await explorePages({
      browser,
      storageStatePath: state.path,
      env: { baseUrl: server.url, accountId: '001FX0000000001AAA', contactId: '003FX0000000001AAA' },
      pages: [PAGES['account-record'], PAGES['contact-new']].filter((p) => p !== undefined),
      org: org.orgId,
      persona: persona.id,
      environment: 'FIXTURE',
      fields,
      recordValues: [accountName],
      evidenceDir: join(dir, 'explorer'),
      redactor: new Redactor(),
    });
    expect(out.pages.map((p) => p.error)).toEqual([undefined, undefined]);
    const exprs = out.entries.map((e) => e.expression);
    expect(exprs).toContain("getByRole('main').getByRole('button', { name: 'Edit', exact: true })");
    // Minimal unique scope wins: the fixture has one New button (live Lightning needs the Contacts article scope).
    expect(exprs.some((x) => x.endsWith("getByRole('button', { name: 'New', exact: true })"))).toBe(true);
    const lastName = out.entries.find((e) => e.page === 'contact-new' && e.fieldApiName === 'Contact.LastName');
    expect(lastName).toMatchObject({ strategyRank: 1, fieldMatch: 'label', environment: 'FIXTURE' });
    expect(out.entries.every((e) => LocatorEntry.safeParse(e).success)).toBe(true);
    expect(JSON.stringify(out.entries)).not.toContain(accountName);
    expect(out.pages[1]?.path).toContain('related list');
  }, 120_000);
});
