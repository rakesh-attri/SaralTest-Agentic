import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { loadEnv, secretValues } from '../config/env.js';
import { projectPaths, requireConfig } from '../config/loader.js';
import { createLogger } from '../core/logger.js';
import { exitCodeFor, formatReport, runDoctor } from '../doctor/runDoctor.js';
import { startFixtureServer } from '../fixture/server.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { loadMcpJson, McpHub } from '../mcp/client.js';
import { needsOAuth } from '../doctor/checks/mcp.js';
import { Redactor } from '../security/redact.js';

/** Walk up from `start` to the folder that holds CLAUDE.md + config/ (works from any sub-folder). */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'config', 'policy.yaml')) && existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

const say = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

export function buildCli(): Command {
  const program = new Command();
  program
    .name('qa')
    .description('sf-qa-agent — autonomous Salesforce QA engineer (Phase 0: foundation)')
    .option('--root <path>', 'project root (default: nearest folder with config/policy.yaml)')
    .showHelpAfterError();

  const rootOf = (): string => {
    const opts = program.opts<{ root?: string }>();
    return opts.root ? resolve(opts.root) : findProjectRoot(process.cwd());
  };

  program
    .command('doctor')
    .description('Check environment, browsers, model providers, MCP servers, Salesforce identity, Python sidecar')
    .option('--json', 'print the report as JSON only')
    .option('--live', 'make one tiny real call per model role (uses tokens)')
    .option('--offline', 'skip every network / external-process probe')
    .option('--include-oauth', 'also connect remote MCP servers that may open a browser OAuth consent')
    .option('--ci', 'CI mode (non-interactive)')
    .action(async (o: { json?: boolean; live?: boolean; offline?: boolean; includeOauth?: boolean; ci?: boolean }) => {
      const paths = projectPaths(rootOf());
      const logger = createLogger({ level: 'error' });
      const report = await runDoctor({
        paths,
        logger,
        options: {
          live: o.live === true,
          offline: o.offline === true,
          includeOAuth: o.includeOauth === true,
          ci: o.ci === true,
        },
        onProgress: o.json ? undefined : say,
      });
      process.stdout.write(`${o.json ? JSON.stringify(report, null, 2) : formatReport(report)}\n`);
      process.exitCode = exitCodeFor(report);
    });

  const mcp = program.command('mcp').description('MCP server utilities');
  mcp
    .command('tools')
    .description('List the real tools of each MCP server and how config/mcp-tools.yaml classifies them')
    .option('--server <name>', 'only this server')
    .option('--include-oauth', 'also connect remote servers that may open a browser OAuth consent')
    .action(async (o: { server?: string; includeOauth?: boolean }) => {
      const root = rootOf();
      const servers = (await loadMcpJson(root)).mcpServers;
      const allow = new ToolAllowList(await requireConfig('mcp-tools', projectPaths(root)));
      const env = await loadEnv(root);
      const hub = new McpHub({
        servers,
        allowList: allow,
        redactor: new Redactor({ secrets: secretValues(env) }),
        connectTimeoutMs: 180_000,
      });
      try {
        for (const name of Object.keys(servers)) {
          if (o.server && o.server !== name) continue;
          const cfg = servers[name];
          if (cfg && needsOAuth(cfg) && !o.includeOauth) {
            process.stdout.write(`== ${name}: skipped (remote OAuth server; pass --include-oauth)\n`);
            continue;
          }
          say(`Connecting to ${name}…`);
          const h = await hub.health(name);
          if (!h.ok) {
            process.stdout.write(`== ${name}: NOT REACHABLE (${h.kind ?? ''}) ${h.error ?? ''}\n`);
            continue;
          }
          process.stdout.write(`== ${name} (${h.tools.length} tools)\n`);
          for (const t of h.tools) process.stdout.write(`  ${allow.classify(name, t).padEnd(9)} ${t}\n`);
          const stale = allow.stale(name, h.tools);
          if (stale.length) process.stdout.write(`  stale allow-list entries: ${stale.join(', ')}\n`);
        }
      } finally {
        await hub.close();
      }
    });

  const fixture = program.command('fixture').description('Offline Salesforce fixture (results labelled FIXTURE)');
  fixture
    .command('serve')
    .description('Serve the offline fixture (mock REST/SOQL + Lightning-like pages)')
    .option('--port <n>', 'port', '4545')
    .action(async (o: { port: string }) => {
      const root = rootOf();
      const fx = await startFixtureServer({ fixtureDir: join(root, 'examples', 'fixture'), port: Number(o.port) });
      say(`OFFLINE FIXTURE serving at ${fx.url} (not Salesforce; everything is labelled FIXTURE)`);
      say(
        `  record page: ${fx.url}/secur/frontdoor.jsp?sid=fixture-admin-token&retURL=/lightning/r/Account/001FX0000000001AAA/view`,
      );
      say('  Ctrl+C to stop');
      const stop = (): void => {
        void fx.close().then(() => process.exit(0));
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });

  // Commands from CLAUDE.md that later phases implement. They say so instead of failing obscurely.
  const later: [string, string, number][] = [
    ['discover', 'Org discovery → snapshot + diff', 2],
    ['ingest', 'Documents, manual tests, defect history into RAG', 2],
    ['analyze', 'Requirements + clarification questions', 1],
    ['design', 'Test design', 3],
    ['review', 'Test Reviewer pass', 3],
    ['run', 'Full run / regression sets', 5],
    ['explore', 'Goal-directed exploration', 7],
    ['cleanup', 'Clean up + reconcile run-owned data', 4],
    ['report', 'Rebuild reports', 5],
    ['history', 'Past runs and trends', 9],
    ['learnings', 'Inspect learnings', 8],
    ['visual', 'Visual baselines', 6],
    ['chat', 'Chat REPL', 1],
    ['resume', 'Resume from checkpoint', 1],
  ];
  for (const [name, desc, phase] of later) {
    program
      .command(name)
      .description(`${desc} (arrives in Phase ${phase})`)
      .allowUnknownOption()
      .allowExcessArguments()
      .action(() => {
        say(`qa ${name}: not implemented yet — planned for Phase ${phase} (PLAN.md §11).`);
        process.exitCode = 2;
      });
  }
  return program;
}

await buildCli().parseAsync(process.argv);
