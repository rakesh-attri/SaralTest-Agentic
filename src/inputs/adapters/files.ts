import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { AstBuilder, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, type Feature, type Scenario } from '@cucumber/messages';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { QAError } from '../../core/errors.js';
import type { SourceDocument, SourceSection } from '../../core/schemas/index.js';
import { normalizeText, sha256 } from '../sections.js';
import { fileDocId, textDocument } from './text.js';

/** A corrupt or unreadable input is a DATA issue: QA Lead skips that input (degrade) and the run continues. */
function unreadable(path: string, what: string, err: unknown): QAError {
  const msg = err instanceof Error ? err.message : String(err);
  return new QAError('DATA', `cannot read ${what} ${basename(path)}: ${msg.slice(0, 200)}`, { path, format: what });
}

// ------------------------------------------------------------------ markdown / text
export async function readTextFile(path: string, sourceType: 'file' | 'chat' = 'file'): Promise<SourceDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw unreadable(path, 'text file', err);
  }
  return textDocument({ text, sourceType, ref: path });
}

// ------------------------------------------------------------------ PDF
/** Page markers pdf-parse inserts (`-- 1 of 2 --`) are layout, not content. */
const PAGE_MARKER = /^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm;

export async function readPdf(path: string): Promise<SourceDocument> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    throw unreadable(path, 'PDF', err);
  }
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    const result = await parser.getText();
    const info = await parser.getInfo().catch(() => undefined);
    const text = result.text.replace(PAGE_MARKER, '');
    const warnings: string[] = [];
    if (normalizeText(text).length < 20) {
      warnings.push('PDF has almost no extractable text (scanned image?). OCR is not supported; review manually.');
    }
    const meta: Record<string, unknown> = { pages: result.total, format: 'pdf' };
    const infoBag: unknown = info?.info;
    const author: unknown =
      infoBag && typeof infoBag === 'object' && 'Author' in infoBag
        ? (infoBag).Author
        : undefined;
    if (typeof author === 'string' && author) meta['author'] = author;
    // The hash covers the file bytes: a re-export with identical text is still a new version of the source.
    const doc = textDocument({ text, sourceType: 'file', ref: path, meta, warnings });
    return { ...doc, source: { ...doc.source, hash: sha256(data) } };
  } catch (err) {
    if (err instanceof QAError) throw err;
    throw unreadable(path, 'PDF', err);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

// ------------------------------------------------------------------ DOCX
/** Minimal HTML → markdown-ish text: headings, paragraphs, list items, table rows. Enough for sectionize(). */
export function htmlToText(html: string): string {
  const decode = (s: string): string =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  return decode(
    html
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${t}\n`)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(?:td|th)>\s*<(?:td|th)[^>]*>/gi, ' | ')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  );
}

export async function readDocx(path: string): Promise<SourceDocument> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    throw unreadable(path, 'DOCX', err);
  }
  try {
    // externalFileAccess: false — a document must not make us read other local files.
    const out = await mammoth.convertToHtml({ buffer: data }, { externalFileAccess: false });
    const warnings = out.messages.filter((m) => m.type === 'error').map((m) => m.message);
    const doc = textDocument({
      text: htmlToText(out.value),
      sourceType: 'file',
      ref: path,
      meta: { format: 'docx' },
      warnings,
    });
    return { ...doc, source: { ...doc.source, hash: sha256(data) } };
  } catch (err) {
    throw unreadable(path, 'DOCX', err);
  }
}

// ------------------------------------------------------------------ Gherkin
export function parseGherkin(text: string, ref: string): SourceDocument {
  const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
  let feature: Feature | undefined;
  try {
    feature = parser.parse(text).feature;
  } catch (err) {
    throw unreadable(ref, 'Gherkin feature', err);
  }
  if (!feature) throw new QAError('DATA', `no Feature in ${basename(ref)}`, { path: ref });
  const sections: SourceSection[] = [];
  if (feature.description.trim()) {
    sections.push({ ref: 'S1', kind: 'description', heading: feature.name, text: feature.description.trim() });
  }
  let scenarioNo = 0;
  let ruleNo = 0;
  const addScenario = (sc: Scenario, rule?: string): void => {
    scenarioNo += 1;
    // A tag like @AC3 or @BR-02 names the requirement the scenario covers; it becomes the ref when unique.
    const tagRef = sc.tags.map((t) => t.name.slice(1)).find((t) => /^(?:AC\d+|[A-Z][A-Z0-9]{0,7}-\d+)$/.test(t));
    const steps = sc.steps.map((s) => `${s.keyword.trim()} ${s.text}`);
    const examples = sc.examples.flatMap((ex) =>
      [ex.tableHeader, ...ex.tableBody]
        .filter((r) => r !== undefined)
        .map((r) => `| ${r.cells.map((c) => c.value).join(' | ')} |`),
    );
    const ref = tagRef && !sections.some((s) => s.ref === tagRef) ? tagRef : `SC${scenarioNo}`;
    sections.push({
      ref,
      kind: 'scenario',
      heading: rule ?? feature.name,
      text: [`${sc.keyword}: ${sc.name}`, ...steps, ...(examples.length ? ['Examples:', ...examples] : [])].join('\n'),
    });
  };
  for (const child of feature.children) {
    if (child.scenario) addScenario(child.scenario);
    if (child.rule) {
      ruleNo += 1;
      const r = child.rule;
      sections.push({
        ref: `RULE${ruleNo}`,
        kind: 'rule',
        heading: feature.name,
        text: `${r.name}\n${r.description}`.trim(),
      });
      for (const rc of r.children) if (rc.scenario) addScenario(rc.scenario, r.name);
    }
    if (child.background) {
      sections.push({
        ref: 'BACKGROUND',
        kind: 'text',
        heading: feature.name,
        text: child.background.steps.map((s) => `${s.keyword.trim()} ${s.text}`).join('\n'),
      });
    }
  }
  const norm = normalizeText(text);
  return {
    docId: fileDocId(ref),
    source: { type: 'file', ref, hash: sha256(norm) },
    title: feature.name || fileDocId(ref),
    meta: { format: 'gherkin', tags: feature.tags.map((t) => t.name) },
    sections,
    text: norm,
    warnings: [],
  };
}

// ------------------------------------------------------------------ JSON / YAML
const Item = z.union([z.string(), z.looseObject({ id: z.string().optional(), text: z.string() })]);
/** A structured spec. Unknown shapes fall back to text sectionizing of the pretty-printed content. */
export const StructuredSpec = z.looseObject({
  key: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  version: z.union([z.string(), z.number()]).optional(),
  acceptanceCriteria: z.array(Item).optional(),
  rules: z.array(Item).optional(),
  businessRules: z.array(Item).optional(),
  nonFunctional: z.array(Item).optional(),
  assumptions: z.array(Item).optional(),
  personas: z.array(Item).optional(),
  outOfScope: z.array(Item).optional(),
});

export function parseStructured(text: string, ref: string): SourceDocument {
  let data: unknown;
  try {
    data = extname(ref).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw unreadable(ref, 'JSON/YAML spec', err);
  }
  const spec = StructuredSpec.safeParse(data);
  const known =
    spec.success &&
    ['acceptanceCriteria', 'rules', 'businessRules', 'nonFunctional', 'assumptions'].some((k) => k in spec.data);
  if (!spec.success || !known) {
    // Not a recognised spec shape: keep everything as text so nothing is lost; the analyst still cites S-refs.
    return textDocument({
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      sourceType: 'file',
      ref,
    });
  }
  const s = spec.data;
  const sections: SourceSection[] = [];
  const add = (
    items: z.infer<typeof Item>[] | undefined,
    kind: SourceSection['kind'],
    prefix: string,
    heading: string,
  ): void => {
    (items ?? []).forEach((it, i) => {
      const id = typeof it === 'string' ? undefined : it.id;
      const body = typeof it === 'string' ? it : it.text;
      sections.push({ ref: id ?? `${prefix}${i + 1}`, kind, heading, text: body });
    });
  };
  if (s.description) sections.push({ ref: 'S1', kind: 'description', text: s.description });
  add(s.acceptanceCriteria, 'ac', 'AC', 'Acceptance criteria');
  add([...(s.rules ?? []), ...(s.businessRules ?? [])], 'rule', 'R', 'Business rules');
  add(s.nonFunctional, 'nfr', 'NFR', 'Non-functional');
  add(s.assumptions, 'assumption', 'A', 'Assumptions');
  add(s.personas, 'persona', 'P', 'Personas');
  add(s.outOfScope, 'out-of-scope', 'OOS', 'Out of scope');
  const norm = normalizeText(text);
  const version = s.version !== undefined ? String(s.version) : undefined;
  return {
    docId: s.key ?? s.id ?? fileDocId(ref),
    source: { type: 'file', ref, hash: sha256(norm), ...(version ? { version } : {}) },
    title: s.title ?? s.summary ?? fileDocId(ref),
    meta: { format: extname(ref).slice(1).toLowerCase() },
    sections,
    text: norm,
    warnings: [],
  };
}

export async function readGherkin(path: string): Promise<SourceDocument> {
  try {
    return parseGherkin(await readFile(path, 'utf8'), path);
  } catch (err) {
    if (err instanceof QAError) throw err;
    throw unreadable(path, 'Gherkin feature', err);
  }
}

export async function readStructured(path: string): Promise<SourceDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw unreadable(path, 'JSON/YAML spec', err);
  }
  return parseStructured(text, path);
}
