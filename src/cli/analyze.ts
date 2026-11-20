import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command as GraphCommand } from '@langchain/langgraph';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { loadEnv, secretValues, type Env } from '../config/env.js';
import { loadConfigFile, projectPaths, requireConfig } from '../config/loader.js';
import type { PolicyConfig } from '../config/schemas.js';
import { createLogger, type Logger } from '../core/logger.js';
import { newRunId, runPaths } from '../core/runFolder.js';
import type { Clarification } from '../core/schemas/index.js';
import { initialRunState, type Autonomy, type InputRequest } from '../core/state.js';
import { SqliteCheckpointSaver } from '../graph/checkpointer.js';
import {
  buildMainGraph,
  type ClarifyAnswer,
  type ClarifyRequest,
  type GraphDeps,
  type MainGraph,
} from '../graph/mainGraph.js';
import type { QAGraphStateType } from '../graph/state.js';
import { loadMcpJson, McpHub } from '../mcp/client.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { ModelRouter } from '../models/router.js';
import { initTracing, type Tracing } from '../observability/tracing.js';
import { Redactor } from '../security/redact.js';
import { SecretStore } from '../security/secretStore.js';
import { SkillLoader } from '../skills/skillLoader.js';
import { Prompter } from './prompter.js';

/**
 * Shared runtime for `qa analyze`, `qa chat` and `qa resume`: config, secrets, models, MCP, tracing, checkpointer and
 * the Phase 1 graph — plus the human side of the clarify interrupt (prompt with the policy's wait time).
 */

export type Say = (msg: string) => void;

export interface RuntimeOptions {
  root: string;
  /** No network: no model calls (mechanical analysis), no MCP. */
  offline?: boolean;
  /** Connect the Atlassian Rovo MCP server (remote OAuth; may open a browser). Default: JIRA REST. */
  useMcp?: boolean;
  say: Say;
  logLevel?: 'info' | 'warn' | 'error' | 'debug';
}

export interface Runtime {
  deps: GraphDeps;
  env: Env;
  policy: PolicyConfig;
  checkpointer: SqliteCheckpointSaver;
  graph: MainGraph;
  close(): Promise<void>;
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const paths = projectPaths(o.root);
  const env0 = await loadEnv(o.root);
  const store = new SecretStore(env0);
  // Secrets may live in Windows Credential Manager; adapters receive them in memory only (never logged).
  const jiraToken = (await store.get('JIRA_API_TOKEN')).value;
  const env: Env = { ...env0, ...(jiraToken ? { JIRA_API_TOKEN: jiraToken } : {}) };
  const secrets = secretValues(env);
  const redactor = new Redactor({ secrets });
  const logger: Logger = createLogger({ level: o.logLevel ?? 'warn', redact: (obj) => redactor.redactValue(obj) });
  const policy = await requireConfig('policy', paths);

  let router: ModelRouter | undefined;
  if (o.offline) {
    o.say('Offline: no model calls — requirements are derived mechanically and all need review.');
  } else {
    const models = await loadConfigFile('models', paths);
    if (!models.ok) {
      o.say(`config/models.yaml unusable (${models.errors.join('; ')}) — continuing with mechanical analysis.`);
    } else {
      router = await ModelRouter.create({
        config: models.value,
        secrets: { get: async (k) => (await store.get(k)).value, setting: (k) => env[k] },
        secretValues: () => secrets,
        logger,
      });
      const r = router.status().find((s) => s.role === 'reasoning');
      o.say(
        `Models: reasoning = ${r?.provider ?? '?'}/${r?.model ?? '?'}${r?.fallback ? ` (fallback ${r.fallback.provider}/${r.fallback.model})` : ''}${r?.ok ? '' : ` — NOT USABLE: ${r?.error ?? ''}`}`,
      );
    }
  }

  let mcp: McpHub | undefined;
  if (o.useMcp && !o.offline) {
    try {
      const servers = (await loadMcpJson(o.root)).mcpServers;
      if (servers['atlassian-rovo']) {
        mcp = new McpHub({
          servers: { 'atlassian-rovo': servers['atlassian-rovo'] },
          allowList: new ToolAllowList(await requireConfig('mcp-tools', paths)),
          redactor,
          logger,
          connectTimeoutMs: 120_000,
        });
      }
    } catch (err) {
      o.say(`MCP not available (${err instanceof Error ? err.message : String(err)}); JIRA will use REST.`);
    }
  }

  let tracing: Tracing | undefined;
  const obs = await loadConfigFile('observability', paths);
  if (obs.ok && !o.offline) {
    tracing = await initTracing({ config: obs.value, env, redactor, logger }).catch(() => undefined);
  }

  const checkpointer = new SqliteCheckpointSaver(join(o.root, '.qa-memory', 'checkpoints.db'));
  const deps: GraphDeps = {
    root: o.root,
    policy,
    logger,
    ...(router ? { router } : {}),
    skills: SkillLoader.forProject(o.root),
    redactor,
    adapter: {
      root: o.root,
      cwd: process.cwd(),
      env,
      ...(mcp
        ? { mcp, callCtx: { runId: 'analysis', orgId: 'none', user: env.JIRA_EMAIL ?? 'unknown', persona: 'qa-agent' } }
        : {}),
    },
    memoryDir: join(o.root, '.qa-memory'),
    checkpointer,
    ...(tracing ? { tracer: tracing.tracer } : {}),
    onProgress: o.say,
  };
  return {
    deps,
    env,
    policy,
    checkpointer,
    graph: buildMainGraph(deps),
    async close() {
      await mcp?.close();
      await tracing?.flush().catch(() => undefined);
      await tracing?.shutdown().catch(() => undefined);
      checkpointer.close();
    },
  };
}

// ------------------------------------------------------------------ answering questions
export const AnswersFile = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String));

export async function loadAnswersFile(path: string): Promise<Record<string, string>> {
  const parsed = AnswersFile.safeParse(parseYaml(await readFile(path, 'utf8')));
  if (!parsed.success) throw new Error(`answers file ${path}: expected "Q1: answer" lines`);
  return parsed.data;
}

export interface AskOptions {
  rl?: Prompter;
  /** 0 = wait indefinitely. */
  waitMinutes: number;
  answersFile?: Record<string, string>;
  say: Say;
}

export function formatQuestion(q: Clarification): string {
  return [
    `${q.id} (priority ${q.priority ?? '-'}${q.refs.length ? `; ${q.refs.join(', ')}` : ''}${q.requirementIds.length ? `; affects ${q.requirementIds.join(', ')}` : ''})`,
    `  ${q.question}`,
    ...(q.testImpact ? [`  Test impact: ${q.testImpact}`] : []),
    ...(q.proposedAssumption ? [`  If unanswered: ${q.proposedAssumption}`] : []),
  ].join('\n');
}

/** Collect answers for one clarification round (answers file first, then the console with a time limit). */
export async function collectAnswers(req: ClarifyRequest, o: AskOptions): Promise<ClarifyAnswer> {
  const answers: Record<string, string> = {};
  o.say(
    `\nClarification round ${req.round}: ${req.questions.length} question(s). Press Enter to skip one (it will be assumed and flagged).`,
  );
  for (const q of req.questions) {
    const fromFile = o.answersFile?.[q.id];
    if (fromFile !== undefined) {
      answers[q.id] = fromFile;
      o.say(`${formatQuestion(q)}\n  Answer (from file): ${fromFile}`);
    }
  }
  const remaining = req.questions.filter((q) => answers[q.id] === undefined);
  if (!remaining.length || !o.rl) return { answers, timedOut: remaining.length > 0 };
  const deadline = o.waitMinutes > 0 ? Date.now() + o.waitMinutes * 60_000 : undefined;
  if (deadline)
    o.say(
      `Waiting up to ${o.waitMinutes} min for answers (policy clarification.waitMinutes); after that the proposed assumptions are used.`,
    );
  for (const q of remaining) {
    o.say(formatQuestion(q));
    const left = deadline ? deadline - Date.now() : undefined;
    if (left !== undefined && left <= 0) return { answers, timedOut: true };
    try {
      const a = await o.rl.ask('  Your answer> ', left !== undefined ? AbortSignal.timeout(left) : undefined);
      if (a === undefined) {
        o.say('  (input ended)');
        return { answers, timedOut: true };
      }
      answers[q.id] = a;
    } catch {
      o.say('  (no answer in time)');
      return { answers, timedOut: true };
    }
  }
  return { answers, timedOut: false };
}

/** Run (or resume) the graph until it finishes, answering clarification interrupts on the way. */
export async function drive(
  rt: Runtime,
  runId: string,
  first: Parameters<MainGraph['invoke']>[0],
  ask: (req: ClarifyRequest) => Promise<ClarifyAnswer>,
): Promise<QAGraphStateType> {
  const config = { configurable: { thread_id: runId }, recursionLimit: 60 };
  let input: Parameters<MainGraph['invoke']>[0] = first;
  for (;;) {
    await rt.graph.invoke(input, config);
    const snap = await rt.graph.getState(config);
    const pending = snap.tasks
      .flatMap((t) => t.interrupts)
      .find((i) => (i.value as ClarifyRequest | undefined)?.kind === 'clarification');
    if (!pending) return snap.values as QAGraphStateType;
    input = new GraphCommand({ resume: await ask(pending.value as ClarifyRequest) });
  }
}

export interface AnalyzeOptions {
  inputs: InputRequest[];
  autonomy: Autonomy;
  interactive: boolean;
  runId?: string;
  storyKey?: string;
  answersFile?: Record<string, string>;
  rl?: Prompter;
}

export async function startAnalysis(rt: Runtime, o: AnalyzeOptions, say: Say): Promise<QAGraphStateType> {
  const runId = o.runId ?? newRunId('run');
  const models = await loadConfigFile('models', projectPaths(rt.deps.root));
  const budgets = models.ok ? models.value.budgets : { tokensPerRun: 2_000_000, minutesPerRun: 90 };
  const primary = o.inputs.find((i) => i.kind === 'jira' || i.kind === 'ado' || i.kind === 'file' || i.kind === 'chat');
  const state = {
    ...initialRunState({
      runId,
      org: 'none (analysis only)',
      autonomy: o.autonomy,
      source: {
        type:
          primary?.kind === 'jira'
            ? 'jira'
            : primary?.kind === 'ado'
              ? 'ado'
              : primary?.kind === 'chat'
                ? 'chat'
                : 'file',
        ref: primary?.kind === 'chat' ? 'chat' : (primary?.value ?? 'none'),
      },
      ...(o.storyKey ? { storyKey: o.storyKey } : {}),
      tokenLimit: budgets.tokensPerRun,
      timeLimitMin: budgets.minutesPerRun,
      inputs: o.inputs,
    }),
    interactive: o.interactive,
  };
  say(`Run ${runId} — output in ${runPaths(rt.deps.root, runId).dir}`);
  const wait = rt.policy.clarification.waitMinutes[o.autonomy];
  return drive(rt, runId, state, (req) =>
    collectAnswers(req, {
      ...(o.rl ? { rl: o.rl } : {}),
      waitMinutes: wait,
      ...(o.answersFile ? { answersFile: o.answersFile } : {}),
      say,
    }),
  );
}

export async function resumeAnalysis(
  rt: Runtime,
  runId: string,
  o: { rl?: Prompter; answersFile?: Record<string, string> },
  say: Say,
): Promise<QAGraphStateType | undefined> {
  const config = { configurable: { thread_id: runId } };
  const snap = await rt.graph.getState(config);
  if (!Object.keys(snap.values as object).length) return undefined;
  const values = snap.values as QAGraphStateType;
  if (!snap.next.length) {
    say(`Run ${runId} already finished with status ${values.status}.`);
    return values;
  }
  const pending = snap.tasks
    .flatMap((t) => t.interrupts)
    .find((i) => (i.value as ClarifyRequest | undefined)?.kind === 'clarification');
  say(`Resuming ${runId} at ${snap.next.join(', ')}${pending ? ' (waiting for clarification answers)' : ''} …`);
  const wait = rt.policy.clarification.waitMinutes[values.autonomy];
  const ask = (req: ClarifyRequest): Promise<ClarifyAnswer> =>
    collectAnswers(req, {
      ...(o.rl ? { rl: o.rl } : {}),
      waitMinutes: wait,
      ...(o.answersFile ? { answersFile: o.answersFile } : {}),
      say,
    });
  return drive(
    rt,
    runId,
    pending ? new GraphCommand({ resume: await ask(pending.value as ClarifyRequest) }) : null,
    ask,
  );
}

// ------------------------------------------------------------------ summary
export function summary(v: QAGraphStateType, root: string): string {
  const reqs = v.requirements;
  const exec = reqs.filter((r) => r.status === 'EXECUTABLE').length;
  const lines = [
    '',
    `=== ${v.storyKey ?? v.runId}: ${v.status} ===${v.analysisEnvironment === 'MOCK' ? '  [MOCK model output]' : v.analysisEnvironment === 'NONE' ? '  [mechanical: no model]' : ''}`,
    `Sources: ${v.sources.map((d) => `${d.docId} (${d.source.type}, ${d.sections.length} sections)`).join(', ') || 'none'}`,
    `Existing manual tests: ${v.existingTests.length}`,
    `Requirements: ${reqs.length} (${exec} executable, ${reqs.length - exec} review required)`,
  ];
  for (const r of reqs)
    lines.push(
      `  ${r.id.padEnd(16)} ${r.status.padEnd(15)} ${r.type.padEnd(14)} [${r.sources.map((s) => s.section ?? s.ref).join(', ')}] ${r.title ?? r.businessObjective}`,
    );
  lines.push(`Questions: ${v.clarifications.length}`);
  for (const c of v.clarifications) {
    lines.push(`  ${c.id} [${c.status}] ${c.question}`);
    if (c.answer) lines.push(`      answer: ${c.answer}`);
    if (c.status === 'ASSUMED') lines.push(`      assumed (unconfirmed): ${c.assumption ?? ''}`);
  }
  const byKind = new Map<string, number>();
  for (const f of v.findings) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
  lines.push(
    `Findings: ${v.findings.length}${byKind.size ? ` (${[...byKind].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`,
  );
  if (v.issues.length) {
    lines.push(`Issues: ${v.issues.length}`);
    for (const i of v.issues) lines.push(`  ${i.kind} at ${i.node}: ${i.message} → ${i.resolution ?? 'unresolved'}`);
  }
  const report = join(runPaths(root, v.runId).dir, 'analysis', 'analysis-report.md');
  lines.push(`Report: ${existsSync(report) ? report : '(not written)'}`);
  return lines.join('\n');
}

/** `/why <id>`: answer from the evidence ledger and the cited source text, never from memory. */
export function explain(v: QAGraphStateType, id: string): string {
  const key = id.trim().toUpperCase();
  const req = v.requirements.find((r) => r.id.toUpperCase() === key || r.id.toUpperCase().endsWith(`-${key}`));
  if (req) {
    const ev = v.evidence.filter((e) => e.id === `EV-${req.id}`);
    const cited = req.sources.map((s) => {
      const doc = v.sources.find((d) => d.source.ref === s.ref && d.source.hash === s.hash);
      const sec = doc?.sections.find((x) => x.ref === s.section);
      return `  [${doc?.docId ?? s.ref}#${s.section ?? ''}] ${sec?.text.split('\n').join(' / ') ?? '(clarification or section not loaded)'}`;
    });
    return [
      `${req.id} — ${req.status}`,
      `  ${req.businessObjective}`,
      `  Expected: ${req.expectedOutcomes.join('; ') || '(not stated)'}`,
      ...(req.reviewReasons.length ? [`  Review reasons: ${req.reviewReasons.join('; ')}`] : []),
      ...(req.assumptions.known.length ? [`  Assumptions: ${req.assumptions.known.join('; ')}`] : []),
      'Cited sources:',
      ...cited,
      ...ev.map((e) => `Evidence ${e.id}: agent ${e.agent}, confidence ${e.confidence}, ${e.environment}`),
    ].join('\n');
  }
  const q = v.clarifications.find((c) => c.id.toUpperCase() === key);
  if (q)
    return `${formatQuestion(q)}\n  Status: ${q.status}${q.answer ? `; answer: ${q.answer}` : ''}${q.assumption ? `; assumption: ${q.assumption}` : ''}`;
  const f = v.findings.find((x) => x.id.toUpperCase() === key);
  if (f)
    return `${f.id} ${f.kind} [${f.severity}; ${f.origin}${f.rule ? `:${f.rule}` : ''}] (${f.refs.join(', ')})\n  ${f.text}`;
  const t = v.triageLog.filter((d) => d.issueId.toUpperCase() === key);
  if (t.length) return t.map((d) => `${d.issueId} ${d.kind} at ${d.node} → ${d.response}: ${d.reason}`).join('\n');
  return `Nothing with id "${id}" in this run (try a requirement id, Q1, F-001 or an issue id).`;
}

export function createReadline(): Prompter {
  return Prompter.forStdio();
}
