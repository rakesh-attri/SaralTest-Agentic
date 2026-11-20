import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import ExcelJS from 'exceljs';
import { QAError } from '../../core/errors.js';
import type { ManualTestCase, SourceDocument, SourceRef } from '../../core/schemas/index.js';
import { findRefs, sha256 } from '../sections.js';
import { fileDocId } from './text.js';

/**
 * Existing / manual test cases from xlsx or csv (PLAN.md §7a → RTM as existing cases). Columns are matched by header
 * aliases, so sheets from different teams import without a mapping file. Unknown columns are ignored and reported.
 */
const ALIASES: Record<keyof Columns, string[]> = {
  id: ['test id', 'test case id', 'tc id', 'id', 'key', 'test key', 'case id'],
  title: ['title', 'test case', 'name', 'summary', 'test name', 'test title'],
  refs: [
    'requirement ref',
    'requirement refs',
    'requirement',
    'requirements',
    'refs',
    'covers',
    'traceability',
    'ac',
    'story',
  ],
  persona: ['persona', 'role', 'user', 'profile', 'actor'],
  preconditions: ['preconditions', 'precondition', 'pre-conditions', 'setup', 'given'],
  steps: ['steps', 'test steps', 'step', 'actions', 'procedure'],
  expected: ['expected result', 'expected results', 'expected', 'expected outcome'],
  priority: ['priority', 'prio'],
  type: ['type', 'test type', 'category'],
  lastStatus: ['last run status', 'last result', 'status', 'result', 'execution status'],
  lastDate: ['last run date', 'last run', 'executed on', 'run date'],
};
interface Columns {
  id: number;
  title: number;
  refs: number;
  persona: number;
  preconditions: number;
  steps: number;
  expected: number;
  priority: number;
  type: number;
  lastStatus: number;
  lastDate: number;
}

const norm = (h: string): string => h.toLowerCase().replace(/[_*]/g, ' ').replace(/\s+/g, ' ').trim();

export function mapHeader(header: string[]): { columns: Partial<Columns>; unknown: string[] } {
  const columns: Partial<Columns> = {};
  const unknown: string[] = [];
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const key = (Object.keys(ALIASES) as (keyof Columns)[]).find(
      (k) => columns[k] === undefined && ALIASES[k].includes(n),
    );
    if (key) columns[key] = i;
    else unknown.push(h);
  });
  return { columns, unknown };
}

export function normalizePriority(v: string): ManualTestCase['priority'] {
  const t = v.trim().toUpperCase();
  if (/^P[0-3]$/.test(t)) return t as ManualTestCase['priority'];
  if (/^(CRITICAL|BLOCKER|HIGHEST)$/.test(t)) return 'P0';
  if (/^HIGH$/.test(t)) return 'P1';
  if (/^(MEDIUM|NORMAL)$/.test(t)) return 'P2';
  if (/^(LOW|LOWEST|MINOR)$/.test(t)) return 'P3';
  return undefined;
}

export function normalizeStatus(v: string): ManualTestCase['lastRun']['status'] {
  const t = v
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (!t || t === 'notrun' || t === 'notexecuted' || t === 'norun' || t === 'pending') return 'NOT_RUN';
  if (t === 'pass' || t === 'passed' || t === 'ok') return 'PASS';
  if (t === 'fail' || t === 'failed' || t === 'failure') return 'FAIL';
  if (t === 'blocked') return 'BLOCKED';
  return 'UNKNOWN';
}

/** One numbered step per line (`1. Open …`); numbering is stripped. */
export const splitSteps = (v: string): string[] =>
  v
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter(Boolean);

export interface ManualTestImport {
  tests: ManualTestCase[];
  /** One section per test (ref = test id) so findings can cite tests like any other source. */
  document: SourceDocument;
  notes: string[];
}

/** Rows (first = header) → test cases. */
export function rowsToTests(rows: string[][], source: SourceRef, sheetName: string): ManualTestImport {
  const notes: string[] = [];
  const headerIndex = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2);
  const header = rows[headerIndex] ?? [];
  const { columns, unknown } = mapHeader(header);
  if (columns.id === undefined || columns.title === undefined) {
    throw new QAError('DATA', `manual test sheet "${sheetName}" has no recognisable Test ID / Title columns`, {
      header,
    });
  }
  if (unknown.length) notes.push(`ignored columns: ${unknown.join(', ')}`);
  const cell = (r: string[], k: keyof Columns): string => {
    const i = columns[k];
    return i === undefined ? '' : (r[i] ?? '').trim();
  };
  const tests: ManualTestCase[] = [];
  const seen = new Set<string>();
  rows.slice(headerIndex + 1).forEach((r, i) => {
    const id = cell(r, 'id');
    if (!id) return;
    const rowNo = headerIndex + i + 2;
    if (seen.has(id)) {
      notes.push(`row ${rowNo}: duplicate Test ID ${id} skipped`);
      return;
    }
    seen.add(id);
    const priority = normalizePriority(cell(r, 'priority'));
    const lastDate = cell(r, 'lastDate');
    tests.push({
      id,
      title: cell(r, 'title'),
      requirementRefs: findRefs(cell(r, 'refs')),
      ...(cell(r, 'persona') ? { persona: cell(r, 'persona') } : {}),
      preconditions: cell(r, 'preconditions') ? [cell(r, 'preconditions')] : [],
      steps: splitSteps(cell(r, 'steps')),
      ...(cell(r, 'expected') ? { expected: cell(r, 'expected') } : {}),
      ...(priority ? { priority } : {}),
      ...(cell(r, 'type') ? { type: cell(r, 'type') } : {}),
      lastRun: { status: normalizeStatus(cell(r, 'lastStatus')), ...(lastDate ? { date: lastDate } : {}) },
      source: { ...source, section: id },
      row: rowNo,
    });
  });
  const text = tests
    .map(
      (t) =>
        `${t.id}: ${t.title}\nRefs: ${t.requirementRefs.join(', ') || '(none)'}\nPersona: ${t.persona ?? '-'}\nPreconditions: ${t.preconditions.join('; ') || '-'}\nSteps: ${t.steps.join(' / ')}\nExpected: ${t.expected ?? '-'}\nPriority: ${t.priority ?? '-'} Type: ${t.type ?? '-'} Last run: ${t.lastRun.status}${t.lastRun.date ? ` (${t.lastRun.date})` : ''}`,
    )
    .join('\n\n');
  const document: SourceDocument = {
    docId: fileDocId(source.ref),
    source,
    title: `Existing manual test cases (${sheetName})`,
    meta: { format: 'manual-tests', sheet: sheetName, count: tests.length },
    sections: tests.map((t) => ({
      ref: t.id,
      kind: 'test' as const,
      heading: 'Existing manual test cases',
      text: text.split('\n\n').find((b) => b.startsWith(`${t.id}:`)) ?? t.title,
    })),
    text,
    warnings: notes,
  };
  return { tests, document, notes };
}

/** RFC 4180 CSV (quoted fields, embedded newlines and quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i);
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function xlsxRows(data: Buffer): Promise<{ rows: string[][]; sheet: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  // The first sheet whose header row maps to a Test ID + Title (skips "Read Me" tabs).
  for (const ws of wb.worksheets) {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(r.getCell(c).text);
      rows.push(cells);
    });
    const header = rows.find((r) => r.filter((c) => c.trim()).length >= 2) ?? [];
    const { columns } = mapHeader(header);
    if (columns.id !== undefined && columns.title !== undefined) return { rows, sheet: ws.name };
  }
  throw new QAError('DATA', 'no worksheet with Test ID and Title columns found');
}

export async function readManualTests(path: string): Promise<ManualTestImport> {
  let data: Buffer;
  try {
    data = await readFile(path);
  } catch (err) {
    throw new QAError('DATA', `cannot read manual tests ${basename(path)}: ${String(err).slice(0, 200)}`, { path });
  }
  const source: SourceRef = { type: 'manual-test', ref: path, hash: sha256(data) };
  const ext = extname(path).toLowerCase();
  try {
    if (ext === '.csv') return rowsToTests(parseCsv(data.toString('utf8')), source, basename(path));
    const { rows, sheet } = await xlsxRows(data);
    return rowsToTests(rows, source, sheet);
  } catch (err) {
    if (err instanceof QAError) throw err;
    throw new QAError('DATA', `cannot parse manual tests ${basename(path)}: ${String(err).slice(0, 200)}`, { path });
  }
}
