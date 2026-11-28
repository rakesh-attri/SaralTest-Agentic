// Phase 7 graph step after `execute` (PLAN.md §2: execute → failures? investigate → heal → execute | judge → file_bug):
// Failure Investigator on the run's failures → Self-Healer on SCRIPT_* verdicts (repairs verified by a rerun; FIXTURE
// repairs reverted) → Defect Judge drafts for PRODUCT_DEFECT / PERMISSION_CONFIG. Filing a bug is never done here: the
// operator approves the exact text (`qa defects approve/publish`). Every verdict becomes an Issue (already resolved)
// so the QA Lead's report shows what happened and who owns the next step.
import { join } from 'node:path';
import type { PolicyConfig } from '../config/schemas.js';
import type { Autonomy } from '../core/state.js';
import type {
  DefectDraft,
  EvidenceEntry,
  HealRepair,
  Investigation,
  Issue,
  IssueKind,
  TestResult,
  Verdict,
} from '../core/schemas/index.js';
import { createIssue } from '../core/issues.js';
import { judgeInvestigation } from '../agents/defect-judge/index.js';
import type { InvestigationProviders } from '../agents/failure-investigator/experiments.js';
import { investigateRun, ledgerFile } from '../agents/failure-investigator/run.js';
import { healRun } from '../agents/self-healer/run.js';
import { readCatalog } from '../agents/self-healer/index.js';
import { EvidenceLedger, toStateEvidence } from '../knowledge/evidenceLedger.js';
import type { ModelRouter } from '../models/router.js';
import type { Redactor } from '../security/redact.js';
import { ApprovalStore } from '../security/approvals.js';
import type { AuditLog } from '../security/audit.js';
import type { SkillLoader } from '../skills/skillLoader.js';
import type { Logger } from '../core/logger.js';

export interface InvestigateOutcome {
  investigations: Investigation[];
  defects: DefectDraft[];
  repairs: HealRepair[];
  evidence: EvidenceEntry[];
  issues: Issue[];
  files: string[];
}

export type InvestigateHook = (s: {
  runId: string;
  org: string;
  autonomy: Autonomy;
  results: readonly TestResult[];
}) => Promise<InvestigateOutcome>;

const KIND_OF: Record<Verdict, IssueKind> = {
  PRODUCT_DEFECT: 'PRODUCT_DEFECT',
  PERMISSION_CONFIG: 'PRODUCT_DEFECT',
  SCRIPT_LOCATOR: 'LOCATOR',
  SCRIPT_TIMING: 'LOCATOR',
  TEST_DATA: 'DATA',
  INVALID_REQUIREMENT_ASSUMPTION: 'AMBIGUOUS_SPEC',
  STALE_KNOWLEDGE: 'ENVIRONMENT',
  ENVIRONMENT: 'ENVIRONMENT',
  FLAKY: 'TRANSIENT',
  UNKNOWN: 'UNKNOWN',
};

export interface InvestigateHookDeps {
  root: string;
  policy: PolicyConfig;
  orgId: string;
  orgProfile: string;
  providers: InvestigationProviders;
  audit?: AuditLog;
  registryFile: string;
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
  say: (m: string) => void;
}

export function createInvestigateHook(d: InvestigateHookDeps): InvestigateHook {
  return async (s) => {
    const invRun = `${s.runId}-inv`.slice(0, 32);
    const res = await investigateRun(
      { root: d.root, sourceRun: s.runId, runId: invRun, policy: d.policy, say: d.say },
      {
        ...(d.router ? { router: d.router } : {}),
        ...(d.skills ? { skills: d.skills } : {}),
        ...(d.redactor ? { redactor: d.redactor } : {}),
        ...(d.logger ? { logger: d.logger } : {}),
        providers: d.providers,
      },
    );
    const investigations = res.investigations.map((x) => x.investigation);
    const ledger = new EvidenceLedger(ledgerFile(d.root));
    const files = [...res.files];
    let repairs: HealRepair[] = [];
    const defects: DefectDraft[] = [];
    try {
      if (investigations.some((i) => i.verdict === 'SCRIPT_LOCATOR' || i.verdict === 'SCRIPT_TIMING')) {
        const h = await healRun(
          { investigationRun: invRun, apply: true },
          {
            root: d.root,
            runId: `${invRun}-heal`,
            environment: res.environment,
            autonomy: s.autonomy,
            policy: d.policy,
            registryFile: d.registryFile,
            approvals: new ApprovalStore(join(d.root, '.qa-memory', 'approvals.jsonl')),
            ledger,
            ...(d.audit ? { audit: d.audit } : {}),
            orgIdForApprovals: readCatalog(d.root)?.org ?? d.orgId,
            ...(d.providers.rerun ? { rerun: d.providers.rerun } : {}),
            say: d.say,
          },
        );
        repairs = h.repairs;
        files.push(...h.files);
      }
      for (const i of investigations.filter(
        (x) => x.verdict === 'PRODUCT_DEFECT' || x.verdict === 'PERMISSION_CONFIG',
      )) {
        const result = s.results.find((r) => (r.caseId ?? r.testId) === i.caseId);
        const out = await judgeInvestigation(
          i,
          {
            root: d.root,
            runId: invRun,
            environment: res.environment,
            org: { alias: s.org, orgId: d.orgId, profile: d.orgProfile },
            reproductions: d.policy.investigation.reproductions,
            ...(result ? { result } : {}),
            sourceRun: s.runId,
          },
          {
            ...(d.router ? { router: d.router } : {}),
            ...(d.skills ? { skills: d.skills } : {}),
            ...(d.redactor ? { redactor: d.redactor } : {}),
            ...(d.logger ? { logger: d.logger } : {}),
            ledger,
          },
        );
        defects.push(out.draft);
        files.push(...out.files);
      }
      ledger.exportRun(invRun, join(d.root, 'runs', invRun, 'evidence', 'evidence.json'));
      const evidence = ledger.forRun(invRun).map(toStateEvidence);
      const issues = investigations.map((i) => {
        const healed = repairs.some((r) => r.failureId === i.failureId && r.status === 'VERIFIED');
        const defect = defects.find((x) => x.failureId === i.failureId);
        const kind = KIND_OF[i.verdict];
        return createIssue({
          kind,
          node: 'investigate',
          message: `${i.caseId ?? i.failureId}: ${i.verdict} (${i.confidence.toFixed(2)}) → ${i.route ?? 'qa-lead'}${healed ? ' · healed (verified rerun, assertions unchanged)' : ''}${defect ? ` · ${defect.id} ${defect.status ?? ''} (publication needs the operator's approval)` : ''}`,
          detail: {
            investigation: i.failureId,
            handled: ['investigate', ...(healed ? ['heal'] : []), ...(defect ? ['judge'] : [])],
          },
          resolution: healed ? 'RETRIED' : 'ESCALATED',
        });
      });
      return { investigations, defects, repairs, evidence, issues, files };
    } finally {
      ledger.close();
    }
  };
}
