import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Persona, OrgEntry } from '../../config/schemas.js';
import { startFixtureServer, type FixtureServer } from '../../fixture/server.js';
import { loadSeed } from '../../fixture/store.js';
import type { LocatorEntry } from '../../knowledge/locatorRegistry.js';
import { ensureStorageState } from '../../sf/auth/browserState.js';
import { FixtureSessionProvider } from '../../sf/auth/fixture.js';
import { REPO_ROOT } from '../../../tests/helpers/tempProject.js';
import { dryRunPages } from './dryRun.js';
import { parseLocatorExpression } from './expression.js';
import { buildCatalog, findMember, relatedListNewButton, renderPageObject } from './pageObjects.js';

const ORG = '00DFIXTURE00000001';
const MAIN = "getByRole('main')";
const DIALOG = "getByRole('dialog', { name: 'New Contact' })";
const CONTACTS = "getByRole('article', { name: 'Contacts', exact: true })";

function entry(
  page: string,
  scope: string,
  role: string,
  name: string,
  extra: Partial<LocatorEntry> = {},
): LocatorEntry {
  const scopeExpr = scope.split(' › ').join('.');
  return {
    org: ORG,
    page,
    element: `${role}:${scope}/${name}`,
    persona: 'system-admin',
    scope,
    role,
    accessibleName: name,
    expression: `${scopeExpr}.getByRole('${role}', { name: '${name}', exact: true })`,
    strategy: 'role',
    strategyRank: 1,
    lastVerifiedAt: '2026-11-21T00:00:00.000Z',
    verifiedBy: 'explorer',
    observationId: 'obs-1',
    status: 'ACTIVE',
    environment: 'FIXTURE',
    ...extra,
  };
}

const ENTRIES: LocatorEntry[] = [
  entry('account-record', MAIN, 'tab', 'Related'),
  entry('account-record', MAIN, 'tab', 'Details'),
  entry('account-record', `${MAIN} › ${CONTACTS}`, 'button', 'New'),
  entry('account-record', MAIN, 'button', 'Edit'),
  entry('contact-new', DIALOG, 'textbox', 'Last Name', { fieldApiName: 'Contact.LastName' }),
  entry('contact-new', DIALOG, 'textbox', 'Mailing Country', { fieldApiName: 'Contact.MailingCountry' }),
  entry('contact-new', DIALOG, 'textbox', 'Phone', { fieldApiName: 'Contact.Phone', status: 'RE_VERIFY' }),
  entry('contact-new', DIALOG, 'button', 'Save'),
  entry('contact-new', DIALOG, 'button', 'Cancel'),
  entry('contact-record', MAIN, 'tab', 'Details'),
  entry('contact-record', MAIN, 'button', 'Edit'),
  entry('contact-record', MAIN, 'button', 'Gone', { status: 'RETIRED' }),
];

const catalog = (): ReturnType<typeof buildCatalog> =>
  buildCatalog({ entries: ENTRIES, org: ORG, orgAlias: 'fixture', environment: 'FIXTURE', persona: 'system-admin' });

describe('locator expression parser (no eval)', () => {
  it('parses registry chains with options and regexes', () => {
    const calls = parseLocatorExpression(`page.${MAIN}.${CONTACTS}.getByRole('button', { name: /^New$/i })`);
    expect(calls.map((c) => c.method)).toEqual(['getByRole', 'getByRole', 'getByRole']);
    expect(calls[1]?.args[1]).toEqual({ name: 'Contacts', exact: true });
    expect(calls[2]?.args[1]).toEqual({ name: /^New$/i });
    expect(parseLocatorExpression("getByLabel('It\\'s', { exact: true })")[0]?.args[0]).toBe("It's");
  });

  it('rejects anything outside the locator grammar', () => {
    for (const bad of ["evaluate('1')", "getByRole('x').click()", "getByRole('x'); process.exit(1)", '$("a")', '']) {
      expect(() => parseLocatorExpression(bad), bad).toThrow();
    }
  });
});

describe('page objects from the registry', () => {
  it('names members by field / scope + role, adds scope regions, keeps RE_VERIFY flagged, drops RETIRED', () => {
    const cat = catalog();
    const acc = cat.pages.find((p) => p.id === 'account-record')!;
    expect(acc.members.map((m) => m.name).sort()).toEqual(
      ['contactsNewButton', 'contactsRelatedList', 'detailsTab', 'editButton', 'relatedTab'].sort(),
    );
    expect(relatedListNewButton(acc, 'Contacts')?.name).toBe('contactsNewButton');
    const dlg = cat.pages.find((p) => p.id === 'contact-new')!;
    expect(findMember(cat, 'contact-new.lastName')?.member.fieldApiName).toBe('Contact.LastName');
    expect(findMember(cat, 'contact-new.phone')?.member.status).toBe('RE_VERIFY');
    expect(dlg.members.find((m) => m.name === 'saveButton')).toBeDefined();
    expect(cat.pages.find((p) => p.id === 'contact-record')!.members.map((m) => m.name)).not.toContain('goneButton');
  });

  it('renders typed page objects whose locators are the registry expressions (labels only here)', () => {
    const cat = catalog();
    const src = renderPageObject(
      cat.pages.find((p) => p.id === 'contact-new')!,
      cat,
    );
    expect(src).toContain('export class NewContactDialog {');
    expect(src).toContain(`this.root = page.${DIALOG};`);
    expect(src).toContain(`return this.page.${DIALOG}.getByRole('textbox', { name: 'Last Name', exact: true });`);
    expect(src).toMatch(/RE_VERIFY: changed in the org/);
    const rec = renderPageObject(
      cat.pages.find((p) => p.id === 'account-record')!,
      cat,
    );
    expect(rec).toContain("return openRecord(this.page, 'Account', recordId);");
  });
});

describe('locator dry-run on the offline fixture (real Chromium, FIXTURE)', () => {
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

  it('resolves every member in its page state (tabs prepared, dialog opened and cancelled); flags a broken one', async () => {
    const org: OrgEntry = {
      orgId: ORG,
      alias: 'fixture',
      profile: 'offline-fixture',
      instanceUrl: server.url,
      release: 'fixture',
      runTagField: 'QA_Run_Id__c',
      environment: 'FIXTURE',
    };
    const state = await ensureStorageState({
      provider: new FixtureSessionProvider(seed),
      request: { persona, org },
      authDir: join(mkdtempSync(join(tmpdir(), 'dry run ')), '.auth'),
      ttlMinutes: 60,
      browser: 'chromium',
    });
    const env = { baseUrl: server.url, accountId: '001FX0000000001AAA', contactId: '003FX0000000001AAA' };
    const good = await dryRunPages({ browser, storageStatePath: state.path, env, catalog: catalog() });
    expect(good.pageErrors).toEqual([]);
    expect(good.checks.filter((c) => !c.ok)).toEqual([]);
    expect(good.ok).toBe(true);
    // The Contacts list lives on the Related tab: resolved after that tab was prepared (members are checked in
    // catalog order, regions first, so the list's New button is then found in the same state).
    expect(good.checks.find((c) => c.element === 'account-record.contactsRelatedList')?.note).toMatch(/Related/);

    const broken = buildCatalog({
      entries: [
        ...ENTRIES,
        entry('contact-new', DIALOG, 'textbox', 'Nickname', { fieldApiName: 'Contact.Nickname__c' }),
      ],
      org: ORG,
      orgAlias: 'fixture',
      environment: 'FIXTURE',
      persona: 'system-admin',
    });
    const r = await dryRunPages({
      browser,
      storageStatePath: state.path,
      env,
      catalog: broken,
      refs: ['contact-new.nickname', 'contact-new.lastName'],
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.element === 'contact-new.nickname')).toMatchObject({ count: 0, ok: false });
    expect(r.checks.find((c) => c.element === 'contact-new.lastName')?.ok).toBe(true);
  }, 120_000);
});
