// Runner config for generated tests (tests/generated/**). Projects are generated from config/personas.yaml: one
// auth-setup project and one test project per persona; a test runs in the project of its `@persona:<id>` tag.
// The Runner (src/runner/execute.ts, `qa run`) executes approved tests and sets QA_* / SF_BASE_URL.
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import type { ReportingLabsOptions } from 'reporting-labs';
import { join } from 'node:path';
import { runSettings, storageStatePath } from './tests/support/runConfig.js';
import { waitFactor as runWaitFactor } from './tests/support/waits.js';

const s = runSettings();
// QA_WAIT_FACTOR scales timeouts only (Investigator rerun-extended-waits); assertions are unchanged.
const waitFactor = runWaitFactor();
const desktop = s.execution.viewports[0] ?? { width: 1440, height: 900 };

const environment = process.env['QA_ENVIRONMENT'] ?? 'UNKNOWN';
const reportingLabs: ReportingLabsOptions = {
  title: `SF QA — ${s.storyKey}${environment === 'LIVE' ? '' : ` (${environment} — not a Salesforce result)`}`,
  outputFolder: join(s.runDir, 'reporting-labs'),
  // History lives next to the story's runs, not inside one run folder, so the trend spans runs.
  history: { enabled: true, keep: 30, file: join(s.root, '.qa-memory', 'reporting-labs-history.json') },
  dimensions: ['priority', 'severity', 'feature', 'owner', 'story'],
  maskKeys: [
    'password',
    'token',
    'sessionId',
    'accessToken',
    'refreshToken',
    'sid',
    'authorization',
    'secret',
    'apiKey',
  ],
  maskFromEnv: true,
  ...(process.env['QA_JIRA_BASE_URL']
    ? { links: { story: `${process.env['QA_JIRA_BASE_URL'].replace(/\/+$/, '')}/browse/{id}` } }
    : {}),
  metadata: { org: s.orgAlias, run: s.runId, environment, build: s.runId },
  envVar: 'QA_ENVIRONMENT',
  env: {
    Environment: environment,
    Org: s.orgAlias,
    Browser: s.browser,
    Personas: s.personas.personas.map((p) => p.id).join(', '),
    Snapshot: process.env['QA_SNAPSHOT_ID'] ?? 'unknown',
  },
  emitJson: true,
  pdf: false,
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
  timeout: 120_000 * waitFactor,
  expect: { timeout: 15_000 * waitFactor },
  // a pass on retry = flaky, reported as such. Investigator reruns set QA_RETRIES=0 (one attempt = one reproduction).
  retries: process.env['QA_RETRIES'] === '0' ? 0 : 1,
  workers: 4,
  outputDir: join(s.runDir, 'test-results'),
  use: {
    baseURL: s.baseURL,
    headless: s.execution.headless,
    testIdAttribute: s.execution.testIdAttribute,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000 * waitFactor,
    navigationTimeout: 60_000 * waitFactor,
  },
  reporter: [
    ['list'],
    // results.json is the Runner's normalised TestResult[]; Playwright's own JSON goes next to it.
    ['json', { outputFile: join(s.runDir, 'playwright-results.json') }],
    ['html', { open: 'never', outputFolder: join(s.runDir, 'playwright-report') }],
    ['reporting-labs', reportingLabs],
  ],
  projects,
});
