import type { SourceDocument, SourceRef, SourceSection } from '../../core/schemas/index.js';

/**
 * Section references across several source documents. Qualified form `DOC#SECTION` is what the model sees and must
 * cite; an unqualified `SECTION` is accepted when it is unique across all documents (people write `AC3`, `BR-04`).
 */
export class RefIndex {
  private readonly qualified = new Map<string, { doc: SourceDocument; section: SourceSection }>();
  private readonly bySection = new Map<string, string[]>();

  constructor(readonly docs: readonly SourceDocument[]) {
    for (const doc of docs) {
      for (const section of doc.sections) {
        const q = `${doc.docId}#${section.ref}`;
        this.qualified.set(q.toUpperCase(), { doc, section });
        const list = this.bySection.get(section.ref.toUpperCase()) ?? [];
        list.push(q);
        this.bySection.set(section.ref.toUpperCase(), list);
      }
    }
  }

  /** Canonical qualified ref, or undefined when it does not exist / is ambiguous. */
  resolve(ref: string): string | undefined {
    const r = ref.trim().replace(/^\[|\]$/g, '');
    const hit = this.qualified.get(r.toUpperCase());
    if (hit) return `${hit.doc.docId}#${hit.section.ref}`;
    const unq = this.bySection.get(r.toUpperCase());
    if (unq?.length === 1) return unq[0];
    // `AC 3`, `AC-3` → `AC3`
    const ac = /^AC[\s#-]*(\d+)$/i.exec(r);
    if (ac) {
      const list = this.bySection.get(`AC${ac[1] ?? ''}`);
      if (list?.length === 1) return list[0];
    }
    return undefined;
  }

  get(qualifiedRef: string): { doc: SourceDocument; section: SourceSection } | undefined {
    return this.qualified.get(qualifiedRef.toUpperCase());
  }

  /** Human form: the bare section when unique, else qualified. */
  display(qualifiedRef: string): string {
    const hit = this.get(qualifiedRef);
    if (!hit) return qualifiedRef;
    return (this.bySection.get(hit.section.ref.toUpperCase())?.length ?? 0) > 1 ? qualifiedRef : hit.section.ref;
  }

  /** SourceRef for a requirement / finding citing this section (document hash + version + section). */
  sourceRef(qualifiedRef: string): SourceRef | undefined {
    const hit = this.get(qualifiedRef);
    if (!hit) return undefined;
    return { ...hit.doc.source, section: hit.section.ref };
  }

  all(): string[] {
    return [...this.qualified.values()].map((v) => `${v.doc.docId}#${v.section.ref}`);
  }
}

/** Render sources for a prompt: one line per section with its qualified ref. */
export function renderSources(docs: readonly SourceDocument[], opts: { skipTests?: boolean } = {}): string {
  return docs
    .filter((d) => !(opts.skipTests && d.meta['format'] === 'manual-tests'))
    .map((d) => {
      const head = `=== SOURCE ${d.docId} (${d.source.type}${d.source.version ? `, version ${d.source.version}` : ''}) — ${d.title} ===`;
      const body = d.sections
        .map((s) => `[${d.docId}#${s.ref}] (${s.kind}${s.heading ? `; under "${s.heading}"` : ''})\n${s.text}`)
        .join('\n\n');
      return `${head}\n${body}`;
    })
    .join('\n\n');
}
