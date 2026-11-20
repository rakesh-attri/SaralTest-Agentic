import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * A throw-away copy of the project skeleton in a folder WITH SPACES in its path (CLAUDE.md rule 11):
 * config (examples → real names), skills, offline fixture, package.json, optional .env and .mcp.json.
 */
export function makeTempProject(opts: { env?: Record<string, string>; mcp?: unknown } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'qa project with spaces '));
  const cfgDir = join(root, 'config');
  cpSync(join(REPO_ROOT, 'config'), cfgDir, {
    recursive: true,
    filter: (src) => !/[\\/]config[\\/][^\\/]+\.yaml$/.test(src) || /example|policy|mcp-tools/.test(src),
  });
  for (const name of ['models', 'personas', 'orgs', 'execution', 'observability']) {
    writeFileSync(join(cfgDir, `${name}.yaml`), readFileSync(join(REPO_ROOT, 'config', `${name}.example.yaml`)));
  }
  cpSync(join(REPO_ROOT, '.claude', 'skills'), join(root, '.claude', 'skills'), { recursive: true });
  cpSync(join(REPO_ROOT, 'examples', 'fixture'), join(root, 'examples', 'fixture'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'qa-temp', private: true }));
  writeFileSync(join(root, '.mcp.json'), JSON.stringify(opts.mcp ?? { mcpServers: {} }, null, 2));
  if (opts.env) {
    writeFileSync(
      join(root, '.env'),
      Object.entries(opts.env)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
  }
  return root;
}
