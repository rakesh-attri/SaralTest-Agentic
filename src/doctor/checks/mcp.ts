import { ToolAllowList } from '../../mcp/allowList.js';
import { loadMcpJson } from '../../mcp/client.js';
import type { ServerConfig } from '../../mcp/boundary/schemas.js';
import type { Check, CheckResult } from '../types.js';

/** Remote servers that authenticate through a browser OAuth consent (mcp-remote / http). */
export function needsOAuth(cfg: ServerConfig): boolean {
  return 'url' in cfg || cfg.args.some((a) => a === 'mcp-remote' || a.startsWith('mcp-remote@'));
}

function remoteUrl(cfg: ServerConfig): string | undefined {
  if ('url' in cfg) return cfg.url;
  return cfg.args.find((a) => /^https?:\/\//.test(a));
}

export const mcpCheck: Check = async (ctx) => {
  let servers: Record<string, ServerConfig>;
  try {
    servers = (await loadMcpJson(ctx.paths.root)).mcpServers;
  } catch (err) {
    return {
      id: 'mcp',
      title: 'MCP servers',
      status: 'red',
      summary: err instanceof Error ? err.message : String(err),
      fix: 'Copy-Item .mcp.example.json .mcp.json',
    };
  }
  if (!ctx.config['mcp-tools'].ok) {
    return { id: 'mcp', title: 'MCP servers', status: 'red', summary: 'config/mcp-tools.yaml invalid' };
  }
  const allow = new ToolAllowList(ctx.config['mcp-tools'].value);
  const results: CheckResult[] = [];

  const probe: Record<string, ServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const base = { id: `mcp:${name}`, title: `MCP ${name}` };
    const url = remoteUrl(cfg);
    const deprecated = url && /\/v1\/mcp\b/.test(url);
    const notes = deprecated ? [`endpoint ${url} is deprecated (removed 2027-03-01)`] : [];
    if (ctx.options.offline) {
      results.push({ ...base, status: 'yellow', summary: 'skipped (--offline)', details: notes });
    } else if (needsOAuth(cfg) && !ctx.options.includeOAuth) {
      results.push({
        ...base,
        status: 'yellow',
        summary: 'remote server with browser OAuth — not probed (would open a consent page)',
        details: [
          ...notes,
          `allow-list: ${allow.placeholders(name).length ? 'has placeholders' : 'classified'}`,
          'JIRA REST fallback is checked separately',
        ],
        fix: deprecated
          ? 'in .mcp.json change the URL to https://mcp.atlassian.com/v2/mcp, then run: pnpm qa doctor --include-oauth'
          : 'pnpm qa doctor --include-oauth',
      });
    } else {
      probe[name] = cfg;
    }
  }

  if (Object.keys(probe).length) {
    const hub = ctx.deps.mcpHub(probe);
    try {
      await Promise.all(
        Object.keys(probe).map(async (name) => {
          const base = { id: `mcp:${name}`, title: `MCP ${name}` };
          const h = await hub.health(name);
          if (!h.ok) {
            results.push({
              ...base,
              status: 'red',
              summary: `not reachable (${h.kind ?? 'error'}): ${h.error ?? ''}`.trim(),
              fix: 'check the command in .mcp.json and that npx can download the server; fallback chain applies at runtime',
            });
            return;
          }
          const unclassified = allow.unclassified(name, h.tools);
          const stale = allow.stale(name, h.tools);
          const placeholders = allow.placeholders(name);
          const exposed = h.tools.filter((t) => allow.isAllowed(name, t)).length;
          const blocked = h.tools.filter((t) => allow.classify(name, t) === 'blocked').length;
          const details = [
            `${h.tools.length} tools offered: ${exposed} allowed (observe/mutate), ${blocked} blocked`,
            ...(unclassified.length ? [`unclassified (refused until classified): ${unclassified.join(', ')}`] : []),
            ...(stale.length ? [`allow-list names not offered by the server: ${stale.join(', ')}`] : []),
            ...(placeholders.length ? [`placeholders in allow-list: ${placeholders.length}`] : []),
          ];
          const warn = unclassified.length > 0 || stale.length > 0 || placeholders.length > 0;
          results.push({
            ...base,
            status: warn ? 'yellow' : 'green',
            summary: `connected in ${h.durationMs} ms`,
            details,
            ...(warn ? { fix: 'classify the listed tools in config/mcp-tools.yaml (pnpm qa mcp tools)' } : {}),
          });
        }),
      );
    } finally {
      await hub.close();
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
};
