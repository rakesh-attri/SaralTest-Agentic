import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  CONFIG_NAMES,
  findPlaceholders,
  loadAllConfig,
  loadConfigFile,
  projectPaths,
  requireConfig,
} from './loader.js';
import { ISSUE_KINDS } from '../core/schemas/issue.js';

const repo = projectPaths(join(import.meta.dirname, '..', '..'));

/** Temp project (with a space in the path, rule 11) seeded from the repo's example configs. */
async function tempProject(): Promise<{ root: string; configDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qa cfg '));
  const configDir = join(root, 'config');
  await mkdir(configDir);
  for (const n of CONFIG_NAMES) {
    const tracked = n === 'policy' || n === 'mcp-tools';
    const src = join(repo.configDir, tracked ? `${n}.yaml` : `${n}.example.yaml`);
    await writeFile(join(configDir, `${n}.yaml`), await readFile(src, 'utf8'));
  }
  return { root, configDir };
}

async function patchYaml(dir: string, name: string, mutate: (doc: Record<string, unknown>) => void): Promise<void> {
  const file = join(dir, `${name}.yaml`);
  const doc = parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  await writeFile(file, stringify(doc));
}

describe('config loaders', () => {
  let p: { root: string; configDir: string };
  beforeEach(async () => {
    p = await tempProject();
  });
  afterEach(async () => {
    await rm(p.root, { recursive: true, force: true });
  });

  it('loads every example/tracked config file', async () => {
    const all = await loadAllConfig(p);
    for (const n of CONFIG_NAMES) {
      const r = all[n];
      expect(r.ok, `${n}: ${r.ok ? '' : r.errors.join('; ')}`).toBe(true);
    }
  });

  it('reports <placeholders> as unconfigured instead of crashing', async () => {
    const r = await loadConfigFile('models', p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.unconfigured).toContain('roles.reasoning.model');
  });

  it('rejects judge == coder (rule 8)', async () => {
    await patchYaml(p.configDir, 'models', (d) => {
      const roles = d['roles'] as Record<string, Record<string, unknown>>;
      roles['judge'] = { ...roles['coder'] };
    });
    const r = await loadConfigFile('models', p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/judge must use a different model/);
  });

  it('requires a policy entry for every IssueKind', async () => {
    await patchYaml(p.configDir, 'policy', (d) => {
      delete (d['issues'] as Record<string, unknown>)['LOCATOR'];
    });
    const r = await loadConfigFile('policy', p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/LOCATOR/);
  });

  it('repo policy.yaml covers all IssueKinds', async () => {
    const policy = await requireConfig('policy', repo);
    for (const k of ISSUE_KINDS) expect(policy.issues[k]).toBeDefined();
    expect(policy.issues['HARD_STOP']).toEqual(['halt']);
  });

  it('refuses healing.allowAssertionChanges: true (rule 7)', async () => {
    await patchYaml(p.configDir, 'policy', (d) => {
      (d['healing'] as Record<string, unknown>)['allowAssertionChanges'] = true;
    });
    const r = await loadConfigFile('policy', p);
    expect(r.ok).toBe(false);
  });

  it('rejects non 18-char org IDs and unknown profiles', async () => {
    await patchYaml(p.configDir, 'orgs', (d) => {
      const orgs = d['orgs'] as Record<string, unknown>[];
      orgs[1]!['orgId'] = '00D123';
      orgs[2]!['profile'] = 'yolo';
    });
    const r = await loadConfigFile('orgs', p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join()).toMatch(/18-character/);
      expect(r.errors.join()).toMatch(/orgs\.2\.profile/);
    }
  });

  it('rejects screenshots in traces (rule 17)', async () => {
    await patchYaml(p.configDir, 'observability', (d) => {
      d['includeScreenshots'] = true;
    });
    expect((await loadConfigFile('observability', p)).ok).toBe(false);
  });

  it('rejects a tool listed in two classes', async () => {
    await patchYaml(p.configDir, 'mcp-tools', (d) => {
      const pw = d['playwright'] as Record<string, string[]>;
      pw['mutate']!.push('browser_snapshot');
    });
    const r = await loadConfigFile('mcp-tools', p);
    expect(r.ok).toBe(false);
  });

  it('missing file → fix suggests copying the example', async () => {
    await rm(join(p.configDir, 'models.yaml'));
    await writeFile(join(p.configDir, 'models.example.yaml'), 'x: 1');
    const r = await loadConfigFile('models', p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('missing');
      expect(r.fix).toMatch(/Copy-Item/);
    }
  });

  it('YAML syntax errors are reported, not thrown', async () => {
    await writeFile(join(p.configDir, 'execution.yaml'), 'browser: [unclosed');
    const r = await loadConfigFile('execution', p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('parse');
  });

  it('requireConfig throws a readable ConfigError', async () => {
    await writeFile(join(p.configDir, 'execution.yaml'), 'browser: firefox');
    await expect(requireConfig('execution', p)).rejects.toThrow(/execution\.yaml.*browser/);
  });
});

describe('findPlaceholders', () => {
  it('finds nested placeholders', () => {
    expect(findPlaceholders({ a: { b: '<x>' }, c: ['ok', '<y>'], d: 3 })).toEqual(['a.b', 'c[1]']);
  });
});
