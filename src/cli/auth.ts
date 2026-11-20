import type { Command } from 'commander';
import { newRunId } from '../core/runFolder.js';
import { ensureStorageState } from '../sf/auth/browserState.js';
import { SfCliSessionProvider } from '../sf/auth/sfCli.js';
import { createSfContext } from '../sf/context.js';

type Say = (msg: string) => void;

/** `qa auth status|login` — identity check and browser session per persona (PLAN.md §7b). */
export function registerAuth(program: Command, rootOf: () => string, say: Say): void {
  const auth = program.command('auth').description('Salesforce auth: JWT login, identity check, browser session');

  auth
    .command('status')
    .description('Identity check: Organization + userinfo must match config/orgs.yaml and personas.yaml')
    .option('--org <alias>', 'org alias from config/orgs.yaml (default QA_DEFAULT_ORG)')
    .option('--persona <id>', 'persona id (default from personas.yaml)')
    .action(async (o: { org?: string; persona?: string }) => {
      const ctx = await createSfContext({
        root: rootOf(),
        runId: newRunId('auth'),
        ...(o.org ? { orgAlias: o.org } : {}),
        ...(o.persona ? { personaId: o.persona } : {}),
      });
      say(`Checking identity of ${ctx.org.alias} (${ctx.org.profile}) as persona ${ctx.persona.id}…`);
      const sf = await ctx.connect();
      const id = sf.identity;
      process.stdout.write(
        [
          `Verified: org ${id.orgId} (${id.organizationType}, IsSandbox=${String(id.isSandbox)}, ${id.environment})`,
          `  user     ${id.username} (persona ${id.personaId})`,
          `  instance ${id.instanceUrl}  API v${id.apiVersion}${id.releaseLabel ? `  release ${id.releaseLabel}` : ''}`,
          ...id.warnings.map((w) => `  warning: ${w}`),
          '',
        ].join('\n'),
      );
    });

  auth
    .command('login')
    .description('JWT login via the External Client App (no password/MFA), identity check, then browser storageState')
    .option('--org <alias>', 'org alias from config/orgs.yaml (default QA_DEFAULT_ORG)')
    .option('--persona <id>', 'persona id (default from personas.yaml)')
    .option('--no-browser', 'skip the browser session (.auth/<org>/<persona>.json)')
    .option('--refresh', 'create a new browser session even if the saved one is fresh')
    .action(async (o: { org?: string; persona?: string; browser: boolean; refresh?: boolean }) => {
      const ctx = await createSfContext({
        root: rootOf(),
        runId: newRunId('auth'),
        ...(o.org ? { orgAlias: o.org } : {}),
        ...(o.persona ? { personaId: o.persona } : {}),
      });
      if (ctx.provider instanceof SfCliSessionProvider) {
        say(`JWT login for ${ctx.persona.username} → alias ${ctx.persona.sfAlias}…`);
        await ctx.provider.jwtLogin({ persona: ctx.persona, org: ctx.org });
      }
      const sf = await ctx.connect();
      say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username}.`);
      if (o.browser) {
        const st = await ensureStorageState({
          provider: ctx.provider,
          request: { persona: ctx.persona, org: ctx.org, ...(o.refresh ? { refresh: true } : {}) },
          authDir: ctx.authDir,
          ttlMinutes: ctx.personas.sessionTtlMinutes,
          browser: ctx.execution.browser,
          headless: ctx.execution.headless,
        });
        say(`Browser session ${st.reused ? 'reused' : 'saved'}: ${st.path} (landed on ${st.landedHost}).`);
      }
    });
}
