// Application Explorer — observed messages (Phase 5, operator decision 2026-11-26). Captures, by observation in the
// UI, the message texts the generator had no evidence for: the standard required-field message (empty Last Name), the
// invalid-email message, what the Last Name input does with 81 characters, and the duplicate warning of
// Contact_Same_Email_Same_Account. Each attempt is a Save click → a guarded, audited mutation (`uiAttempt`). A rejected
// save creates nothing; that is proven by SOQL. Anything a save did create is adopted (tag + ledger) and removed by the
// verified cleanup with the run-tagged seed records. "Save anyway" on a duplicate warning is never pressed.
import { mkdirSync } from 'node:fs';
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
async function describedText(page: Page, field: Locator): Promise<string> {
  const ids = ((await field.getAttribute('aria-describedby').catch(() => null)) ?? '').split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  for (const id of ids) {
    const el = page.locator(`[id="${id.replace(/"/g, '')}"]`);
    if ((await el.count()) !== 1) continue;
    const t = (await el.innerText().catch(() => '')).trim();
    if (t) parts.push(t);
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, MAX_TEXT);
}

async function visibleTexts(scope: Locator): Promise<string[]> {
  const out: string[] = [];
  for (const el of await scope.all()) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const t = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (t && !out.includes(t)) out.push(t.slice(0, MAX_TEXT));
  }
  return out;
}

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
      .or(page.getByText(/duplicate/i))
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);
    await dialog.waitFor({ state: 'hidden', timeout: 1_000 }).catch(() => undefined);
  };

  async function attempt(
    name: AttemptOutcome['attempt'],
    fill: (dialog: Locator) => Promise<string[]>,
    read: (page: Page, dialog: Locator) => Promise<ObservedMessage[]>,
    probe: (dialog: Locator) => Locator,
  ): Promise<void> {
    const page = await context.newPage();
    const out: AttemptOutcome = { attempt: name, before: 0, after: 0, created: false, messages: [], notes: [] };
    try {
      log(`Observing: ${name} …`);
      const beforeIds = await contactsOnAccount();
      out.before = beforeIds.length;
      const dialog = await openDialog(page);
      out.notes.push(...(await fill(dialog)));
      await i.sf.uiAttempt('save-attempt', 'Contact', async () => {
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await settle(page, dialog, probe(dialog));
        return { attempt: name };
      });
      out.messages = await read(page, dialog);
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

  const field = (dialog: Locator, name: string): Locator => dialog.getByRole('textbox', { name, exact: true });
  const fieldMessages = async (
    page: Page,
    dialog: Locator,
    label: string,
    apiName: string,
    kind: ObservedMessage['kind'],
  ): Promise<ObservedMessage[]> => {
    const out: ObservedMessage[] = [];
    const f = field(dialog, label);
    const text =
      (await f.getAttribute('aria-invalid').catch(() => null)) === 'true' ? await describedText(page, f) : '';
    if (text) out.push(msg({ page: 'contact-new', field: apiName, kind, placement: 'field', text }));
    for (const t of await visibleTexts(dialog.getByRole('alert'))) {
      out.push(msg({ page: 'contact-new', field: apiName, kind, placement: 'page', text: t }));
    }
    return out;
  };
  const uniqueName = (label: string): string => `QA-${i.runId}-${label}`;

  try {
    // 1. Standard required-field message (Last Name empty).
    await attempt(
      'required-last-name',
      async () => Promise.resolve(['Last Name left empty']),
      (page, d) => fieldMessages(page, d, 'Last Name', 'Contact.LastName', 'required'),
      (d) => field(d, 'Last Name').and(d.locator('[aria-invalid="true"]')),
    );
    // 2. Invalid email format (standard Salesforce validation of an Email field).
    await attempt(
      'invalid-email',
      async (d) => {
        await field(d, 'Last Name').fill(uniqueName('email'));
        await field(d, 'Email').fill('not-an-email');
        return ['Email "not-an-email" with a run-unique Last Name'];
      },
      (page, d) => fieldMessages(page, d, 'Email', 'Contact.Email', 'validation'),
      (d) => field(d, 'Email').and(d.locator('[aria-invalid="true"]')),
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
      (page, d) => fieldMessages(page, d, 'Last Name', 'Contact.LastName', 'validation'),
      (d) => field(d, 'Last Name').and(d.locator('[aria-invalid="true"]')),
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
        async (page) => {
          const texts = await visibleTexts(page.getByText(/duplicate/i));
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
        (d) => d.getByText(/duplicate/i),
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
