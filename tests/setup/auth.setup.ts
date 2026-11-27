// One browser session per persona (salesforce-auth-personas skill): identity check first (HARD_STOP on mismatch),
// then a frontdoor session saved to .auth/<org>/<persona>.json. Never types a password.
import { test as setup } from '@playwright/test';
import { ensureStorageState } from '../../src/sf/auth/browserState.js';
import { createSfContext } from '../../src/sf/context.js';
import { runSettings } from '../support/runConfig.js';

setup('authenticate persona', async ({ browserName: _browser }, testInfo) => {
  const persona = String(testInfo.project.metadata['persona']);
  const s = runSettings();
  const ctx = await createSfContext({ root: s.root, runId: s.runId, orgAlias: s.orgAlias, personaId: persona });
  const sf = await ctx.connect();
  const state = await ensureStorageState({
    provider: ctx.provider,
    request: { persona: ctx.persona, org: ctx.org },
    authDir: ctx.authDir,
    ttlMinutes: ctx.personas.sessionTtlMinutes,
    browser: s.browser, // the Runner's resolved browser (QA_BROWSER), not the yaml default
    headless: ctx.execution.headless,
  });
  testInfo.annotations.push({
    type: 'identity',
    description: `${sf.identity.orgId} as ${sf.identity.username} (${sf.identity.environment}), landed on ${state.landedHost}`,
  });
});
