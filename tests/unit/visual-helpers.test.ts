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
  observeLayoutShift,
  readLayoutShift,
  type ElementBox,
} from '../support/layout.js';
import { DATE_PATTERNS, RECORD_ID_PATTERN, maskLocators, maskPlan, settle, shotOptions } from '../support/visual.js';

const ACCOUNT = '001FX0000000001AAA';

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

  it('masks resolve inside the region and a masked region screenshot is stable', async () => {
    const main = await openRecord(page, 'Account', ACCOUNT);
    const masks = maskLocators(page, main, maskPlan(['dates', 'recordIds', 'spinners', 'userNames', 'pii'], 'QA-'));
    expect(await masks.at(-2)?.count()).toBeGreaterThan(0); // record title
    await settle(page);
    const o = shotOptions({ mask: masks, maxDiffPixelRatio: 0.01 });
    const a = await main.screenshot({
      mask: o.mask,
      maskColor: o.maskColor,
      animations: o.animations,
      caret: o.caret,
      scale: o.scale,
    });
    const b = await main.screenshot({
      mask: o.mask,
      maskColor: o.maskColor,
      animations: o.animations,
      caret: o.caret,
      scale: o.scale,
    });
    expect(a.equals(b)).toBe(true);
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
