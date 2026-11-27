// `qa heal --investigation <id> [--apply]`: Self-Healer over an investigation run's SCRIPT_* verdicts.
// Without --apply only the plans are shown (nothing changes). Output: runs/<heal run>/heal/{repairs.json, heal-report.md}.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { QAError } from '../../core/errors.js';
import { Investigation, type Environment, type HealRepair } from '../../core/schemas/index.js';
import { LocatorRegistry } from '../../knowledge/locatorRegistry.js';
import { investigationDir } from '../failure-investigator/run.js';
import { healFailure, planRepairs, type HealDeps } from './index.js';

export const InvestigationsFile = z.object({
  sourceRun: z.string(),
  runId: z.string(),
  environment: z.enum(['LIVE', 'FIXTURE', 'MOCK']),
  investigations: z.array(Investigation),
});

export function readInvestigations(root: string, invRun: string): z.infer<typeof InvestigationsFile> {
  const f = join(investigationDir(root, invRun), 'investigations.json');
  if (!existsSync(f)) throw new QAError('DATA', `no investigations in runs/${invRun} (run qa investigate first)`);
  return InvestigationsFile.parse(JSON.parse(readFileSync(f, 'utf8')));
}

export interface HealRunResult {
  environment: Environment;
  repairs: HealRepair[];
  refused: { caseId: string; reason: string }[];
  files: string[];
}

export async function healRun(o: { investigationRun: string; apply: boolean }, d: HealDeps): Promise<HealRunResult> {
  const inv = readInvestigations(d.root, o.investigationRun);
  const script = inv.investigations.filter((i) => i.verdict === 'SCRIPT_LOCATOR' || i.verdict === 'SCRIPT_TIMING');
  const other = inv.investigations.filter((i) => !script.includes(i));
  const label = inv.environment === 'LIVE' ? '' : ` [${inv.environment}]`;
  d.say(`Self-Healer${label}: ${script.length} script failure(s); ${other.length} other verdict(s) are never healed.`);
  const repairs: HealRepair[] = [];
  const refused: HealRunResult['refused'] = other.map((i) => ({
    caseId: i.caseId ?? i.failureId,
    reason: `${i.verdict}: not a script problem`,
  }));
  for (const i of script) {
    if (!o.apply) {
      const reg = new LocatorRegistry(d.registryFile);
      try {
        const { plans, refused: why } = planRepairs(d.root, i, d.policy.healing.maxAttemptsPerTest, reg);
        if (why) refused.push({ caseId: i.caseId ?? i.failureId, reason: why });
        for (const p of plans) {
          d.say(
            `  plan ${i.caseId ?? ''}: ${p.kind === 'locator' ? `${p.member.ref} "${p.row.accessibleName ?? ''}" → "${p.newName}"${p.behaviourChanging ? ' (behaviour-changing: needs approval)' : ''}` : `waits ×${p.factor}`}`,
          );
        }
      } finally {
        reg.close();
      }
      continue;
    }
    const res = await healFailure(i, { ...d, environment: inv.environment });
    repairs.push(...res.repairs);
    if (res.refused) refused.push({ caseId: i.caseId ?? i.failureId, reason: res.refused });
  }
  const dir = join(d.root, 'runs', d.runId, 'heal');
  mkdirSync(dir, { recursive: true });
  const json = join(dir, 'repairs.json');
  writeFileSync(
    json,
    JSON.stringify(
      { investigationRun: o.investigationRun, environment: inv.environment, applied: o.apply, repairs, refused },
      null,
      2,
    ) + '\n',
  );
  const md = join(dir, 'heal-report.md');
  writeFileSync(md, renderHealReport(o.investigationRun, inv.environment, o.apply, repairs, refused));
  return { environment: inv.environment, repairs, refused, files: [json, md] };
}

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderHealReport(
  invRun: string,
  env: Environment,
  applied: boolean,
  repairs: readonly HealRepair[],
  refused: readonly { caseId: string; reason: string }[],
): string {
  const l: string[] = [`# Self-Healer report — ${invRun}`, ''];
  if (env !== 'LIVE')
    l.push(
      `> **${env}** — repairs proven on the ${env === 'FIXTURE' ? 'offline fixture' : 'mock'} are reverted after verification; they never change the live org's page objects.`,
      '',
    );
  l.push(
    applied ? 'Repairs were applied and verified by a rerun.' : 'Plan only (`--apply` not given): nothing changed.',
    '',
  );
  l.push(
    'Rule 7: every repair compares the assertion fingerprint (spec `expect` / oracle calls + IR assertions) before and after; a difference refuses the repair.',
    '',
  );
  if (repairs.length) {
    l.push(
      '| Repair | Case | Kind | Change | Assertions unchanged | Fingerprint | Status | Rerun |',
      '|---|---|---|---|---|---|---|---|',
    );
    for (const r of repairs) {
      const change =
        r.kind === 'locator'
          ? `${r.locatorBefore?.accessibleName ?? ''} → ${r.locatorAfter?.accessibleName ?? ''}`
          : `${r.waitBefore?.timeoutMs ?? ''} → ${r.waitAfter?.timeoutMs ?? ''} ms`;
      l.push(
        `| ${r.id} | ${r.caseId} | ${r.kind} | ${cell(change)} | ${r.assertionsUnchanged ? 'yes' : '**NO**'} | ${r.fingerprintBefore.sha256.slice(0, 10)} → ${r.fingerprintAfter.sha256.slice(0, 10)} (${r.fingerprintAfter.count}) | ${r.status}${r.revertOf ? ` of ${r.revertOf}` : ''} | ${r.verification?.state ?? '—'} |`,
      );
    }
  }
  if (refused.length) {
    l.push('', '**Not healed**', '', ...refused.map((x) => `- ${x.caseId}: ${cell(x.reason)}`));
  }
  l.push('');
  return l.join('\n');
}
