// Shared setup of the visual + a11y suite: project persona / viewport, snapshot names, ratios and masks from
// config/execution.yaml, and attachments the runner turns into the visual-diff report (src/visual/collect.ts).
import type { Locator, Page, TestInfo } from '@playwright/test';
import { snapshotName, type LayoutFinding, type VisualRegion } from '../../src/core/schemas/visual.js';
import { checkLayout } from '../support/layout.js';
import { runSettings } from '../support/runConfig.js';
import { expectRegionScreenshot, maskLocators, maskPlan, shotOptions } from '../support/visual.js';

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
export async function captureRegion(
  page: Page,
  testInfo: TestInfo,
  region: VisualRegion,
  locator: Locator,
  runPrefix: string,
): Promise<LayoutFinding[]> {
  const p = visualProject(testInfo);
  const name = snapshotName(region, p.persona, p.viewport);
  const mask = maskLocators(
    page,
    locator,
    maskPlan([...settings.execution.visual.mask, 'names', 'counters'], runPrefix),
  );
  await expectRegionScreenshot(page, locator, name, { mask, maxDiffPixelRatio: ratioFor(region) });
  // The masked image of this run, attached even on a match: `qa visual approve` can re-approve it (release change).
  const o = shotOptions({ mask, maxDiffPixelRatio: ratioFor(region) });
  await testInfo.attach(`visual-shot-${name}.png`, {
    body: await locator.screenshot({
      mask: o.mask,
      maskColor: o.maskColor,
      animations: o.animations,
      caret: o.caret,
      scale: o.scale,
    }),
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
