import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { ComponentVersion } from '../../core/schemas/knowledge.js';
import { LocatorEntry, STRATEGY_RANK, type LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import type { Redactor } from '../../security/redact.js';
import type { TestAsset } from '../../sf/graph/assetLinks.js';
import { ACTIONABLE_ROLES, parseAriaSnapshot, SCOPE_ROLES, type AriaNode } from './aria.js';

export interface PageEnv {
  baseUrl: string;
  accountId: string;
  contactId: string;
}

export interface Capture {
  /** Human label of the captured state (e.g. "Related tab", "Details tab", "dialog"). */
  state: string;
  root: Locator;
  /** Playwright expression of `root`, relative to `page`. */
  rootExpr: string;
  /** Bring the page into this state right before it is read (e.g. select a tab). */
  prepare?: () => Promise<boolean>;
  /**
   * The root's own accessible name holds record data (Lightning names the edit modal "Edit <record name>"): in element
   * keys that scope is replaced by this static name, and it is never added to a locator (`rootExpr` already scopes).
   */
  scopeAlias?: { role: string; match: RegExp; name: string };
}

export interface PageSpec {
  id: string;
  title: string;
  /** Object whose field labels are matched against accessible names. */
  object: string;
  /** Navigate and prepare; returns one or more captures. Must not save or change data. */
  open(
    page: Page,
    env: PageEnv,
    log: (m: string) => void,
  ): Promise<{ captures: Capture[]; path: string; cleanup?: () => Promise<void> }>;
}

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait until the ARIA tree of `root` stops changing (Lightning renders progressively). */
export async function waitStable(root: Locator, timeoutMs = 20_000): Promise<string> {
  const end = Date.now() + timeoutMs;
  let prev = '';
  let same = 0;
  for (;;) {
    const cur = await root.ariaSnapshot({ timeout: 10_000 }).catch(() => '');
    same = cur && cur === prev ? same + 1 : 0;
    if (same >= 2 || Date.now() > end) return cur;
    prev = cur;
    await sleep(500);
  }
}

async function recordPage(page: Page, url: string): Promise<Locator> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 60_000 });
  const main = page.getByRole('main');
  await waitStable(main);
  return main;
}

async function selectTab(main: Locator, name: string): Promise<boolean> {
  const tab = main.getByRole('tab', { name, exact: true });
  if ((await tab.count()) !== 1) return false;
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
    await waitStable(main);
  }
  return true;
}

function recordPageSpec(id: string, object: 'Account' | 'Contact', title: string): PageSpec {
  return {
    id,
    title,
    object,
    async open(page, env) {
      const recordId = object === 'Account' ? env.accountId : env.contactId;
      const main = await recordPage(page, `${env.baseUrl}/lightning/r/${object}/${recordId}/view`);
      const captures: Capture[] = [{ state: 'default tab', root: main, rootExpr: "getByRole('main')" }];
      for (const tab of ['Related', 'Details']) {
        captures.push({
          state: `${tab} tab`,
          root: main,
          rootExpr: "getByRole('main')",
          prepare: () => selectTab(main, tab),
        });
      }
      return { captures, path: `/lightning/r/${object}/<id>/view` };
    },
  };
}

/** New Contact dialog opened from the Account's Contacts related list (fallback: the standard new-record URL). */
export const newContactFromAccount: PageSpec = {
  id: 'contact-new',
  title: 'New Contact dialog (from the Account Contacts related list)',
  object: 'Contact',
  async open(page, env, log) {
    const main = await recordPage(page, `${env.baseUrl}/lightning/r/Account/${env.accountId}/view`);
    const contacts = (): Locator => main.getByRole('article', { name: 'Contacts', exact: true });
    if ((await contacts().count()) === 0) await selectTab(main, 'Related');
    let path = 'Account › Contacts related list › New';
    const newBtn = contacts().getByRole('button', { name: 'New', exact: true });
    if ((await newBtn.count()) === 1) {
      await newBtn.click();
    } else {
      path = '/lightning/o/Contact/new?defaultFieldValues=AccountId=<id> (related-list button not found)';
      log(`  contact-new: related-list "New" not found, using the new-record URL`);
      await page.goto(`${env.baseUrl}/lightning/o/Contact/new?defaultFieldValues=AccountId=${env.accountId}`, {
        waitUntil: 'domcontentloaded',
      });
    }
    const dialog = page.getByRole('dialog', { name: /New Contact/ });
    await dialog.waitFor({ state: 'visible', timeout: 60_000 });
    const snap = await waitStable(dialog);
    const name = /- dialog "([^"]+)"/.exec(snap)?.[1] ?? 'New Contact';
    return {
      captures: [{ state: 'dialog', root: dialog, rootExpr: `getByRole('dialog', { name: ${q(name)} })` }],
      path,
      cleanup: async () => {
        // Cancel: nothing is saved (observe-only exploration).
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        if ((await cancel.count()) === 1) await cancel.click();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
      },
    };
  },
};

/** Root expression of the Contact edit form: the modal Lightning names "Edit <Contact name>" (no record data kept). */
export const CONTACT_EDIT_ROOT = "getByRole('dialog', { name: /^Edit / })";

/**
 * Contact edit form: the record page's Edit button on an existing Contact (picked by read-only SOQL). Observe only —
 * the form is read and cancelled, never saved.
 */
export const contactEditForm: PageSpec = {
  id: 'contact-edit',
  title: 'Contact edit form (record page › Edit)',
  object: 'Contact',
  async open(page, env) {
    const main = await recordPage(page, `${env.baseUrl}/lightning/r/Contact/${env.contactId}/view`);
    await main.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /^Edit / });
    await dialog.waitFor({ state: 'visible', timeout: 60_000 });
    await waitStable(dialog);
    return {
      captures: [
        {
          state: 'edit dialog',
          root: dialog,
          rootExpr: CONTACT_EDIT_ROOT,
          scopeAlias: { role: 'dialog', match: /^Edit /, name: 'Edit Contact' },
        },
      ],
      path: 'Contact record page › Edit',
      cleanup: async () => {
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        if ((await cancel.count()) === 1) await cancel.click();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
      },
    };
  },
};

/**
 * Delete Contact confirmation (Phase 7, BR-08): the record page's Delete opens Lightning's "Delete Contact" modal.
 * Observe only — the modal is read and cancelled, never confirmed (no record is deleted by exploration).
 */
export const contactDeleteDialog: PageSpec = {
  id: 'contact-delete',
  title: 'Delete Contact confirmation (record page › Delete)',
  object: 'Contact',
  async open(page, env) {
    const main = await recordPage(page, `${env.baseUrl}/lightning/r/Contact/${env.contactId}/view`);
    await main.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete Contact' });
    await dialog.waitFor({ state: 'visible', timeout: 60_000 });
    await waitStable(dialog);
    return {
      captures: [{ state: 'dialog', root: dialog, rootExpr: "getByRole('dialog', { name: 'Delete Contact' })" }],
      path: 'Contact record page › Delete (cancelled)',
      cleanup: async () => {
        const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
        if ((await cancel.count()) === 1) await cancel.click();
        else await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
      },
    };
  },
};

export const PAGES: Record<string, PageSpec> = {
  'account-record': recordPageSpec('account-record', 'Account', 'Account record page'),
  'contact-record': recordPageSpec('contact-record', 'Contact', 'Contact record page'),
  'contact-new': newContactFromAccount,
  'contact-edit': contactEditForm,
  'contact-delete': contactDeleteDialog,
};

export interface ExploreInput {
  browser: Browser;
  storageStatePath: string;
  env: PageEnv;
  pages: PageSpec[];
  org: string;
  persona: string;
  environment: 'LIVE' | 'FIXTURE';
  /** Field components of the latest snapshot (accessible name ↔ metadata label check). */
  fields: readonly ComponentVersion[];
  snapshotId?: string;
  /** Record values seen on these pages (names, emails…) — never registered as locators (memory only). */
  recordValues: readonly string[];
  evidenceDir: string;
  redactor: Redactor;
  viewport?: { width: number; height: number };
  log?: (m: string) => void;
  now?: () => Date;
}

export interface PageResult {
  page: string;
  title: string;
  path: string;
  locators: number;
  skipped: Record<string, number>;
  observationId: string;
  evidence: string[];
  error?: string;
}

const norm = (s: string): string =>
  s
    .replace(/^\*\s*/, '')
    .replace(/\s*\*$/, '')
    .trim();

function skipReason(n: AriaNode, recordValues: readonly string[]): string | undefined {
  if (!ACTIONABLE_ROLES.has(n.role)) return 'role';
  if (!n.name?.trim()) return 'no accessible name';
  if (n.ancestors.filter((a) => a.role === 'article').length >= 2) return 'inside a record row';
  if (/\d{4,}/.test(n.name)) return 'contains data-like digits';
  const lower = n.name.toLowerCase();
  if (recordValues.some((v) => v.length >= 3 && lower.includes(v.toLowerCase()))) return 'contains record data';
  return undefined;
}

/**
 * Application Explorer (PLAN.md §3): opens each page as the persona in an isolated context, reads the ARIA tree, and
 * registers the first locator that is unique and visible, in the skill's rank order (role → label). Nothing is
 * saved in the org; dialogs are cancelled. Evidence (redacted ARIA snapshot + screenshot) stays local.
 */
export async function explorePages(i: ExploreInput): Promise<{ pages: PageResult[]; entries: LocatorEntry[] }> {
  const log = i.log ?? (() => undefined);
  const now = i.now ?? (() => new Date());
  mkdirSync(i.evidenceDir, { recursive: true });
  const labelToField = new Map<
    string,
    { apiName: string; match: 'label' | 'label-without-ID' | 'api-name' | 'relationship-name' }
  >();
  const results: PageResult[] = [];
  const entries: LocatorEntry[] = [];
  const context = await i.browser.newContext({
    storageState: i.storageStatePath,
    viewport: i.viewport ?? { width: 1440, height: 900 },
  });
  try {
    for (const spec of i.pages) {
      labelToField.clear();
      for (const f of i.fields) {
        if (f.parent !== spec.object) continue;
        const fieldName = f.apiName.split('.')[1] ?? '';
        const rel = typeof f.body?.['relationshipName'] === 'string' ? f.body['relationshipName'] : undefined;
        const add = (
          k: string | undefined,
          match: 'label' | 'label-without-ID' | 'api-name' | 'relationship-name',
        ): void => {
          if (k && !labelToField.has(k.toLowerCase())) labelToField.set(k.toLowerCase(), { apiName: f.apiName, match });
        };
        add(f.label, 'label');
        add(f.label?.replace(/ ID$/, ''), 'label-without-ID');
        add(fieldName, 'api-name');
        if (rel) add(`${rel.replace(/([a-z])([A-Z])/g, '$1 $2')} Name`, 'relationship-name');
      }
      const page = await context.newPage();
      const observationId = `obs-${spec.id}-${now()
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14)}`;
      const result: PageResult = {
        page: spec.id,
        title: spec.title,
        path: '',
        locators: 0,
        skipped: {},
        observationId,
        evidence: [],
      };
      const skip = (r: string): void => {
        result.skipped[r] = (result.skipped[r] ?? 0) + 1;
      };
      let cleanup: (() => Promise<void>) | undefined;
      try {
        log(`Exploring ${spec.title}…`);
        const opened = await spec.open(page, i.env, log);
        cleanup = opened.cleanup;
        result.path = opened.path;
        const seen = new Set<string>();
        for (const [ci, cap] of opened.captures.entries()) {
          if (cap.prepare && !(await cap.prepare())) continue; // state not available on this page
          const yaml = await waitStable(cap.root);
          const file = join(i.evidenceDir, `${spec.id}-${ci + 1}.aria.yml`);
          writeFileSync(
            file,
            `# ${spec.title} — ${cap.state} (${i.environment}, redacted)\n${i.redactor.redactText(yaml)}\n`,
            'utf8',
          );
          result.evidence.push(file);
          for (const node of parseAriaSnapshot(yaml)) {
            const reason = skipReason(node, i.recordValues);
            if (reason) {
              if (reason !== 'role') skip(reason);
              continue;
            }
            const name = node.name ?? '';
            const alias = cap.scopeAlias;
            const isRootScope = (a: { role: string; name?: string }): boolean =>
              alias !== undefined && a.role === alias.role && alias.match.test(a.name ?? '');
            const named = node.ancestors.filter((a) => SCOPE_ROLES.has(a.role) && a.name);
            // Scopes with record data are dropped (4+ digits), the aliased root keeps a static name in the key only.
            const scopes = named.filter((a) => !isRootScope(a) && !/\d{4,}/.test(a.name ?? ''));
            const keyScopes = named
              .filter((a) => isRootScope(a) || !/\d{4,}/.test(a.name ?? ''))
              .map((a) => (isRootScope(a) ? (alias?.name ?? '') : (a.name ?? '')));
            const key = `${node.role}:${[...keyScopes, name].join('/')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const found = await findUnique(cap, node.role, name, scopes);
            if (!found) {
              skip('not unique or not visible');
              continue;
            }
            const label = norm(name)
              .replace(/^Edit /, '')
              .toLowerCase();
            const mapped = labelToField.get(norm(name).toLowerCase()) ?? labelToField.get(label);
            const entry = LocatorEntry.parse({
              org: i.org,
              page: spec.id,
              element: key,
              persona: i.persona,
              scope: [cap.rootExpr, ...found.scopeExprs].join(' › '),
              role: node.role,
              accessibleName: name,
              expression: found.expression,
              strategy: found.strategy,
              strategyRank: STRATEGY_RANK[found.strategy],
              ...(mapped ? { fieldApiName: mapped.apiName, fieldMatch: mapped.match } : {}),
              lastVerifiedAt: now().toISOString(),
              verifiedBy: 'explorer',
              ...(i.snapshotId ? { snapshotId: i.snapshotId } : {}),
              observationId,
              status: 'ACTIVE',
              environment: i.environment,
            });
            entries.push(entry);
            result.locators++;
          }
        }
        const shot = join(i.evidenceDir, `${spec.id}.png`);
        await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
        result.evidence.push(shot);
      } catch (err) {
        result.error = err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err);
        log(`  ${spec.id}: ${result.error}`);
      } finally {
        if (cleanup) await cleanup().catch(() => undefined);
        await page.close().catch(() => undefined);
      }
      log(
        `  ${spec.id}: ${result.locators} locators (${
          Object.entries(result.skipped)
            .map(([k, v]) => `${v} ${k}`)
            .join(', ') || 'none skipped'
        })`,
      );
      results.push(result);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  return { pages: results, entries };
}

async function findUnique(
  cap: Capture,
  role: string,
  name: string,
  scopes: { role: string; name?: string }[],
): Promise<{ expression: string; strategy: 'role' | 'label'; scopeExprs: string[] } | undefined> {
  // Narrowest useful scope last: try no extra scope, then the nearest named region, then the full chain.
  const options: { role: string; name?: string }[][] = [[]];
  if (scopes.length) options.push([scopes.at(-1) as { role: string; name?: string }]);
  if (scopes.length > 1) options.push(scopes);
  const roleArg = role as Parameters<Locator['getByRole']>[0];
  for (const chain of options) {
    let base = cap.root;
    const scopeExprs: string[] = [];
    for (const s of chain) {
      base = base.getByRole(s.role as Parameters<Locator['getByRole']>[0], { name: s.name ?? '', exact: true });
      scopeExprs.push(`getByRole(${q(s.role)}, { name: ${q(s.name ?? '')}, exact: true })`);
    }
    const loc = base.getByRole(roleArg, { name, exact: true });
    if ((await loc.count()) === 1 && (await loc.isVisible())) {
      return {
        expression: [cap.rootExpr, ...scopeExprs, `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`].join('.'),
        strategy: 'role',
        scopeExprs,
      };
    }
  }
  if (['textbox', 'combobox', 'checkbox', 'spinbutton', 'searchbox'].includes(role)) {
    const loc = cap.root.getByLabel(norm(name), { exact: true });
    if ((await loc.count()) === 1 && (await loc.isVisible())) {
      return {
        expression: `${cap.rootExpr}.getByLabel(${q(norm(name))}, { exact: true })`,
        strategy: 'label',
        scopeExprs: [],
      };
    }
  }
  return undefined;
}

/** Registry locators that represent a field → graph assets (`Locator -locates-> Field`). */
export function assetsFromRegistry(registry: LocatorRegistry, org: string): TestAsset[] {
  return registry
    .list({ org })
    .filter((l) => l.status !== 'RETIRED' && l.fieldApiName)
    .map((l) => ({
      type: 'Locator' as const,
      id: `${l.page}/${l.element}`,
      label: l.accessibleName ?? l.element,
      text: '',
      explicit: [{ type: 'Field', apiName: l.fieldApiName ?? '', kind: 'locates', evidence: l.accessibleName ?? '' }],
    }));
}
