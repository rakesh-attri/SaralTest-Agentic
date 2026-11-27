/// <reference lib="dom" />
// Visual masks + local layout checks: pure parts, then against the offline fixture pages (real Chromium, FIXTURE).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../src/fixture/server.js';
import { REPO_ROOT } from '../helpers/tempProject.js';
import { openRecord, relatedList, selectTab } from '../support/lightning.js';
import {
  analyzeLayout,
  analyzePageState,
  checkLayout,
  collectLayout,
  layoutFails,
  observeLayoutShift,
  readLayoutShift,
  type ElementBox,
} from '../support/layout.js';
import {
  DATE_PATTERNS,
  RECORD_ID_PATTERN,
  VOLATILE_ATTR,
  markFieldValues,
  markVolatile,
  maskLocators,
  maskPlan,
  pageClip,
  regionShot,
  settle,
  unmarkedVolatile,
  VOLATILE_FIELD_LABELS,
  waitForRegionReady,
} from '../support/visual.js';
import { layoutFindingKey } from '../../src/core/schemas/visual.js';
import { layoutSections } from '../../src/visual/tabOrder.js';

const ACCOUNT = '001FX0000000001AAA';
const CONTACT = '003FX0000000001AAA';

const box = (o: Partial<ElementBox> & { index: number }): ElementBox => ({
  parent: -1,
  name: `el${String(o.index)}`,
  role: 'button',
  x: 0,
  y: 0,
  width: 100,
  height: 30,
  visible: true,
  required: false,
  interactive: true,
  overflowPx: 0,
  ...o,
});
const where = { region: 'new-contact-dialog' as const, viewport: 'desktop' };

describe('mask plan (pure)', () => {
  it('maps config categories to text patterns, links, title and status', () => {
    const p = maskPlan(['dates', 'recordIds', 'spinners', 'userNames', 'pii'], 'run-p6-x');
    expect(p.links && p.title && p.status).toBe(true);
    expect(p.text.some((r) => r.test('QA-run-p6-x-Acme-1a2b'))).toBe(true);
    expect(p.text.some((r) => r.test('qa+tag@example.invalid'))).toBe(true);
    const none = maskPlan([]);
    expect(none).toEqual({ text: [], links: false, title: false, status: false });
  });

  it('date and id patterns match rendered values but not labels', () => {
    const date = (s: string): boolean => DATE_PATTERNS.some((r) => r.test(s));
    expect(date('Rakesh, 11/27/2026, 10:05 AM')).toBe(true);
    expect(date('2026-11-27')).toBe(true);
    expect(date('Mailing Address')).toBe(false);
    expect(RECORD_ID_PATTERN.test('003FX0000000001AAA')).toBe(true);
    expect(RECORD_ID_PATTERN.test('MailingPostalCode')).toBe(false); // 17 letters, no digit
  });
});

describe('layout analysis (pure)', () => {
  it('reports overlapping interactive elements but not nested ones', () => {
    const f = analyzeLayout(
      {
        viewport: { width: 1440, height: 900 },
        boxes: [
          box({ index: 0, name: 'Save', x: 0 }),
          box({ index: 1, name: 'Cancel', x: 60 }),
          box({ index: 2, name: 'Inner', parent: 1, x: 70 }),
        ],
      },
      where,
    );
    expect(f.map((x) => x.kind)).toEqual(['overlap', 'overlap']); // Save×Cancel, Save×Inner; Cancel⊃Inner skipped
    expect(f[0]?.elements).toEqual(['Save', 'Cancel']);
  });

  it('reports clipped fixed text, off-screen controls, hidden required controls and layout shift', () => {
    const f = analyzeLayout(
      {
        viewport: { width: 1024, height: 768 },
        boxes: [
          box({ index: 0, name: 'Mailing Street', role: 'label', interactive: false, overflowPx: 14 }),
          box({ index: 1, name: 'Save', x: 1000, width: 80 }),
          box({ index: 2, name: 'Last Name', role: 'textbox', required: true, visible: false, y: 200 }),
        ],
      },
      { ...where, layoutShift: 0.25, layoutShiftThreshold: 0.1 },
    );
    expect(f.map((x) => x.kind).sort()).toEqual(['clipped-text', 'hidden-required', 'layout-shift', 'off-screen']);
  });

  it('owner: Salesforce-owned findings are baseline candidates; ours and real field overlaps fail (run-p6-live-1)', () => {
    const sf = { owner: 'salesforce' as const };
    const f = analyzeLayout(
      {
        viewport: { width: 1440, height: 900 },
        pageOwner: 'salesforce',
        boxes: [
          // the modal's sticky footer over a scrolled textbox (Salesforce chrome)
          box({ index: 0, name: 'Mailing Street', role: 'textbox', field: true, ...sf }),
          box({ index: 1, name: 'Cancel', x: 10, pinned: true, ...sf }),
          // a Preview button on a lookup link
          box({ index: 2, name: 'link', role: 'link', y: 100, ...sf }),
          box({ index: 3, name: 'Preview', y: 100, x: 50, ...sf }),
          // two field controls on top of each other: real, always FAIL
          box({ index: 4, name: 'Email', role: 'textbox', field: true, y: 300, ...sf }),
          box({ index: 5, name: 'Phone', role: 'textbox', field: true, y: 310, ...sf }),
          // our own component overlapping a Salesforce one: FAIL
          box({ index: 6, name: 'Our Button', y: 500, owner: 'ours' }),
          box({ index: 7, name: 'Save', y: 500, x: 50, ...sf }),
        ],
      },
      { ...where, layoutShift: 0.9, layoutShiftThreshold: 0.1 },
    );
    const fails = layoutFails(f).map((x) => x.elements.join('×'));
    expect(fails.sort()).toEqual(['Email×Phone', 'Our Button×Save']);
    const shift = f.find((x) => x.kind === 'layout-shift');
    expect(shift?.owner).toBe('salesforce'); // load-time shift on a Lightning page
    expect(layoutFindingKey({ kind: 'overlap', elements: ['Preview', 'link'] })).toBe('overlap:Preview|link');
  });

  it('page state: blank, loading and error banner', () => {
    expect(
      analyzePageState(
        { bodyTextLength: 3, hasMain: false, spinnersVisible: 1, errorTexts: ['Sorry to interrupt'] },
        where,
      ).map((x) => x.kind),
    ).toEqual(['blank-page', 'loading-not-finished', 'error-banner']);
    expect(analyzePageState({ bodyTextLength: 500, hasMain: true, spinnersVisible: 0, errorTexts: [] }, where)).toEqual(
      [],
    );
  });
});

describe('visual + layout helpers on the offline fixture (real Chromium, FIXTURE)', () => {
  let server: FixtureServer;
  let browser: Browser;
  let context: BrowserContext | undefined;
  let page: Page;

  beforeAll(async () => {
    server = await startFixtureServer({ fixtureDir: join(REPO_ROOT, 'examples', 'fixture'), port: 0 });
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
    await server.close();
  });
  beforeEach(async () => {
    await context?.close();
    const ctx = await browser.newContext({ baseURL: server.url, viewport: { width: 1440, height: 900 } });
    context = ctx;
    page = await ctx.newPage();
    await observeLayoutShift(page);
    await page.goto(`/secur/frontdoor.jsp?sid=fixture-admin-token&retURL=/lightning/page/home`);
  });

  const openDialog = async (): Promise<ReturnType<Page['getByRole']>> => {
    const main = await openRecord(page, 'Account', ACCOUNT);
    await selectTab(main.getByRole('tab', { name: 'Related', exact: true }));
    await relatedList(main, 'Contacts').getByRole('button', { name: 'New', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New Contact' });
    await dialog.waitFor();
    return dialog;
  };

  it('the New Contact dialog has no layout findings; a seeded overlap and hidden required field are found', async () => {
    const dialog = await openDialog();
    expect(await checkLayout(page, dialog, where)).toEqual([]);
    expect(await readLayoutShift(page)).toBeTypeOf('number');
    const snap = await collectLayout(dialog);
    expect(snap.boxes.some((b) => b.name === 'Last Name' && b.required)).toBe(true);
    expect(snap.boxes.some((b) => b.role === 'link' && b.name !== 'link' && /QA-|@/.test(b.name))).toBe(false); // no values

    // seed: push Cancel onto Save, hide the required Last Name input
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).evaluate((el) => {
      (el as HTMLElement).style.cssText = 'position:relative; left:60px;';
    });
    await dialog.getByRole('button', { name: 'Save', exact: true }).evaluate((el) => {
      (el as HTMLElement).style.cssText = 'position:relative; left:-20px;';
    });
    await dialog.getByRole('textbox', { name: 'Last Name', exact: true }).evaluate((el) => {
      (el as HTMLElement).style.display = 'none';
    });
    const kinds = (await checkLayout(page, dialog, where)).map((f) => f.kind);
    expect(kinds).toContain('hidden-required');
  });

  it('record pages: name, owner and system field values are hidden by label; capture waits for the region', async () => {
    await openRecord(page, 'Contact', CONTACT);
    const details = page.getByRole('main').getByRole('tabpanel', { name: 'Details', exact: true });
    await selectTab(page.getByRole('main').getByRole('tab', { name: 'Details', exact: true }));
    await waitForRegionReady(page, details);
    expect(await markFieldValues(details, VOLATILE_FIELD_LABELS)).toBeGreaterThanOrEqual(2); // Name, Created By
    const hidden = await details.locator(`[${VOLATILE_ATTR}]`).allInnerTexts();
    expect(hidden.join(' ')).toMatch(/QA-|Admin/); // the values, never the labels
    expect(hidden.join(' ')).not.toMatch(/^Name$|Created By/);
    // a value container that also holds the label is never marked (qa-prod run-p6-live-5: label hidden)
    await details.evaluate((el) => {
      const item = document.createElement('records-record-layout-item');
      item.className = 'test-id__field-value-wrapper';
      item.innerHTML = '<div><span>Account Owner</span></div><div class="other">Someone</div>';
      el.appendChild(item);
    });
    await markFieldValues(details, ['Account Owner']);
    expect(await details.locator('records-record-layout-item').getAttribute(VOLATILE_ATTR)).toBeNull();
    // a run-tagged value whose matched container also holds the label: only the value is hidden (run-p6-live-5/6)
    await details.evaluate((el) => {
      const item = document.createElement('div');
      item.setAttribute('data-test', 'item');
      const host = document.createElement('lightning-formatted-text');
      host.attachShadow({ mode: 'open' }).innerHTML = '<span>QA-run-x Acme</span>';
      item.innerHTML = '<span>Account Name</span>';
      item.append(host);
      el.appendChild(item);
    });
    const tagged = maskLocators(page, details, maskPlan(['names'], 'QA-run-x'));
    await markVolatile(tagged.hide);
    expect(await details.locator('[data-test="item"]').getAttribute(VOLATILE_ATTR)).toBeNull();
    expect(await details.getByText('Account Name').last().getAttribute(VOLATILE_ATTR)).toBeNull();
    expect(await details.getByText('QA-run-x Acme').getAttribute(VOLATILE_ATTR)).toBe('');
    expect(await unmarkedVolatile(tagged.hide)).toBe(0);
    // the same tagged name split over two text nodes: the value element is hidden, never the item with the label
    await details.evaluate((el) => {
      const item = document.createElement('div');
      item.setAttribute('data-test', 'split');
      const host = document.createElement('lightning-formatted-name');
      const value = document.createElement('span');
      value.append(document.createTextNode('QA-run'), document.createTextNode('-y Beta'));
      host.attachShadow({ mode: 'open' }).append(value);
      item.innerHTML = '<span>Contact Name</span>';
      item.append(host);
      el.appendChild(item);
    });
    const split = maskLocators(page, details, maskPlan(['names'], 'QA-run-y'));
    await markVolatile(split.hide);
    expect(await details.locator('[data-test="split"]').getAttribute(VOLATILE_ATTR)).toBeNull();
    expect(await details.getByText('Contact Name').getAttribute(VOLATILE_ATTR)).toBeNull();
    expect(await unmarkedVolatile(split.hide)).toBe(0);
    // a re-rendered (fresh) node is detected as not hidden
    const plan = maskLocators(page, details, maskPlan(['dates'], 'QA-'));
    await markVolatile(plan.hide);
    expect(await unmarkedVolatile(plan.hide)).toBe(0);
    await details.evaluate((el) => {
      const fresh = document.createElement('span');
      fresh.textContent = '11/27/2026';
      el.appendChild(fresh);
    });
    expect(await unmarkedVolatile(plan.hide)).toBe(1);
    // page clip: document coordinates at the top of the page
    const clip = await pageClip(page, details);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(clip.width).toBeGreaterThan(0);
  });

  it('a placeholder in the region keeps the capture waiting; an open dialog is not a blank page', async () => {
    const main = await openRecord(page, 'Account', ACCOUNT);
    await main.evaluate((el) => {
      const ph = document.createElement('force-placeholder2');
      ph.style.cssText = 'display:block;height:20px';
      el.appendChild(ph);
      // an empty 0×0 placeholder (Account highlights panel after load) does not block the capture
      el.appendChild(document.createElement('force-placeholder2'));
    });
    await expect(waitForRegionReady(page, main, 1500)).rejects.toThrow();
    await main
      .locator('force-placeholder2')
      .first()
      .evaluate((el) => {
        el.remove();
      });
    await waitForRegionReady(page, main);
    const dialog = await openDialog();
    await page.getByRole('main').evaluate((el) => {
      el.setAttribute('aria-hidden', 'true');
    }); // as Lightning does
    expect((await checkLayout(page, dialog, where)).map((f) => f.kind)).not.toContain('blank-page');
  });

  it("the fixture serves its Contact form layout (describe/layouts) with the section's Tab direction", async () => {
    const r = await page.request.get('/services/data/v62.0/sobjects/Contact/describe/layouts', {
      headers: { Authorization: 'Bearer fixture-admin-token' },
    });
    const sections = layoutSections(await r.json(), 'edit');
    expect(sections[0]?.tabOrder).toBe('LeftToRight');
    expect(sections[0]?.cells.find((c) => c.fields.includes('MailingCity'))?.fields[0]).toBe('MailingAddress');
  });

  it('volatile values are hidden at their own size; the masked region screenshot is stable', async () => {
    const main = await openRecord(page, 'Account', ACCOUNT);
    const masks = maskLocators(page, main, maskPlan(['dates', 'recordIds', 'spinners', 'userNames', 'pii'], 'QA-'));
    expect(masks.mask).toHaveLength(1); // spinners
    expect(await masks.hide.at(-1)?.count()).toBeGreaterThan(0); // record title
    await settle(page);
    expect(await markVolatile(masks.hide)).toBeGreaterThan(0);
    const o = { mask: masks.mask, maxDiffPixelRatio: 0.01 };
    const a = await regionShot(page, main, o);
    const b = await regionShot(page, main, o);
    expect(a.equals(b)).toBe(true);
    const title = page.getByRole('main').getByRole('heading', { level: 1 });
    expect(await title.getAttribute(VOLATILE_ATTR)).toBe('');
    expect(await title.isVisible()).toBe(true); // hidden only inside the screenshot (style option), not on the page
  });
});

describe('unnamed controls from an ARIA snapshot (pure)', () => {
  it('lists controls without a name by role and position, never values', async () => {
    const { unnamedControls } = await import('../support/a11y.js');
    const snap = [
      '- dialog "New Contact":',
      '  - textbox "Last Name": QA-run-x-1',
      '  - textbox',
      '  - button "Save"',
      '  - button',
      '  - combobox "Lead Source": --None--',
      '  - link "Acme \\"Q\\" Ltd"',
      '  - textbox [disabled]',
    ].join('\n');
    expect(unnamedControls(snap)).toEqual(['textbox #2', 'button #2', 'textbox #3']);
  });
});
