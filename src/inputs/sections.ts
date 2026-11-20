import { createHash } from 'node:crypto';
import type { SectionKind, SourceSection } from '../core/schemas/inputs.js';

/**
 * Generic, deterministic section detection for prose sources (md, txt, PDF text, DOCX text, JIRA descriptions).
 * It knows document *conventions* (acceptance-criteria numbering, `XX-nn` rule ids, headings, bold labels), never a
 * particular document. Every section gets a stable `ref` the Spec Analyst must cite (CLAUDE.md rule 12).
 */

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Normalize line endings, trailing spaces, non-breaking spaces and runs of blank lines. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** `AC1`, `AC 1`, `AC-1`, `AC#1`, `Acceptance criterion 1` → `AC1`. */
const AC_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?(?:AC|Acceptance\s+criteri(?:on|a))\s*[-#:]?\s*(\d{1,3})\b(?:\*\*)?\s*[:.–—-]?\s*/i;
/** `BR-03`, `NFR-01`, `A-02`, `REQ-12` at the start of a line or table row. */
const ID_LINE = /^\s*(?:[-*|]\s*)?(?:\*\*)?([A-Z][A-Z0-9]{0,7})-(\d{1,4})\b(?:\*\*)?\s*[:|.–—-]?\s*/;
/** Further ids inside one paragraph after a sentence end: `… quarter. A-03: …` */
const INLINE_ID_SPLIT = /(?<=[.;!?])\s+(?=[A-Z][A-Z0-9]{0,7}-\d{1,4}:\s)/g;

const MD_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;
/** `4. Business rules`, `2.1 Scope` — short numbered title lines. */
const NUM_HEADING = /^\s*(\d{1,2}(?:\.\d{1,2})*)\.?\s+([A-Z][^.:;]{1,70})$/;
/**
 * A numbered line is a heading only if it names a known section type or is a short title (≤ 3 words, no quotes),
 * so numbered steps such as `2. Leave the field empty` stay content.
 */
function numberedHeading(line: string): RegExpExecArray | null {
  const m = NUM_HEADING.exec(line);
  if (!m) return null;
  const title = m[2] ?? '';
  if (kindForHeading(title) !== 'text') return m;
  return title.split(/\s+/).length <= 3 && !/['"‘’“”]/.test(title) ? m : null;
}

/** `**Acceptance criteria**` alone, or `**Out of scope:** text`. */
const BOLD_LABEL = /^\s*\*\*([^*]{2,60}?):?\*\*:?\s*(.*)$/;

/** Mentions of requirement-like ids anywhere in a text (AC numbers normalized). */
export function findRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:AC|Acceptance\s+criteri(?:on|a))\s*[-#]?\s*(\d{1,3})\b/gi))
    out.add(`AC${m[1] ?? ''}`);
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9]{0,7})-(\d{1,4})\b/g)) {
    if (m[1] !== 'AC') out.add(`${m[1] ?? ''}-${m[2] ?? ''}`);
  }
  return [...out];
}

/** Map an id prefix to a section kind. Unknown prefixes are business rules by default. */
export function kindForPrefix(prefix: string): SectionKind {
  const p = prefix.toUpperCase();
  if (p === 'AC') return 'ac';
  if (p === 'NFR' || p === 'NF') return 'nfr';
  if (p === 'A' || p === 'ASM' || p === 'AS' || p === 'ASSUMP') return 'assumption';
  if (p === 'TC' || p === 'MTC' || p === 'T') return 'test';
  if (p === 'CM') return 'text'; // JIRA comments (adapter numbering)
  return 'rule';
}

/** Map a heading / label to a section kind for un-numbered text below it. */
export function kindForHeading(heading: string | undefined): SectionKind {
  const h = (heading ?? '').toLowerCase();
  if (/out[\s-]of[\s-]scope/.test(h)) return 'out-of-scope';
  if (/acceptance/.test(h)) return 'ac';
  if (/non[\s-]?functional/.test(h)) return 'nfr';
  if (/persona|actor|role|user type/.test(h)) return 'persona';
  if (/assumption/.test(h)) return 'assumption';
  if (/scope/.test(h)) return 'scope';
  if (/business rule|rules|requirement/.test(h)) return 'rule';
  if (/^summary$/.test(h.trim())) return 'summary';
  if (/description|purpose|overview|summary|background/.test(h)) return 'description';
  return 'text';
}

interface Draft {
  ref: string;
  kind: SectionKind;
  heading: string | undefined;
  lines: string[];
}

export interface SectionizeOptions {
  /** Prefix for generic text blocks (default `S`). */
  textPrefix?: string;
  /** Headings whose content should be dropped (e.g. version history). */
  skipHeadings?: RegExp;
}

/**
 * Split prose into sections:
 * - numbered acceptance criteria → `AC<n>` (kind `ac`)
 * - `XX-nn` ids at line start → that id (kind from the prefix: BR → rule, NFR → nfr, A → assumption …)
 * - other paragraphs → `S<n>` with the kind of the heading above them
 * Lines after an id line belong to it until the next id, heading or bold label (wrapped PDF table rows stay whole).
 */
export function sectionize(raw: string, opts: SectionizeOptions = {}): SourceSection[] {
  const textPrefix = opts.textPrefix ?? 'S';
  const lines = normalizeText(raw)
    .split('\n')
    .flatMap((l) => l.split(INLINE_ID_SPLIT));
  const drafts: Draft[] = [];
  let heading: string | undefined;
  let skipping = false;
  let current: Draft | undefined;
  let textCount = 0;
  let afterBlank = false;

  const close = (): void => {
    if (current && current.lines.join('').trim()) drafts.push(current);
    current = undefined;
  };
  const openText = (): Draft => {
    textCount += 1;
    return { ref: `${textPrefix}${textCount}`, kind: kindForHeading(heading), heading, lines: [] };
  };

  for (const line of lines) {
    const md = MD_HEADING.exec(line);
    const num = md ? null : numberedHeading(line);
    if (md || num) {
      close();
      heading = (md?.[1] ?? num?.[2] ?? '').replace(/\*\*/g, '').trim();
      skipping = opts.skipHeadings?.test(heading) ?? false;
      continue;
    }
    if (skipping) continue;

    const bold = BOLD_LABEL.exec(line);
    if (bold && !AC_LINE.test(line) && !ID_LINE.test(line.replace(/\*\*/g, ''))) {
      close();
      const label = (bold[1] ?? '').trim();
      const rest = (bold[2] ?? '').trim();
      if (rest) {
        // `**Label:** value` labels only its own line; the heading above stays in force.
        textCount += 1;
        current = { ref: `${textPrefix}${textCount}`, kind: kindForHeading(label), heading: label, lines: [rest] };
        close();
      } else {
        heading = label;
      }
      continue;
    }

    const ac = AC_LINE.exec(line);
    if (ac) {
      close();
      afterBlank = false;
      current = { ref: `AC${ac[1] ?? ''}`, kind: 'ac', heading, lines: [line.trim()] };
      continue;
    }
    const id = ID_LINE.exec(line);
    if (id) {
      close();
      afterBlank = false;
      const prefix = id[1] ?? '';
      current = { ref: `${prefix}-${id[2] ?? ''}`, kind: kindForPrefix(prefix), heading, lines: [line.trim()] };
      continue;
    }

    if (!line.trim()) {
      // A blank line ends a generic paragraph; an id/AC item may continue after it (Given/When/Then blocks).
      if (current && !isNumbered(current)) close();
      else if (current) afterBlank = true;
      continue;
    }
    if (current && isNumbered(current) && afterBlank && !CONTINUATION.test(line)) close();
    afterBlank = false;
    current ??= openText();
    current.lines.push(line.trim());
  }
  close();
  return dedupeRefs(drafts).map((d) => ({
    ref: d.ref,
    kind: d.kind,
    ...(d.heading ? { heading: d.heading } : {}),
    text: d.lines
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim(),
  }));
}

/** Lines that continue a numbered item after a blank line. */
const CONTINUATION = /^\s*(?:[Gg]iven|[Ww]hen|[Tt]hen|[Aa]nd|[Bb]ut|[-*•]|\d+[.)]\s|[a-z])/;

function isNumbered(d: Draft): boolean {
  return d.kind === 'ac' || /^[A-Z][A-Z0-9]{0,7}-\d+/.test(d.ref);
}

function dedupeRefs(drafts: Draft[]): Draft[] {
  const seen = new Map<string, number>();
  return drafts.map((d) => {
    const n = (seen.get(d.ref) ?? 0) + 1;
    seen.set(d.ref, n);
    return n === 1 ? d : { ...d, ref: `${d.ref}#${n}` };
  });
}
