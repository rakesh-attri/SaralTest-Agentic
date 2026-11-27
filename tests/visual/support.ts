// Shared setup of the visual + a11y suite: project persona / viewport, snapshot names, ratios and masks from
// config/execution.yaml, and attachments the runner turns into the visual-diff report (src/visual/collect.ts).
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { snapshotName, type LayoutFinding, type VisualRegion } from '../../src/core/schemas/visual.js';
import { checkLayout, layoutFails } from '../support/layout.js';
import { runSettings } from '../support/runConfig.js';
import {
  contentClip,
  expectRegionScreenshot,
  markVolatile,
  markFieldValues,
  maskLocators,
  maskPlan,
  pageClip,
  regionShot,
  settle,
  unmarkedVolatile,
  VOLATILE_FIELD_LABELS,
} from '../support/visual.js';

const settings = runSettings();

export interface VisualProject {
  persona: string;
  viewport: string;
}

export function visualProject(testInfo: TestInfo): VisualProject {
  const md = testInfo.project.metadata as { persona?: unknown; viewport?: unknown };
  if (typeof md.persona !== 'string' || typeof md.viewport !== 'string') {
    throw new Error(`project ${testInfo.project.name} has no persona/viewport metadata (playwright.visual.config.ts)`);
  }
  return { persona: md.persona, viewport: md.viewport };
}

export function ratioFor(region: VisualRegion): number {
  return settings.execution.visual.regionRatio[region] ?? settings.execution.visual.maxDiffPixelRatio;
}

/**
 * Screenshot of one region against its baseline (soft), then the local layout checks. Layout findings are attached
 * (`visual-layout.json`) as review candidates; they do not fail the test.
 */
export interface CaptureOptions {
  /** Inputs whose value is a run-specific record name (a lookup's selected value): masked too. */
  extraMasks?: Locator[];
  /** Capture the overlay's content box instead of the full-viewport dialog element (modal dialogs). */
  clipToContent?: boolean;
}

export async function captureRegion(
  page: Page,
  testInfo: TestInfo,
  region: VisualRegion,
  locator: Locator,
  runPrefix: string,
  c: CaptureOptions = {},
): Promise<LayoutFinding[]> {
  const p = visualProject(testInfo);
  const name = snapshotName(region, p.persona, p.viewport);
  const plan = maskPlan([...settings.execution.visual.mask, 'names', 'counters'], runPrefix);
  // An overlay is captured by its content box: page-level masks (record title, spinners behind the backdrop) would
  // be painted over the dialog content, so only masks inside the dialog apply.
  const regionPlan = c.clipToContent ? { ...plan, title: false, status: false } : plan;
  const masks = maskLocators(page, locator, regionPlan);
  const mask = [...masks.mask, ...(c.extraMasks ?? [])];
  await settle(page, locator); // no spinner, no loading placeholder, text and size stable
  // Record pages: the record name, owners and system fields are always hidden (the dialog's inputs are masked).
  const markAll = async (): Promise<void> => {
    await markVolatile(masks.hide);
    if (!c.clipToContent) await markFieldValues(locator, VOLATILE_FIELD_LABELS);
  };
  await markAll();
  // Lightning may re-render after marking; a fresh node would show its value. Re-mark until every match is hidden.
  await expect
    .poll(
      async () => {
        await markAll();
        return unmarkedVolatile(masks.hide);
      },
      { message: `${name}: every volatile value is hidden before capture`, intervals: [250, 500, 1000] },
    )
    .toBe(0);
  const clip = c.clipToContent ? await contentClip(locator) : await pageClip(page, locator);
  const o = { mask, maxDiffPixelRatio: ratioFor(region), clip, ...(c.clipToContent ? {} : { fullPage: true }) };
  await expectRegionScreenshot(page, locator, name, o);
  // Re-rendered during the capture → the image may show a value: never offer it as a baseline proposal.
  expect(await unmarkedVolatile(masks.hide), `${name}: a volatile value re-rendered during capture`).toBe(0);
  // The masked image of this run, attached even on a match: `qa visual approve` can re-approve it (release change).
  await testInfo.attach(`visual-shot-${name}.png`, {
    body: await regionShot(page, locator, o),
    contentType: 'image/png',
  });
  const findings = await checkLayout(page, locator, {
    region,
    viewport: p.viewport,
    layoutShiftThreshold: settings.execution.visual.layoutShiftThreshold,
    customNamespaces: settings.execution.a11y.customNamespaces,
    standardNamespaces: settings.execution.a11y.standardNamespaces,
  });
  await testInfo.attach(`visual-layout-${region}.json`, {
    body: JSON.stringify({ region, name, findings }, null, 2),
    contentType: 'application/json',
  });
  // Our own components, or a real overlap of two field controls, fail the test; Salesforce-owned findings are
  // baseline candidates (accepted with `qa visual approve --layout`), like Salesforce-owned a11y rules.
  expect
    .soft(
      layoutFails(findings).map((f) => f.detail),
      `${region}: layout findings on our components / fields`,
    )
    .toEqual([]);
  return findings;
}

/** The run prefix every synthetic value of this run carries (masked wherever it appears). */
export const runPrefix = (): string => settings.runId;

/**
 * Open the New Contact dialog from the Contacts related list. Lightning shows the modal shell (Cancel and close +
 * spinner) at once and names the dialog only when the form has loaded: qa-prod run-p6-live-3 (A11Y-001 desktop) took
 * longer than the default 15 s. Same 60 s as a record page load; the error names the state it stopped in.
 */
export async function openNewContactDialog(newButton: Locator, dialog: Locator, timeout = 60_000): Promise<void> {
  await newButton.click();
  await expect(dialog, 'New Contact dialog: the form did not load (modal shell / spinner only)').toBeVisible({
    timeout,
  });
}
