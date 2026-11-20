# RAG guide (LanceDB memory)

Code:
- `src/rag/chunkers.ts` — chunking
- `src/rag/store.ts` — store, manifest, retrieval
- `src/rag/ingest.ts` — collection and PII masking
- `src/cli/ingest.ts` — CLI

## What is stored

LanceDB tables live in `.qa-memory/rag/lancedb`. Each row has `id, text, vector, embedModel, org, release, type,
sourceRef, sourceKey, createdAt, confidence`.

| Table | Chunking (PLAN.md §7) |
|---|---|
| `requirements` | JIRA/ADO/chat stories: one chunk per AC + summary; canonical requirements: one each |
| `docs` | other documents: grouped by heading, 500–800-token windows with 12% overlap |
| `test_assets` | manual test cases: one each |
| `defects` | defect history: one each |
| `org_metadata` | one chunk per component from a snapshot; fields grouped per object (≤ 25 per chunk); UNKNOWN areas are stored as "could not be read — not evidence of absence" |
| `locators` | one per registry locator |
| `learnings` | Phase 8 |

## Ingest behaviour

- **Hash dedupe:** a chunk's id is derived from table + source + sha256(text). Unchanged chunks are skipped.
- **Incremental:** chunks are grouped by `sourceKey` (one document, one run's requirements, one org's snapshot,
  one org's locators). On re-ingest, chunks of that source that are no longer produced are deleted.
- **Resumable:** the manifest (`.qa-memory/rag/manifest.db`) marks chunks PENDING before embedding and EMBEDDED after
  each batch is stored. An interrupted ingest re-embeds only the PENDING ones. Batches are upserted idempotently.
- **Embedding model per row:** vectors from different models never mix. A model change is refused until you run
  `qa ingest --reindex`.
- **PII:** emails and phone numbers are masked with deterministic tokens before embedding. Record data is never
  ingested: metadata, requirements and test assets only. Secrets are blocked by the router's guard.
- **Provider quota:** LangChain's Google embeddings turn an HTTP 429 into empty vectors. `checkVectors()` treats
  empty, NaN or ragged vectors as TRANSIENT, and ingest retries them with backoff (15/30/60 s). The live default is
  10 chunks per batch at 6 batches per minute, which fits the Gemini free-tier per-minute quota.

## Retrieval

`RagStore.retrieve({ query, org, release?, tables?, k })` runs a vector search plus a full-text search (FTS index on
`text`) per table and fuses them with reciprocal-rank fusion (k = 60). The `org` filter is mandatory; `release` is
optional. Each hit returns `{ table, text, sourceRef, score, via: [vector|fts] }` for evidence citation.

## Commands

```
pnpm qa ingest run-p1-final-combined --org qa-prod --snapshot --locators     # live Gemini embeddings
pnpm qa ingest examples/inputs/Contact-Management-BRD-v1.2.pdf --org qa-prod  # a spec file
pnpm qa ingest --org qa-prod --search "Phone validation rule on Contact" [--table org_metadata]
pnpm qa ingest ... --offline       # MOCK hash embeddings in .qa-memory/rag-mock (labelled MOCK)
pnpm qa ingest ... --reindex       # after changing the embedding model
```
