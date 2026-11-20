import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadEnv, secretValues } from '../config/env.js';
import { loadConfigFile, projectPaths, requireConfig } from '../config/loader.js';
import { createLogger } from '../core/logger.js';
import type { SourceDocument } from '../core/schemas/inputs.js';
import { resolveInput } from '../inputs/index.js';
import { LocatorRegistry } from '../knowledge/locatorRegistry.js';
import { SnapshotStore } from '../knowledge/snapshotStore.js';
import { MockEmbeddings } from '../models/mock.js';
import { RateLimiter } from '../models/rateLimiter.js';
import { ModelRouter } from '../models/router.js';
import { collectChunks } from '../rag/ingest.js';
import { RAG_TABLES, type RagTable } from '../rag/chunkers.js';
import { RagStore } from '../rag/store.js';
import { SecretStore } from '../security/secretStore.js';
import { registryFile } from './locators.js';

type Say = (msg: string) => void;

/** `qa ingest` — documents, analysis runs, org snapshots and locators into RAG memory (PLAN.md §7). */
export function registerIngest(program: Command, rootOf: () => string, say: Say): void {
  program
    .command('ingest')
    .description(
      'Ingest into RAG memory: analysis runs, spec files, org snapshot, locator registry (hash-deduped, incremental, resumable)',
    )
    .argument('[targets...]', 'analysis run ids (runs/<id>/analysis) and/or spec files')
    .option('--org <alias>', 'org the knowledge belongs to (default QA_DEFAULT_ORG)')
    .option('--snapshot [id]', "ingest an org snapshot ('latest' when no id)")
    .option('--locators', 'ingest the locator registry of the org')
    .option('--search <query>', 'run a hybrid retrieval query after ingesting')
    .option('--table <name>', `restrict --search to a table (${RAG_TABLES.join(', ')})`)
    .option('--reindex', 'drop all vectors first (after changing the embedding model)')
    .option('--offline', 'mock embeddings in .qa-memory/rag-mock (no network; results labelled MOCK)')
    .action(
      async (
        targets: string[],
        o: {
          org?: string;
          snapshot?: string | boolean;
          locators?: boolean;
          search?: string;
          table?: string;
          reindex?: boolean;
          offline?: boolean;
        },
      ) => {
        const root = rootOf();
        const paths = projectPaths(root);
        const env = await loadEnv(root);
        const orgs = await requireConfig('orgs', paths);
        const alias = o.org ?? env.QA_DEFAULT_ORG;
        const org = orgs.orgs.find((x) => x.alias === alias);
        if (!org) throw new Error(`org alias "${alias ?? ''}" is not in config/orgs.yaml (use --org)`);
        const store = new SecretStore(env);
        const logger = createLogger({ level: 'error' });

        let embeddings;
        let embedModel: string;
        let ragDir = join(root, '.qa-memory', 'rag');
        if (o.offline) {
          embeddings = new MockEmbeddings(64);
          embedModel = 'mock/hash-64';
          ragDir = join(root, '.qa-memory', 'rag-mock');
          say(
            'Offline: MOCK embeddings (hash vectors). Retrieval quality is not representative; results are labelled MOCK.',
          );
        } else {
          const models = await loadConfigFile('models', paths);
          if (!models.ok) throw new Error(`config/models.yaml unusable: ${models.errors.join('; ')}`);
          const router = await ModelRouter.create({
            config: models.value,
            secrets: { get: async (k) => (await store.get(k)).value, setting: (k) => env[k] },
            secretValues: () => secretValues(env),
            logger,
          });
          embeddings = await router.embeddings();
          embedModel = router.embeddingModelId();
          say(
            `Embeddings: ${embedModel} (metadata, requirements and test assets only — PII masked, never record data).`,
          );
        }
        const rag = new RagStore({
          dir: ragDir,
          embeddings,
          embedModel,
          limiter: new RateLimiter(o.offline ? 600 : 6),
          batchSize: o.offline ? 32 : 10,
        });
        const snapshots = new SnapshotStore(join(root, '.qa-memory', 'knowledge.db'));
        const registry = o.locators ? new LocatorRegistry(registryFile(root)) : undefined;
        try {
          if (o.reindex) {
            say('Reindex: dropping all stored vectors…');
            await rag.reset();
          }
          const runs = targets.filter((t) => existsSync(join(root, 'runs', t, 'analysis')));
          const files = targets.filter((t) => !runs.includes(t));
          const documents: SourceDocument[] = [];
          for (const f of files) {
            const r = await resolveInput(
              { kind: 'file', value: resolve(f) },
              { root, cwd: process.cwd(), env, logger },
            );
            documents.push(...r.documents);
          }
          const latestSnap = snapshots.latest(org.orgId);
          const { chunks, notes } = collectChunks({
            root,
            org: org.orgId,
            release: latestSnap?.release ?? org.release,
            analysisRuns: runs,
            documents,
            snapshots,
            ...(o.snapshot ? { snapshot: typeof o.snapshot === 'string' ? o.snapshot : 'latest' } : {}),
            ...(registry ? { registry } : {}),
          });
          for (const n of notes) say(`  ${n}`);
          if (chunks.length) {
            say(`Ingesting ${chunks.length} chunks into ${ragDir}…`);
            const stats = await rag.ingest(chunks, say);
            say(
              `Ingest: ${stats.added} embedded, ${stats.skipped} unchanged (skipped), ${stats.removed} removed, ${stats.resumed} resumed. Tables: ${JSON.stringify(rag.counts())}`,
            );
          } else if (!o.search) {
            say('Nothing to ingest (give run ids / files, --snapshot or --locators).');
          }
          if (o.search) {
            const tables = o.table ? [o.table as RagTable] : undefined;
            const hits = await rag.retrieve({ query: o.search, org: org.orgId, ...(tables ? { tables } : {}), k: 6 });
            process.stdout.write(
              `Top ${hits.length} for "${o.search}" (org ${org.alias}${o.offline ? ', MOCK embeddings' : ''}):\n`,
            );
            for (const h of hits) {
              process.stdout.write(
                `  ${h.score.toFixed(4)} [${h.table}] ${h.sourceRef} (${h.via.join('+')})\n      ${h.text.split('\n')[0]?.slice(0, 140) ?? ''}\n`,
              );
            }
          }
        } finally {
          rag.close();
          snapshots.close();
          registry?.close();
        }
      },
    );
}
