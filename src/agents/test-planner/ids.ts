import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { idPrefix } from '../spec-analyst/ids.js';

/**
 * Stable test case ids (`TC-<KEY>-001`) across re-runs, like requirement ids. Fingerprint = the sorted obligation
 * fingerprints a case covers + persona (obligation ids themselves are positional). Stored in
 * `.qa-memory/testcases/<KEY>.json`.
 */
const Store = z.object({ key: z.string(), next: z.number().int().positive(), ids: z.record(z.string(), z.string()) });

export class TestCaseIdStore {
  private data: z.infer<typeof Store>;
  private readonly file: string | undefined;
  private readonly used = new Set<string>();

  constructor(
    readonly key: string,
    memoryDir?: string,
  ) {
    this.file = memoryDir ? join(memoryDir, 'testcases', `${idPrefix(key)}.json`) : undefined;
    let loaded: z.infer<typeof Store> | undefined;
    if (this.file && existsSync(this.file)) {
      const parsed = Store.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (parsed.success) loaded = parsed.data;
    }
    this.data = loaded ?? { key, next: 1, ids: {} };
  }

  /** Id for a fingerprint; a fingerprint used twice in one run gets an ordinal. */
  idFor(fingerprint: string): string {
    let fp = fingerprint;
    for (let n = 1; this.used.has(fp); n++) fp = `${fingerprint}::${String(n)}`;
    this.used.add(fp);
    let id = this.data.ids[fp];
    if (!id) {
      id = `TC-${idPrefix(this.key)}-${String(this.data.next).padStart(3, '0')}`;
      this.data.next += 1;
      this.data.ids[fp] = id;
    }
    return id;
  }

  save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
}
