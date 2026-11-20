import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { QAError } from '../core/errors.js';

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
  references: string[];
}

const Frontmatter = z.looseObject({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(10),
});

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseSkillFile(text: string, where: string): { meta: z.infer<typeof Frontmatter>; body: string } {
  const m = FM.exec(text);
  if (!m?.[1]) throw new Error(`${where}: missing YAML frontmatter`);
  const parsed = Frontmatter.safeParse(parseYaml(m[1]));
  if (!parsed.success) {
    throw new Error(`${where}: invalid frontmatter (${parsed.error.issues.map((i) => i.message).join('; ')})`);
  }
  return { meta: parsed.data, body: text.slice(m[0].length).trim() };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

/**
 * Loads skills from `.claude/skills/` (CLAUDE.md rule 9). Agents get only the *descriptions* in their system prompt
 * (`describe()`) and pull bodies on demand through the `load_skill` tool.
 */
export class SkillLoader {
  private cache: Map<string, SkillMeta> | undefined;
  readonly root: string;

  constructor(skillsDir: string) {
    this.root = resolve(skillsDir);
  }

  static forProject(projectRoot: string): SkillLoader {
    return new SkillLoader(join(projectRoot, '.claude', 'skills'));
  }

  private async index(): Promise<Map<string, SkillMeta>> {
    if (this.cache) return this.cache;
    const map = new Map<string, SkillMeta>();
    const entries = await readdir(this.root, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(this.root, e.name);
      let text: string;
      try {
        text = await readFile(join(dir, 'SKILL.md'), 'utf8');
      } catch {
        continue; // not a skill folder
      }
      const { meta } = parseSkillFile(text, join(e.name, 'SKILL.md'));
      if (meta.name !== e.name) throw new Error(`skill folder ${e.name} declares name ${meta.name}`);
      let references: string[] = [];
      try {
        references = (await readdir(join(dir, 'references'))).filter((f) => f.endsWith('.md')).sort();
      } catch {
        // no references folder
      }
      map.set(meta.name, {
        name: meta.name,
        description: meta.description.replace(/\s+/g, ' ').trim(),
        dir,
        references,
      });
    }
    this.cache = map;
    return map;
  }

  async list(): Promise<SkillMeta[]> {
    return [...(await this.index()).values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async meta(name: string): Promise<SkillMeta> {
    const m = (await this.index()).get(name);
    if (!m) throw new QAError('UNKNOWN', `unknown skill "${name}"`, { skill: name });
    return m;
  }

  /** Full SKILL.md body (without frontmatter). */
  async load(name: string): Promise<string> {
    const m = await this.meta(name);
    return parseSkillFile(await readFile(join(m.dir, 'SKILL.md'), 'utf8'), name).body;
  }

  /** A file from the skill's `references/` folder. Path traversal and symlink escapes are refused. */
  async reference(name: string, file: string): Promise<string> {
    const m = await this.meta(name);
    const refDir = join(m.dir, 'references');
    const target = resolve(refDir, file);
    if (!isInside(refDir, target)) throw new QAError('UNKNOWN', `reference path not allowed: ${file}`);
    const real = await realpath(target).catch(() => {
      throw new QAError('UNKNOWN', `reference not found: ${name}/${file}`);
    });
    if (!isInside(await realpath(refDir), real)) throw new QAError('UNKNOWN', `reference path not allowed: ${file}`);
    return readFile(real, 'utf8');
  }

  /** System-prompt block: names + descriptions only. */
  async describe(only?: readonly string[]): Promise<string> {
    const all = await this.list();
    const chosen = only ? all.filter((s) => only.includes(s.name)) : all;
    return [
      'Skills available (call load_skill with a name to read one in full before relying on it):',
      ...chosen.map((s) => `- ${s.name}: ${s.description}`),
    ].join('\n');
  }

  /** The `load_skill` tool agents receive. */
  loadSkillTool(only?: readonly string[]): StructuredToolInterface {
    return tool(
      async ({ name, reference }: { name: string; reference?: string | undefined }) => {
        if (only && !only.includes(name)) return `Skill "${name}" is not available to this agent.`;
        try {
          return reference ? await this.reference(name, reference) : await this.load(name);
        } catch (err) {
          return `Could not load skill: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      {
        name: 'load_skill',
        description: 'Load the full text of a skill (or one of its reference files) by name.',
        schema: z.object({
          name: z.string().describe('skill name, e.g. salesforce-lightning-locators'),
          reference: z.string().optional().describe('optional file in the skill references/ folder'),
        }),
      },
    );
  }
}
