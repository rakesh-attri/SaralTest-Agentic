import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Embeddings } from '@langchain/core/embeddings';
import { describe, expect, it } from 'vitest';
import type { SourceDocument } from '../core/schemas/inputs.js';
import type { ComponentVersion } from '../core/schemas/knowledge.js';
import { MockEmbeddings } from '../models/mock.js';
import { approxTokens, chunkSnapshot, chunkSourceDocument, makeChunk, windowText, type Chunk } from './chunkers.js';
import { RagStore } from './store.js';

const ORG = '00DFIXTURE00000001';
const dir = (): string => mkdtempSync(join(tmpdir(), 'rag store '));

class CountingEmbeddings extends Embeddings {
  calls = 0;
  constructor(
    private readonly inner = new MockEmbeddings(32),
    private readonly failOnCall?: number,
  ) {
    super({});
  }
  async embedDocuments(d: string[]): Promise<number[][]> {
    this.calls++;
    if (this.failOnCall === this.calls) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return this.inner.embedDocuments(d);
  }
  embedQuery(d: string): Promise<number[]> {
    return this.inner.embedQuery(d);
  }
}

const chunk = (n: number, text = `chunk number ${n} about Contact phone validation`): Chunk =>
  makeChunk({
    table: 'docs',
    text,
    org: ORG,
    release: 'r1',
    type: 'doc',
    sourceRef: `DOC#S${n}`,
    sourceKey: 'doc:DOC',
  });

describe('chunkers', () => {
  it('windows long text into 500–800-token chunks with ~12% overlap', () => {
    const sentence = 'The Contact must be linked to an Account and validated before it is saved by the Sales Rep. ';
    const text = sentence.repeat(200);
    const windows = windowText(text);
    expect(windows.length).toBeGreaterThan(2);
    for (const w of windows.slice(0, -1)) {
      expect(approxTokens(w)).toBeGreaterThanOrEqual(500);
      expect(approxTokens(w)).toBeLessThanOrEqual(820);
    }
    const tail = windows[0]?.slice(-120) ?? '';
    expect(windows[1]?.includes(tail.slice(-60))).toBe(true); // overlap carried over
  });

  it('JIRA stories → one chunk per AC; manual-test documents are left to the test-asset chunker', () => {
    const doc: SourceDocument = {
      docId: 'SF-219',
      source: { type: 'jira', ref: 'SF-219', hash: 'h' },
      title: 'story',
      meta: {},
      sections: [
        { ref: 'S1', kind: 'summary', heading: 'Summary', text: 'Sales Reps add Contacts' },
        { ref: 'AC1', kind: 'ac', text: 'Given … Then the Contact is created' },
      ],
      text: '',
      warnings: [],
    };
    const chunks = chunkSourceDocument(doc, ORG, 'r1');
    expect(chunks.map((c) => `${c.table}:${c.sourceRef}`)).toEqual([
      'requirements:SF-219#S1',
      'requirements:SF-219#AC1',
    ]);
    expect(
      chunkSourceDocument({ ...doc, source: { type: 'manual-test', ref: 'x.xlsx', hash: 'h' } }, ORG, 'r1'),
    ).toEqual([]);
  });

  it('snapshot → one chunk per component, fields in groups of ≤ 25, UNKNOWN stated explicitly', () => {
    const comps: ComponentVersion[] = [
      ...Array.from({ length: 30 }, (_, i) => ({
        snapshotId: 's',
        type: 'Field',
        apiName: `Contact.F${String(i).padStart(2, '0')}__c`,
        label: `F${i}`,
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED' as const,
        reviewStatus: 'APPROVED' as const,
        body: { type: 'string', custom: true },
      })),
      {
        snapshotId: 's',
        type: 'ValidationRule',
        apiName: 'Contact.Phone_Format',
        parent: 'Contact',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'DECLARED',
        reviewStatus: 'APPROVED',
        body: { active: true, errorConditionFormula: 'NOT(REGEX(Phone,"\\\\d{10}"))' },
      },
      {
        snapshotId: 's',
        type: 'Flow',
        apiName: '*',
        hash: 'h',
        dataScope: 'metadata',
        evidenceStatus: 'UNKNOWN',
        reviewStatus: 'REVIEW_REQUIRED',
        body: { reason: 'INSUFFICIENT_ACCESS' },
      },
    ];
    const chunks = chunkSnapshot({
      snapshotId: 's',
      org: ORG,
      release: 'r1',
      environment: 'FIXTURE',
      components: comps,
    });
    expect(chunks.filter((c) => c.type === 'FieldGroup')).toHaveLength(2);
    expect(chunks.find((c) => c.type === 'ValidationRule')?.text).toContain('REGEX(Phone');
    expect(chunks.find((c) => c.type === 'Flow')?.text).toMatch(/UNKNOWN .*Not evidence of absence/);
    expect(chunks.every((c) => c.text.includes('(FIXTURE)'))).toBe(true);
  });
});

describe('RagStore (LanceDB + manifest)', () => {
  it('dedupes unchanged chunks, replaces changed sources incrementally, retrieves with RRF and org filter', async () => {
    const emb = new CountingEmbeddings();
    const store = new RagStore({ dir: dir(), embeddings: emb, embedModel: 'mock/hash-32', batchSize: 2 });
    const first = await store.ingest([chunk(1), chunk(2), chunk(3)]);
    expect(first).toMatchObject({ added: 3, skipped: 0, removed: 0 });
    const again = await store.ingest([chunk(1), chunk(2), chunk(3)]);
    expect(again).toMatchObject({ added: 0, skipped: 3 });
    const changed = await store.ingest([
      chunk(1),
      chunk(2),
      chunk(3, 'chunk number 3 now about duplicate rules on Contact'),
    ]);
    expect(changed).toMatchObject({ added: 1, skipped: 2, removed: 1 });
    expect(store.counts()).toEqual({ docs: 3 });

    await store.ingest([
      makeChunk({
        table: 'docs',
        text: 'duplicate rules on Contact in another org',
        org: '00D000000000000AAA',
        release: 'r1',
        type: 'doc',
        sourceRef: 'X#1',
        sourceKey: 'doc:X',
      }),
    ]);
    const hits = await store.retrieve({ query: 'duplicate rules', org: ORG, k: 3 });
    expect(hits[0]?.sourceRef).toBe('DOC#S3');
    expect(hits[0]?.via).toContain('fts');
    expect(hits.every((h) => h.org === ORG)).toBe(true);
    store.close();
  });

  it('resumes after an interrupted ingest without re-embedding finished batches', async () => {
    const d = dir();
    const failing = new CountingEmbeddings(undefined, 2);
    const s1 = new RagStore({
      dir: d,
      embeddings: failing,
      embedModel: 'mock/hash-32',
      batchSize: 2,
      retry: { maxAttempts: 1, backoffSeconds: [0] },
    });
    await expect(s1.ingest([chunk(1), chunk(2), chunk(3), chunk(4)])).rejects.toThrow(/socket/);
    expect(s1.counts()).toEqual({ docs: 2 });
    s1.close();
    const ok = new CountingEmbeddings();
    const s2 = new RagStore({ dir: d, embeddings: ok, embedModel: 'mock/hash-32', batchSize: 2 });
    const r = await s2.ingest([chunk(1), chunk(2), chunk(3), chunk(4)]);
    expect(r).toMatchObject({ added: 2, skipped: 2, resumed: 2 });
    expect(ok.calls).toBe(1);
    s2.close();
  });

  it('refuses to mix vectors from different embedding models', async () => {
    const d = dir();
    const a = new RagStore({ dir: d, embeddings: new MockEmbeddings(32), embedModel: 'mock/a' });
    await a.ingest([chunk(1)]);
    a.close();
    const b = new RagStore({ dir: d, embeddings: new MockEmbeddings(32), embedModel: 'mock/b' });
    await expect(b.ingest([chunk(2)])).rejects.toThrow(/holds vectors from mock\/a/);
    await b.reset();
    expect((await b.ingest([chunk(2)])).added).toBe(1);
    b.close();
  });
});

describe('collectChunks', () => {
  it('masks emails and phone numbers before anything is embedded', async () => {
    const { maskForEmbedding } = await import('./ingest.js');
    expect(maskForEmbedding('Call +1 (415) 555-0100 or mail jane.doe@acme.example; AC2 has 10 digits')).toBe(
      'Call <PHONE> or mail <EMAIL>; AC2 has 10 digits',
    );
  });
});

describe('embedding provider returning empty vectors (swallowed 429)', () => {
  it('is treated as TRANSIENT and retried, never stored', async () => {
    let calls = 0;
    class Flaky extends Embeddings {
      constructor() {
        super({});
      }
      embedDocuments(d: string[]): Promise<number[][]> {
        calls++;
        return calls === 1 ? Promise.resolve(d.map(() => [])) : new MockEmbeddings(32).embedDocuments(d);
      }
      embedQuery(d: string): Promise<number[]> {
        return new MockEmbeddings(32).embedQuery(d);
      }
    }
    const store = new RagStore({
      dir: dir(),
      embeddings: new Flaky(),
      embedModel: 'mock/hash-32',
      retry: { maxAttempts: 3, backoffSeconds: [0], sleep: () => Promise.resolve() },
    });
    const r = await store.ingest([chunk(1), chunk(2)]);
    expect(r.added).toBe(2);
    expect(calls).toBe(2);
    store.close();
  });
});
