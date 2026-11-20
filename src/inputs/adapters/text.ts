import { basename, extname } from 'node:path';
import type { SourceDocument, SourceRef } from '../../core/schemas/index.js';
import { normalizeText, sectionize, sha256, type SectionizeOptions } from '../sections.js';

/** First markdown heading, `**Summary:** …` label, or first non-empty line. */
export function guessTitle(text: string, fallback: string): string {
  const summary = /^\s*\*\*Summary:?\*\*:?\s*(.+)$/im.exec(text)?.[1];
  if (summary) return summary.trim();
  const heading = /^\s{0,3}#{1,6}\s+(.+)$/m.exec(text)?.[1];
  if (heading) return heading.replace(/\*\*/g, '').trim();
  const first = text.split(/\r?\n/).find((l) => l.trim());
  return (first ?? fallback).replace(/\*\*/g, '').trim().slice(0, 120) || fallback;
}

/** `Document ID: XYZ-1`, `Version 1.2` — conventional document headers, if present. */
export function documentHeader(text: string): { docId?: string; version?: string } {
  const docId = /\bDocument\s+ID\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{1,40})/i.exec(text)?.[1];
  const version = /\bVersion\s*:?\s*v?(\d+(?:\.\d+){0,3})\b/i.exec(text)?.[1];
  return { ...(docId ? { docId } : {}), ...(version ? { version } : {}) };
}

/** Stem of a file name, safe as a doc id prefix. */
export const fileDocId = (path: string): string =>
  basename(path, extname(path))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 60) || 'doc';

export interface TextDocInput {
  text: string;
  sourceType: SourceRef['type'];
  ref: string;
  docId?: string;
  title?: string;
  version?: string;
  meta?: Record<string, unknown>;
  warnings?: string[];
  sectionize?: SectionizeOptions;
}

/** Plain text / markdown / extracted PDF or DOCX text → SourceDocument. */
export function textDocument(input: TextDocInput): SourceDocument {
  const text = normalizeText(input.text);
  const header = documentHeader(text);
  const version = input.version ?? header.version;
  return {
    docId: input.docId ?? header.docId ?? fileDocId(input.ref),
    source: {
      type: input.sourceType,
      ref: input.ref,
      hash: sha256(text),
      ...(version ? { version } : {}),
    },
    title: input.title ?? guessTitle(text, input.ref),
    meta: input.meta ?? {},
    sections: sectionize(text, input.sectionize),
    text,
    warnings: input.warnings ?? [],
  };
}
