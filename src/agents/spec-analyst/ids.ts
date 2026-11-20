import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Stable requirement ids (`<KEY>-R03`) across re-runs. A requirement's fingerprint is its sorted cited sections +
 * type; the same fingerprint gets the same id next time, new ones get the next free number. Stored in
 * `.qa-memory/requirements/<KEY>.json` (git-ignored memory).
 */
const Store = z.object({
  key: z.string(),
  next: z.number().int().positive(),
  ids: z.record(z.string(), z.string()),
});

export function idPrefix(raw: string): string {
  const p = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return p || 'REQ';
}

export class RequirementIdStore {
  private data: z.infer<typeof Store>;
  private readonly file: string | undefined;

  /** `memoryDir` undefined → in-memory only (tests, dry runs). */
  constructor(
    readonly key: string,
    memoryDir?: string,
  ) {
    this.file = memoryDir ? join(memoryDir, 'requirements', `${idPrefix(key)}.json`) : undefined;
    let loaded: z.infer<typeof Store> | undefined;
    if (this.file && existsSync(this.file)) {
      const parsed = Store.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) loaded = parsed.data;
    }
    this.data = loaded ?? { key, next: 1, ids: {} };
  }

  static fingerprint(sections: readonly string[], type: string, ordinal = 0): string {
    return `${[...sections]
      .map((s) => s.toUpperCase())
      .sort()
      .join('|')}::${type}${ordinal ? `::${ordinal}` : ''}`;
  }

  /** Assign ids for a batch; duplicates of one fingerprint inside the batch get ordinals. */
  assign(items: readonly { sections: readonly string[]; type: string }[]): string[] {
    const seen = new Map<string, number>();
    return items.map((it) => {
      const base = RequirementIdStore.fingerprint(it.sections, it.type);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const fp = n ? RequirementIdStore.fingerprint(it.sections, it.type, n) : base;
      let id = this.data.ids[fp];
      if (!id) {
        id = `${idPrefix(this.key)}-R${String(this.data.next).padStart(2, '0')}`;
        this.data.next += 1;
        this.data.ids[fp] = id;
      }
      return id;
    });
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
