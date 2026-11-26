// `qa locators observe-messages --org <alias>`: the Application Explorer provokes and records the message texts the
// generator had no evidence for (required Last Name, invalid Email, 81-character Last Name, duplicate warning). Every
// Save is a guarded, audited mutation; seeds come from the approved `account-contact` recipe (human checkpoint for a
// new recipe version) and everything is cleaned up and re-queried. Texts are stored as OBSERVED evidence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { observeMessages, type ObserveMessagesResult } from '../agents/app-explorer/messages.js';
import { newRunId } from '../core/runFolder.js';
import type { Autonomy } from '../core/state.js';
import { ObservedMessageStore } from '../knowledge/observedMessages.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { ensureStorageState, playwrightLauncher } from '../sf/auth/browserState.js';
import { openDataSession } from '../sf/dataFactory.js';
import { maskId } from '../sf/data/report.js';

type Say = (msg: string) => void;

export const observedMessagesFile = (root: string): string => join(root, '.qa-memory', 'knowledge.db');

export function renderObserveReport(r: ObserveMessagesResult, o: { runId: string; org: string; env: string }): string {
  const L: string[] = [];
  L.push(`# Observed messages — ${o.runId}`, '');
  L.push(
    `Org ${o.org} (${o.env === 'LIVE' ? 'LIVE' : 'FIXTURE — offline fixture, not Salesforce'}). Evidence level: OBSERVED (UI observation; a human reviews it before an assertion relies on it).`,
    '',
  );
  L.push('| Attempt | Messages observed | Contacts on seed Account before → after | Record created | Notes |');
  L.push('|---|---|---|---|---|');
  for (const a of r.attempts) {
    const msgs = a.messages.map((m) => `[${m.placement}] "${m.text.replace(/\|/g, '\\|')}"`).join('<br>') || '—';
    L.push(
      `| ${a.attempt} | ${msgs} | ${String(a.before)} → ${String(a.after)} | ${a.created ? 'yes (adopted, cleaned)' : 'no'} | ${[...a.notes, ...(a.error ? [`ERROR: ${a.error}`] : [])].join('; ').replace(/\|/g, '\\|')} |`,
    );
  }
  L.push('', `## Cleanup: ${r.cleanup.status}`, '');
  for (const e of r.cleanup.entries) L.push(`- ${e.object} ${maskId(e.recordId)}: ${e.action}`);
  L.push(
    `- re-query: ${String(r.cleanup.verify.queries.length)} queries, ${String(r.cleanup.verify.remaining.length)} remaining`,
  );
  return `${L.join('\n')}\n`;
}

export function registerObserve(loc: Command, rootOf: () => string, say: Say): void {
  loc
    .command('observe-messages')
    .description(
      'Provoke and record message texts in the New Contact dialog (required, invalid email, 81 chars, duplicate) — guarded + audited, seeds cleaned up',
    )
    .requiredOption('--org <alias>', 'org alias from config/orgs.yaml')
    .option('--persona <id>', 'persona (default from personas.yaml)')
    .option('--autonomy <level>', 'L1 | L2 | L3 (default: policy)')
    .option('--run-id <id>', 'run id (default observe-<timestamp>)')
    .action(async (o: { org: string; persona?: string; autonomy?: Autonomy; runId?: string }) => {
      const root = rootOf();
      const runId = o.runId ?? newRunId('observe');
      // Refuses (nothing written) when the recipe version is not approved for this org at this autonomy level.
      const session = await openDataSession({
        root,
        runId,
        recipe: 'account-contact',
        orgAlias: o.org,
        ...(o.persona ? { personaId: o.persona } : {}),
        ...(o.autonomy ? { autonomy: o.autonomy } : {}),
        log: say,
      });
      const { ctx, sf, engine } = session;
      say(`Identity verified: ${sf.identity.orgId} as ${sf.identity.username} (${ctx.org.environment}).`);
      if (session.approval)
        say(`Recipe account-contact approved: ${session.approval.id} (${session.approval.approvedBy}).`);
      const snapshots = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
      const info = snapshots.latest(ctx.org.orgId);
      const snap = info ? snapshots.get(info.id) : undefined;
      snapshots.close();
      const dup = snap?.components.find(
        (c) => c.type === 'DuplicateRule' && c.parent === 'Contact' && c.body?.['active'] === true,
      );
      const state = await ensureStorageState({
        provider: ctx.provider,
        request: { persona: ctx.persona, org: ctx.org },
        authDir: ctx.authDir,
        ttlMinutes: ctx.personas.sessionTtlMinutes,
        browser: ctx.execution.browser,
        headless: ctx.execution.headless,
      });
      const browser = await playwrightLauncher({ browser: ctx.execution.browser, headless: ctx.execution.headless });
      let result: ObserveMessagesResult;
      try {
        const baseUrl =
          new URL(ctx.org.instanceUrl).hostname === state.landedHost
            ? ctx.org.instanceUrl.replace(/\/+$/, '')
            : `https://${state.landedHost}`;
        result = await observeMessages({
          browser,
          storageStatePath: state.path,
          baseUrl,
          sf,
          engine,
          org: ctx.org.orgId,
          persona: ctx.persona.id,
          snapshotId: snap?.info.id ?? 'none',
          runId,
          environment: ctx.org.environment,
          evidenceDir: join(ctx.run.dir, 'observe'),
          root,
          redactor: ctx.redactor,
          ...(dup ? { duplicateRule: dup.apiName } : {}),
          log: say,
        });
      } finally {
        await browser.close().catch(() => undefined);
      }
      const store = new ObservedMessageStore(observedMessagesFile(root));
      for (const m of result.messages) store.add(m);
      store.close();
      const dir = join(ctx.run.dir, 'observe');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'observed-messages.json'), `${JSON.stringify(result, null, 2)}\n`);
      const md = join(dir, 'observed-messages.md');
      writeFileSync(md, renderObserveReport(result, { runId, org: ctx.org.alias, env: ctx.org.environment }));
      say(
        `Cleanup: ${result.cleanup.status} (${String(result.cleanup.verify.remaining.length)} remaining after re-query)`,
      );
      say(`${String(result.messages.length)} message(s) stored as OBSERVED evidence in ${observedMessagesFile(root)}`);
      say(`Audit: ${ctx.run.auditLog}`);
      say(`Report: ${md}`);
      process.exitCode = result.cleanup.status === 'CLEAN' && result.attempts.every((a) => !a.error) ? 0 : 1;
    });
}
