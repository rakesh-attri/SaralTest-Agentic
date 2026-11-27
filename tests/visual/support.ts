// Shared setup of the visual + a11y suite: project persona / viewport, snapshot names, ratios and masks from
// config/execution.yaml, and attachments the runner turns into the visual-diff report (src/visual/collect.ts).
import type { Locator, Page, TestInfo } from '@playwright/test';
import { snapshotName, type LayoutFinding, type VisualRegion } from '../../src/core/schemas/visual.js';
import { checkLayout } from '../support/layout.js';
import { runSettings } from '../support/runConfig.js';
import {
  contentClip,
  expectRegionScreenshot,
  markVolatile,
  maskLocators,
  maskPlan,
  regionShot,
  settle,
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
  await settle(page);
  await markVolatile(masks.hide);
  const clip = c.clipToContent ? await contentClip(locator) : undefined;
  const o = { mask, maxDiffPixelRatio: ratioFor(region), ...(clip ? { clip } : {}) };
  await expectRegionScreenshot(page, locator, name, o);
  // The masked image of this run, attached even on a match: `qa visual approve` can re-approve it (release change).
  await testInfo.attach(`visual-shot-${name}.png`, {
    body: await regionShot(page, locator, o),
    contentType: 'image/png',
  });
  const findings = await checkLayout(page, locator, {
    region,
    viewport: p.viewport,
    layoutShiftThreshold: settings.execution.visual.layoutShiftThreshold,
  });
  await testInfo.attach(`visual-layout-${region}.json`, {
    body: JSON.stringify({ region, name, findings }, null, 2),
    contentType: 'application/json',
  });
  return findings;
}

/** The run prefix every synthetic value of this run carries (masked wherever it appears). */
export const runPrefix = (): string => settings.runId;
