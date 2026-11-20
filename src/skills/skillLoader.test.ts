import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkillLoader, parseSkillFile } from './skillLoader.js';

const repoRoot = join(import.meta.dirname, '..', '..');

const PLAN_SKILLS = [
  'qa-lead-playbook',
  'requirement-analysis',
  'salesforce-platform',
  'salesforce-lightning-locators',
  'salesforce-auth-personas',
  'salesforce-test-data',
  'salesforce-api-testing',
  'test-design',
  'exploratory-testing',
  'visual-testing',
  'safety-and-approvals',
  'playwright-standards',
  'defect-investigation',
  'reporting',
  'verified-learning',
];

describe('SkillLoader on the real .claude/skills', () => {
  const loader = SkillLoader.forProject(repoRoot);

  it('parses every skill (15 from PLAN.md §6 + vendored langfuse)', async () => {
    const names = (await loader.list()).map((s) => s.name);
    for (const s of PLAN_SKILLS) expect(names).toContain(s);
    expect(names).toContain('langfuse');
    expect(names).toHaveLength(16);
  });

  it('descriptions are single-line and folded YAML is handled', async () => {
    const langfuse = (await loader.list()).find((s) => s.name === 'langfuse');
    expect(langfuse?.description).not.toMatch(/\n/);
    expect(langfuse?.description.length).toBeGreaterThan(20);
    expect(langfuse?.references).toContain('instrumentation.md');
  });

  it('load returns the body without frontmatter', async () => {
    const body = await loader.load('safety-and-approvals');
    expect(body.startsWith('# Safety and approvals')).toBe(true);
    expect(body).not.toMatch(/^---/);
  });

  it('describe() gives names+descriptions only, optionally filtered', async () => {
    const d = await loader.describe(['test-design', 'reporting']);
    expect(d).toMatch(/- test-design: /);
    expect(d).toMatch(/- reporting: /);
    expect(d).not.toMatch(/safety-and-approvals/);
  });

  it('reference() reads references and blocks traversal', async () => {
    expect(await loader.reference('langfuse', 'instrumentation.md')).toMatch(/Instrument/);
    await expect(loader.reference('langfuse', '../SKILL.md')).rejects.toThrow(/not allowed/);
    await expect(loader.reference('langfuse', '..\\..\\safety-and-approvals\\SKILL.md')).rejects.toThrow(/not allowed/);
    await expect(loader.reference('langfuse', join(repoRoot, 'CLAUDE.md'))).rejects.toThrow(/not allowed/);
    await expect(loader.reference('langfuse', 'missing.md')).rejects.toThrow(/not found/);
  });

  it('unknown skill names are refused', async () => {
    await expect(loader.load('../../CLAUDE')).rejects.toThrow(/unknown skill/);
  });

  it('load_skill tool returns skill text and respects the per-agent allow list', async () => {
    const t = loader.loadSkillTool(['test-design']);
    expect(t.name).toBe('load_skill');
    const ok: unknown = await t.invoke({ name: 'test-design' });
    expect(String(ok)).toMatch(/test/i);
    const denied: unknown = await t.invoke({ name: 'safety-and-approvals' });
    expect(String(denied)).toMatch(/not available/);
  });
});

describe('SkillLoader validation', () => {
  it('rejects a folder whose name differs from frontmatter name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa skills '));
    await mkdir(join(root, 'foo'));
    await writeFile(join(root, 'foo', 'SKILL.md'), '---\nname: bar\ndescription: a description here\n---\n# x');
    await expect(new SkillLoader(root).list()).rejects.toThrow(/declares name bar/);
    await rm(root, { recursive: true, force: true });
  });

  it('parseSkillFile requires frontmatter', () => {
    expect(() => parseSkillFile('# no frontmatter', 'x')).toThrow(/frontmatter/);
    expect(parseSkillFile('---\r\nname: a-b\r\ndescription: long enough text\r\n---\r\nbody', 'x').body).toBe('body');
  });
});
