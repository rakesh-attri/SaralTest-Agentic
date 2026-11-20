// Template for the generated-test runner config. Claude Code: generate personas/projects from config/personas.yaml.
import { defineConfig, devices } from '@playwright/test';
// Browser comes from config/execution.yaml: chromium (bundled) | chrome | msedge  -> Playwright `channel`
const channel = process.env.QA_BROWSER && process.env.QA_BROWSER !== 'chromium' ? process.env.QA_BROWSER : undefined;
import reportingLabs from './reporting-labs.config';

const runDir = process.env.QA_RUN_DIR ?? 'runs/local';
const baseURL = process.env.SF_BASE_URL; // Lightning domain of the sandbox

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 1,                       // a pass on retry = flaky, reported as such
  workers: 4,
  outputDir: `${runDir}/test-results`,
  use: {
    baseURL,
    channel,
    headless: true,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  reporter: [
    ['list'],
    ['json', { outputFile: `${runDir}/results.json` }],
    ['html', { open: 'never', outputFolder: `${runDir}/playwright-report` }],
    ['reporting-labs', reportingLabs],
  ],
  projects: [
    // auth.setup.ts reads QA_PERSONA and writes .auth/<persona>.json (see salesforce-auth-personas skill)
    { name: 'auth-sales-rep', testMatch: /auth\.setup\.ts/ },
    {
      name: 'functional-sales-rep',
      grep: /@functional/,
      dependencies: ['auth-sales-rep'],
      use: { ...devices['Desktop Chrome'], storageState: '.auth/sales-rep.json' },
    },
    { name: 'api', grep: /@api/, use: {} },
    { name: 'integration', grep: /@integration/, use: {} },
    { name: 'visual-desktop', grep: /@visual/, dependencies: ['auth-sales-rep'], use: { storageState: '.auth/sales-rep.json', viewport: { width: 1440, height: 900 } } },
    // ...one project per (test type x persona) generated from the charter
  ],
});
