// Runner config for the Phase 6 visual + accessibility suite (tests/visual/**), PLAN.md §7g.
// Projects: one auth-setup project per persona, then one project per persona × visual viewport
// (config/execution.yaml `visual.viewports`). Baselines live per org in `<visual.baselineDir>/<org>/<name>.png`;
// they are never written by a test run (`updateSnapshots: 'none'`) — only `qa visual approve` stores them.
// Started by `qa visual run` (src/visual/run.ts), which sets QA_* / SF_BASE_URL like `qa run`.
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { join } from 'node:path';
import { runSettings, storageStatePath } from './tests/support/runConfig.js';

const s = runSettings();
const personaIds = (process.env['QA_VISUAL_PERSONAS'] ?? 'system-admin').split(',').filter(Boolean);
const personas = s.personas.personas.filter((p) => personaIds.includes(p.id));
const viewports = (process.env['QA_VISUAL_VIEWPORTS']?.split(',') ?? s.execution.visual.viewports).map((name) => {
  const v = s.execution.viewports.find((x) => x.name === name);
  if (!v) throw new Error(`visual viewport ${name} is not defined in config/execution.yaml viewports`);
  return v;
});

const projects: NonNullable<PlaywrightTestConfig['projects']> = personas.flatMap((p) => [
  { name: `auth-${p.id}`, testDir: './tests/setup', testMatch: /auth\.setup\.ts$/, metadata: { persona: p.id } },
  ...viewports.map((v) => ({
    name: `visual-${p.id}-${v.name}`,
    dependencies: [`auth-${p.id}`],
    metadata: { persona: p.id, viewport: v.name },
    use: {
      ...devices['Desktop Chrome'],
      channel: s.channel,
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: 1,
      storageState: storageStatePath(s.orgAlias, p.id),
    },
  })),
]);

export default defineConfig({
  testDir: './tests/visual',
  testMatch: '**/*.spec.ts',
  timeout: 180_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: s.execution.visual.maxDiffPixelRatio,
      animations: 'disabled',
      caret: 'hide',
    },
  },
  snapshotPathTemplate: join(s.root, s.execution.visual.baselineDir, s.orgAlias, '{arg}{ext}'),
  updateSnapshots: 'none',
  retries: 0, // a visual retry would hide instability; toHaveScreenshot already waits for two equal frames
  workers: 2,
  outputDir: join(s.runDir, 'test-results'),
  use: {
    baseURL: s.baseURL,
    headless: s.execution.headless,
    testIdAttribute: s.execution.testIdAttribute,
    trace: 'retain-on-failure',
    screenshot: 'off', // region screenshots are the evidence; full-page screenshots could carry unmasked PII
    video: 'off',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  reporter: [
    ['list'],
    ['json', { outputFile: join(s.runDir, 'playwright-results.json') }],
    ['html', { open: 'never', outputFolder: join(s.runDir, 'playwright-report') }],
  ],
  projects,
});
