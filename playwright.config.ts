// Runner config for generated tests (tests/generated/**). Projects are generated from config/personas.yaml: one
// auth-setup project and one test project per persona; a test runs in the project of its `@persona:<id>` tag.
// Phase 4 only lists the tests (`npx playwright test --list`); the Runner (Phase 5) executes approved tests.
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import type { ReportingLabsOptions } from 'reporting-labs';
import { join } from 'node:path';
import { runSettings, storageStatePath } from './tests/support/runConfig.js';

const s = runSettings();
const desktop = s.execution.viewports[0] ?? { width: 1440, height: 900 };

const reportingLabs: ReportingLabsOptions = {
  title: `SF QA — ${s.storyKey}`,
  outputFolder: join(s.runDir, 'reporting-labs'),
  history: { enabled: true, keep: 30 },
  dimensions: ['priority', 'severity', 'feature', 'owner', 'story'],
  maskKeys: ['password', 'token', 'sessionId', 'accessToken', 'refreshToken', 'sid', 'authorization'],
  metadata: { org: s.orgAlias, run: s.runId },
};

const projects: NonNullable<PlaywrightTestConfig['projects']> = s.personas.personas.flatMap((p) => [
  { name: `auth-${p.id}`, testDir: './tests/setup', testMatch: /auth\.setup\.ts$/, metadata: { persona: p.id } },
  {
    name: p.id,
    grep: new RegExp(`@persona:${p.id}(\\s|$)`),
    dependencies: [`auth-${p.id}`],
    metadata: { persona: p.id },
    use: {
      ...devices['Desktop Chrome'],
      channel: s.channel,
      viewport: { width: desktop.width, height: desktop.height },
      storageState: storageStatePath(s.orgAlias, p.id),
    },
  },
]);

export default defineConfig({
  testDir: './tests/generated',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1, // a pass on retry = flaky, reported as such
  workers: 4,
  outputDir: join(s.runDir, 'test-results'),
  use: {
    baseURL: s.baseURL,
    headless: s.execution.headless,
    testIdAttribute: s.execution.testIdAttribute,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: join(s.runDir, 'results.json') }],
    ['html', { open: 'never', outputFolder: join(s.runDir, 'playwright-report') }],
    ['reporting-labs', reportingLabs],
  ],
  projects,
});
