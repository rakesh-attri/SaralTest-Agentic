// Application Explorer — observed messages (Phase 5, operator decision 2026-11-26). Captures, by observation in the
// UI, the message texts the generator had no evidence for: the standard required-field message (empty Last Name), the
// invalid-email message, what the Last Name input does with 81 characters, and the duplicate warning of
// Contact_Same_Email_Same_Account. Each attempt is a Save click → a guarded, audited mutation (`uiAttempt`). A rejected
// save creates nothing; that is proven by SOQL. Anything a save did create is adopted (tag + ledger) and removed by the
// verified cleanup with the run-tagged seed records. "Save anyway" on a duplicate warning is never pressed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { ObservedMessage } from '../../core/schemas/execution.js';
import type { CleanupReport } from '../../core/schemas/data.js';
import type { DataEngine } from '../../sf/data/engine.js';
import { soqlString } from '../../sf/data/engine.js';
import type { Redactor } from '../../security/redact.js';

/** What the Explorer needs from the guarded Salesforce client (query + audited UI save attempts). */
export interface MessageSf {
  query<T = Record<string, unknown>>(soql: string): Promise<T[]>;
  uiAttempt<T>(tool: string, object: string, fn: () => Promise<T>): Promise<T>;
  readonly identity: { userId: string };
}

export interface ObserveMessagesInput {
  browser: Browser;
  storageStatePath: string;
  baseUrl: string;
  sf: MessageSf;
  /** Data engine of the approved `account-contact` plan (seeds: Account + Contact with an email). */
  engine: DataEngine;
  org: string;
  persona: string;
  snapshotId: string;
  runId: string;
  environment: 'LIVE' | 'FIXTURE';
  /** Evidence folder (screenshots stay local; never sent to a model). */
  evidenceDir: string;
  /** Repo root, for repo-relative screenshot paths. */
  root: string;
  redactor: Redactor;
  /** Duplicate rule the duplicate attempt exercises (from the snapshot). */
  duplicateRule?: string;
  log?: (m: string) => void;
  now?: () => Date;
}

export interface AttemptOutcome {
  attempt: 'required-last-name' | 'invalid-email' | 'last-name-81' | 'duplicate-email';
  /** Contacts on the seed Account before / after the Save (SOQL). */
  before: number;
  after: number;
  /** A record the Save created (adopted for cleanup). */
  created: boolean;
  messages: ObservedMessage[];
  notes: string[];
  screenshot?: string;
  error?: string;
}

export interface ObserveMessagesResult {
  attempts: AttemptOutcome[];
  messages: ObservedMessage[];
  cleanup: CleanupReport;
}

const MAX_TEXT = 400;

/** Text of the element(s) an input's aria-describedby points to (Lightning's field-level help/error message). */
/**
 * Text of the element(s) an input's aria-describedby points to (Lightning's field-level help/error message). The ids
 * are resolved in the input's own root (Lightning components keep the message in the same shadow root), then in the
 * document; a form-element help text next to the input is the fallback.
 */
export async function describedText(field: Locator): Promise<string> {
  // After a save popover closes, the record form re-enters the accessibility tree a moment later.
  await field.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if ((await field.count()) !== 1) return '';
  const text = await field
    .evaluate((el) => {
      const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      // Lightning keeps the help message in another (native) shadow root: search every open root, own root first.
      const findDeep = (root: Document | ShadowRoot, id: string, depth = 0): Element | null => {
        // querySelector, not getElementById: LWC's synthetic shadow patches getElementById to hide shadow content.
        const direct = root.querySelector(`[id="${id.replace(/"/g, '')}"]`);
        if (direct || depth > 25) return direct;
        for (const e of Array.from(root.querySelectorAll('*'))) {
          if (e.shadowRoot) {
            const f = findDeep(e.shadowRoot, id, depth + 1);
            if (f) return f;
          }
        }
        return null;
      };
      const own = el.getRootNode() as Document | ShadowRoot;
      const parts: string[] = [];
      for (const id of ids) {
        const n = findDeep(own, id) ?? findDeep(el.ownerDocument, id);
        const t = n?.textContent.trim();
        if (t) parts.push(t);
      }
      if (parts.length) return parts.join(' ');
      // Fallback: the nearest form element's help text (slds-form-element__help).
      let p: Element | null = el;
      for (let k = 0; p && k < 8; k++, p = p.parentElement) {
        const help = p.querySelector('.slds-form-element__help, [data-help-message]');
        if (help?.textContent.trim()) return help.textContent.trim();
      }
      return '';
    })
    .catch(() => '');
  return text.replace(/\s+/g, ' ').slice(0, MAX_TEXT);
}

/**
 * Fallback for a field message the DOM keeps out of reach (closed shadow roots): Playwright's ARIA snapshot of the form
 * lists the help text right after the invalid textbox (`- textbox "Last Name" [invalid]` then `- text: Last Name
 * Complete this field.`). The label prefix is dropped. Exported for unit tests.
 */
export function messageFromAriaSnapshot(yaml: string, label: string): string {
  const lines = yaml.split('\n');
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = lines.findIndex((l) => new RegExp(`- textbox "${esc}" \\[invalid\\]`).test(l));
  if (at < 0) return '';
  const indent = /^(\s*)/.exec(lines[at] ?? '')?.[1]?.length ?? 0;
  // Siblings only: deeper lines are the textbox's own children (placeholder, typed value).
  for (const l of lines.slice(at + 1, at + 8)) {
    const ind = /^(\s*)/.exec(l)?.[1]?.length ?? 0;
    if (ind < indent) break;
    if (ind > indent) continue;
    const m = /^\s*- text: (.+)$/.exec(l);
    if (!m?.[1]) continue;
    const t = m[1]
      .trim()
      .replace(new RegExp(`^${esc}\\s*`), '')
      .trim();
    if (t) return t.slice(0, MAX_TEXT);
  }
  return '';
}

/**
 * Lightning's save popovers in the record form footer: "We hit a snag." (errors) and "Similar Records Exist"
 * (duplicate alert). On live Lightning each is its OWN modal dialog named by its heading (while it is open the record
 * form is hidden from the accessibility tree); the fixture renders an alert inside the form. Read by heading only —
 * never page-wide text (the record page behind the modal has its own duplicate widget).
 */
export async function popoverTexts(page: Page, form: Locator, heading: RegExp): Promise<string[]> {
  const out: string[] = [];
  const add = (t: string): void => {
    const clean = t
      .replace(/Close error dialog/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TEXT);
    if (clean && !out.includes(clean)) out.push(clean);
  };
  // The duplicate check answers asynchronously: give the popover a moment before reading — unless the form already
  // shows the error inline (fixture) or the form is gone (the save went through).
  const inline = (await form.getByText(heading).count()) > 0;
  if (!inline && (await form.count()) > 0)
    await page
      .getByRole('dialog', { name: heading })
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => undefined);
  for (const d of await page.getByRole('dialog', { name: heading }).all()) {
    if (await d.isVisible().catch(() => false)) add(await d.innerText().catch(() => ''));
  }
  if (out.length) return out;
  for (const h of await form.getByText(heading).all()) {
    if (!(await h.isVisible().catch(() => false))) continue;
    add(
      await h
        .evaluate((el) => {
          let p: Element | null = el;
          for (let k = 0; p && k < 6; k++, p = p.parentElement) {
            const role = p.getAttribute('role');
            if (role === 'dialog' || role === 'alertdialog' || role === 'alert') break;
          }
          return (p ?? el).textContent;
        })
        .catch(() => ''),
    );
  }
  return out;
}

/** Close Lightning's save popovers so the record form is back in the accessibility tree (nothing is saved). */
export async function closePopovers(page: Page): Promise<void> {
  for (const d of await page.getByRole('dialog', { name: POPOVER }).all()) {
    const close = d.getByRole('button', { name: 'Close error dialog' });
    if ((await close.count()) === 1 && (await close.isVisible().catch(() => false))) {
      await close.click().catch(() => undefined);
    }
  }
}

/** Headings of Lightning's save popovers: errors / duplicate alert. */
export const POPOVER = /^\s*(We hit a snag|Similar Records Exist)/;
const DUPLICATE = /^\s*Similar Records Exist/;
const field = (dialog: Locator, name: string): Locator => dialog.getByRole('textbox', { name, exact: true });

export async function observeMessages(i: ObserveMessagesInput): Promise<ObserveMessagesResult> {
  const log = i.log ?? (() => undefined);
  const now = i.now ?? (() => new Date());
  const started = new Date(now().getTime() - 5 * 60_000); // server clocks differ: adoptCreated window
  mkdirSync(i.evidenceDir, { recursive: true });
  log('Creating the run-tagged seed records (approved recipe account-contact) …');
  await i.engine.create();
  const accountId = i.engine.recordId('Account');
  const seedEmail = i.engine.plan.steps.find((s) => s.stepId === 'Contact')?.fields['Email'];
  const contactsOnAccount = async (): Promise<string[]> =>
    (await i.sf.query<{ Id: string }>(`SELECT Id FROM Contact WHERE AccountId = ${soqlString(accountId)}`)).map(
      (r) => r.Id,
    );

  const context = await i.browser.newContext({
    storageState: i.storageStatePath,
    viewport: { width: 1440, height: 900 },
  });
  const attempts: AttemptOutcome[] = [];
  let seq = 0;
  const msg = (
    m: Omit<ObservedMessage, 'id' | 'org' | 'persona' | 'snapshotId' | 'observedAt' | 'runId' | 'environment'>,
  ): ObservedMessage => ({
    ...m,
    text: i.redactor.redactText(m.text),
    id: `om-${i.runId}-${String(++seq)}`,
    org: i.org,
    persona: i.persona,
    snapshotId: i.snapshotId,
    observedAt: now().toISOString(),
    runId: i.runId,
    environment: i.environment,
  });

  const openDialog = async (page: Page): Promise<Locator> => {
    await page.goto(`${i.baseUrl}/lightning/r/Account/${accountId}/view`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const main = page.getByRole('main');
    await main.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 60_000 });
    const contacts = main.getByRole('article', { name: 'Contacts', exact: true });
    if ((await contacts.count()) === 0 || !(await contacts.isVisible())) {
      await main.getByRole('tab', { name: 'Related', exact: true }).click();
    }
    await contacts.getByRole('button', { name: 'New', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: /New Contact/ });
    await dialog.waitFor({ state: 'visible', timeout: 60_000 });
    return dialog;
  };
  const cancel = async (page: Page, dialog: Locator): Promise<void> => {
    if (!(await dialog.isVisible().catch(() => false))) return;
    const btn = dialog.getByRole('button', { name: 'Cancel', exact: true });
    if ((await btn.count()) === 1) await btn.click().catch(() => undefined);
    else await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => undefined);
  };
  /** Wait until the Save produced something observable: an invalid field, an alert, a warning, or a closed dialog. */
  const settle = async (page: Page, dialog: Locator, probe: Locator): Promise<void> => {
    await page
      .getByRole('status', { name: /^Loading/ })
      .first()
      .waitFor({ state: 'hidden', timeout: 30_000 })
      .catch(() => undefined);
    await probe
      .or(dialog.getByRole('alert'))
      .or(page.getByRole('dialog', { name: POPOVER }))
      .or(dialog.getByText(POPOVER))
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);
    await dialog.waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => undefined);
  };

  async function attempt(
    name: AttemptOutcome['attempt'],
    fill: (dialog: Locator) => Promise<string[]>,
    read: (page: Page, dialog: Locator, before: string) => Promise<ObservedMessage[]>,
    probe: (dialog: Locator) => Locator,
    /** Field whose description is read before the Save (baseline: only new text is a message). */
    baselineField?: string,
  ): Promise<void> {
    const page = await context.newPage();
    const out: AttemptOutcome = { attempt: name, before: 0, after: 0, created: false, messages: [], notes: [] };
    try {
      log(`Observing: ${name} …`);
      const beforeIds = await contactsOnAccount();
      out.before = beforeIds.length;
      const dialog = await openDialog(page);
      out.notes.push(...(await fill(dialog)));
      const before = baselineField ? await describedText(field(dialog, baselineField)) : '';
      await i.sf.uiAttempt('save-attempt', 'Contact', async () => {
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await settle(page, dialog, probe(dialog));
        return { attempt: name };
      });
      out.messages = await read(page, dialog, before);
      // Diagnostics (local evidence, redacted): what the reader saw, so a missed message can be explained.
      const probeField = baselineField ? field(dialog, baselineField) : undefined;
      const diag = {
        fieldCount: probeField ? await probeField.count() : null,
        ariaInvalid: probeField ? await probeField.getAttribute('aria-invalid').catch(() => null) : null,
        describedBy: probeField ? await probeField.getAttribute('aria-describedby').catch(() => null) : null,
        describedText: probeField ? await describedText(probeField) : null,
        popoverDialogs: await page.getByRole('dialog', { name: POPOVER }).count(),
      };
      writeFileSync(
        join(i.evidenceDir, `${name}.diag.json`),
        `${JSON.stringify(diag, null, 2)}
`,
      );
      const aria = await page
        .locator('body')
        .ariaSnapshot({ timeout: 15_000 })
        .catch(() => '');
      writeFileSync(join(i.evidenceDir, `${name}.aria.yml`), i.redactor.redactText(aria));
      const shot = join(i.evidenceDir, `${name}.png`);
      await page.screenshot({ path: shot }).catch(() => undefined);
      out.screenshot = relative(i.root, shot).split('\\').join('/');
      out.messages = out.messages.map((m) => ({ ...m, screenshot: out.screenshot }));
      await cancel(page, dialog);
      const afterIds = await contactsOnAccount();
      out.after = afterIds.length;
      for (const id of afterIds.filter((x) => !beforeIds.includes(x))) {
        out.created = true;
        await i.engine.adoptCreated(`ui-${name}`, 'Contact', id, i.sf.identity.userId, started);
        out.notes.push('the Save created a record: adopted (run tag + ledger) and removed by the cleanup');
      }
      log(
        `  ${name}: ${out.messages.length ? out.messages.map((m) => `[${m.placement}] "${m.text}"`).join(' · ') : 'no message observed'} · Contacts ${String(out.before)} → ${String(out.after)}`,
      );
    } catch (err) {
      out.error = err instanceof Error ? (err.message.split('\n')[0] ?? 'error') : String(err);
      log(`  ${name}: ${out.error}`);
    } finally {
      await page.close().catch(() => undefined);
      attempts.push(out);
    }
  }

  const SNAG = /^\s*We hit a snag/;
  const fieldMessages = async (
    page: Page,
    dialog: Locator,
    label: string,
    apiName: string,
    kind: ObservedMessage['kind'],
    before: string,
  ): Promise<ObservedMessage[]> => {
    const out: ObservedMessage[] = [];
    // The save went through (form closed, no popover): nothing to read.
    if ((await dialog.count()) === 0 && (await page.getByRole('dialog', { name: POPOVER }).count()) === 0) return out;
    for (const t of await popoverTexts(page, dialog, SNAG)) {
      out.push(msg({ page: 'contact-new', field: apiName, kind, placement: 'page', text: t }));
    }
    await closePopovers(page);
    let text = await describedText(field(dialog, label));
    if (!text) text = messageFromAriaSnapshot(await dialog.ariaSnapshot({ timeout: 15_000 }).catch(() => ''), label);
    // Only text that appeared with the Save (inline help that was already there is not a message).
    if (text && text !== before) out.push(msg({ page: 'contact-new', field: apiName, kind, placement: 'field', text }));
    return out;
  };
  const uniqueName = (label: string): string => `QA-${i.runId}-${label}`;

  try {
    // 1. Standard required-field message (Last Name empty).
    await attempt(
      'required-last-name',
      async () => Promise.resolve(['Last Name left empty']),
      (page, d, before) => fieldMessages(page, d, 'Last Name', 'Contact.LastName', 'required', before),
      (d) => field(d, 'Last Name').and(d.locator('[aria-invalid="true"]')),
      'Last Name',
    );
    // 2. Invalid email format (standard Salesforce validation of an Email field).
    await attempt(
      'invalid-email',
      async (d) => {
        await field(d, 'Last Name').fill(uniqueName('email'));
        await field(d, 'Email').fill('not-an-email');
        return ['Email "not-an-email" with a run-unique Last Name'];
      },
      (page, d, before) => fieldMessages(page, d, 'Email', 'Contact.Email', 'validation', before),
      (d) => field(d, 'Email').and(d.locator('[aria-invalid="true"]')),
      'Email',
    );
    // 3. Last Name with 81 characters (field length 80): does the input truncate, or does Save show an error?
    await attempt(
      'last-name-81',
      async (d) => {
        const v = `${uniqueName('len')}-${'x'.repeat(81)}`.slice(0, 81);
        await field(d, 'Last Name').fill(v);
        const kept = (await field(d, 'Last Name').inputValue()).length;
        return [`typed 81 characters; the input kept ${String(kept)}`];
      },
      (page, d, before) => fieldMessages(page, d, 'Last Name', 'Contact.LastName', 'validation', before),
      (d) => field(d, 'Last Name').and(d.locator('[aria-invalid="true"]')),
      'Last Name',
    );
    // 4. Duplicate warning (same Email on the same Account as the seed Contact). "Save anyway" is never pressed.
    if (typeof seedEmail === 'string' && seedEmail) {
      await attempt(
        'duplicate-email',
        async (d) => {
          await field(d, 'Last Name').fill(uniqueName('dup'));
          await field(d, 'Email').fill(seedEmail);
          return ['Email of the seed Contact on the same Account'];
        },
        async (page, d) => {
          const texts = await popoverTexts(page, d, DUPLICATE);
          await closePopovers(page);
          return texts.map((t) =>
            msg({
              page: 'contact-new',
              field: 'Contact.Email',
              kind: 'duplicate',
              placement: 'alert',
              text: t,
              ...(i.duplicateRule ? { rule: i.duplicateRule } : {}),
            }),
          );
        },
        (d) => d.page().getByRole('dialog', { name: DUPLICATE }).or(d.getByText(DUPLICATE)),
      );
    } else {
      log('  duplicate-email: skipped — the approved recipe gives the seed Contact no Email');
    }
  } finally {
    await context.close().catch(() => undefined);
  }

  log('Cleaning up the seed and any adopted record (reverse order, tag re-checked, re-query) …');
  const cleanup = await i.engine.cleanup();
  return { attempts, messages: attempts.flatMap((a) => a.messages), cleanup };
}
