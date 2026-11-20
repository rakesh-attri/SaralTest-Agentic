import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Requirement } from '../core/schemas/index.js';
import { ManualTestCase, SourceDocument } from '../core/schemas/inputs.js';
import type { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import type { SnapshotStore } from '../knowledge/snapshotStore.js';
import {
  chunkLocators,
  chunkManualTests,
  chunkRequirements,
  chunkSnapshot,
  chunkSourceDocument,
  makeChunk,
  type Chunk,
} from './chunkers.js';

/** PII never leaves the machine inside embeddings: deterministic masks (stable hashes → dedupe still works). */
export function maskForEmbedding(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>')
    .replace(/(?<![\w-])\+?\d[\d ().-]{6,}\d(?![\w-])/g, (m) => (m.replace(/\D/g, '').length >= 7 ? '<PHONE>' : m));
}

function readArray(file: string, key: string): unknown[] {
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (Array.isArray(raw)) return raw;
  const inner = (raw as Record<string, unknown> | null)?.[key];
  return Array.isArray(inner) ? inner : [];
}

export interface CollectInput {
  root: string;
  org: string;
  release: string;
  /** `qa analyze` run ids whose sources / requirements / manual tests are ingested. */
  analysisRuns?: string[];
  /** Already-parsed source documents (files given on the command line). */
  documents?: SourceDocument[];
  snapshots?: SnapshotStore;
  /** Snapshot id or 'latest' (of `org`). */
  snapshot?: string;
  registry?: LocatorRegistry;
}

/** Gather chunks from analysis runs, documents, an org snapshot and the locator registry. */
export function collectChunks(i: CollectInput): { chunks: Chunk[]; notes: string[] } {
  const out: Chunk[] = [];
  const notes: string[] = [];
  for (const runId of i.analysisRuns ?? []) {
    const dir = join(i.root, 'runs', runId, 'analysis');
    if (!existsSync(dir)) {
      notes.push(`analysis run ${runId} not found — skipped`);
      continue;
    }
    const srcDir = join(dir, 'sources');
    const docs = existsSync(srcDir)
      ? readdirSync(srcDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => SourceDocument.safeParse(JSON.parse(readFileSync(join(srcDir, f), 'utf8'))))
          .filter((r) => r.success)
          .map((r) => r.data)
      : [];
    for (const d of docs) out.push(...chunkSourceDocument(d, i.org, i.release));
    const reqs = readArray(join(dir, 'requirements.json'), 'requirements').map((r) => Requirement.parse(r));
    out.push(...chunkRequirements(reqs, i.org, i.release, runId));
    const tests = readArray(join(dir, 'existing-tests.json'), 'tests')
      .map((t) => ManualTestCase.safeParse(t))
      .filter((r) => r.success)
      .map((r) => r.data);
    out.push(...chunkManualTests(tests, i.org, i.release, runId));
    const defects = readArray(join(dir, 'defects.json'), 'defects');
    for (const d of defects) {
      const parsed = z
        .looseObject({
          key: z.string(),
          summary: z.string(),
          status: z.string().optional(),
          description: z.string().optional(),
        })
        .safeParse(d);
      if (!parsed.success) continue;
      out.push(
        makeChunk({
          table: 'defects',
          text: `${parsed.data.key}: ${parsed.data.summary}${parsed.data.status ? ` [${parsed.data.status}]` : ''}\n${parsed.data.description ?? ''}`,
          org: i.org,
          release: i.release,
          type: 'defect',
          sourceRef: parsed.data.key,
          sourceKey: `run:${runId}:defects`,
        }),
      );
    }
    notes.push(
      `run ${runId}: ${docs.length} source documents, ${reqs.length} requirements, ${tests.length} manual tests, ${defects.length} defects`,
    );
  }
  for (const d of i.documents ?? []) out.push(...chunkSourceDocument(d, i.org, i.release));
  if (i.snapshot && i.snapshots) {
    const info =
      i.snapshot === 'latest' ? i.snapshots.latest(i.org) : i.snapshots.list(i.org).find((s) => s.id === i.snapshot);
    const snap = info ? i.snapshots.get(info.id) : undefined;
    if (!snap) notes.push(`no snapshot ${i.snapshot} for org ${i.org}`);
    else {
      out.push(
        ...chunkSnapshot({
          snapshotId: snap.info.id,
          org: i.org,
          release: snap.info.release,
          environment: snap.info.environment,
          components: snap.components,
        }),
      );
      notes.push(`snapshot ${snap.info.id}: ${snap.components.length} components`);
    }
  }
  if (i.registry) {
    const locators = i.registry.list({ org: i.org }).filter((l) => l.status !== 'RETIRED');
    out.push(...chunkLocators(locators, i.release));
    notes.push(`locator registry: ${locators.length} locators`);
  }
  // Mask PII, then re-key (the hash covers what is actually embedded).
  const chunks = out.map((c) => {
    const text = maskForEmbedding(c.text);
    if (text === c.text) return c;
    const { id: _id, hash: _hash, ...rest } = c;
    return makeChunk({ ...rest, text });
  });
  const unique = [...new Map(chunks.map((c) => [c.id, c])).values()];
  return { chunks: unique, notes };
}
