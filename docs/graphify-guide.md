# Graphify: codebase map for LLMs (dev tooling)

[Graphify](https://github.com/Graphify-Labs/graphify) (Apache-2.0, PyPI `graphifyy`) turns this repository into a
knowledge graph that an LLM (or a person) can query instead of grepping 400+ files.

**This is development tooling only.** It is not part of sf-qa-agent at runtime and is unrelated to:

| Name | What it is | Where |
|---|---|---|
| RAG memory | LanceDB vectors of org metadata, locators, requirements (runtime) | `src/rag`, `.qa-memory/rag`, `docs/rag-guide.md` |
| Org knowledge graph | Salesforce components/dependencies from `qa discover` (runtime) | `.qa-memory/graph.db`, `docs/knowledge-graph.md` |
| **Graphify graph** | Map of this repo's source and docs (dev aid) | `graphify-out/` |

## Why

- New LLM sessions otherwise rediscover the architecture by grep every time.
- Every edge is tagged `EXTRACTED` (read from source) or `INFERRED`; code is parsed locally with tree-sitter, no LLM,
  nothing leaves the machine.
- It answers "who calls X", "what breaks if I change X", "how does A connect to B" cheaply.
- The graph is a navigation aid, **not a source of truth**: confirm against the source it points to.

## Use (PowerShell)

```powershell
graphify god-nodes --top 10          # most-connected hubs
graphify query "how is the retriever used?"
graphify explain "RagStore"
graphify path "buildCli" "RagStore"
graphify affected "QAError"          # reverse impact
pnpm graph:update                    # refresh after code changes (AST only, no API cost)
```

Start with `graphify-out/GRAPH_REPORT.md` for broad orientation. `CLAUDE.md` tells Claude Code to query the graph
before grepping; `.claude/settings.json` has the PreToolUse hooks (`graphify hook-guard`) and git hooks rebuild the
graph on commit/checkout (`graphify hook status`).

## What is committed

`graphify-out/graph.json` and `GRAPH_REPORT.md` (plus small metadata). `cache/`, `graph.html`, `memory/` are
git-ignored. `.graphifyignore` excludes secrets and local state (`.env`, `.auth/`, `config/*.yaml`, `.qa-memory/`,
`runs/`, baselines). Verify before committing: no secrets appear in `graph.json`.

## Install (new machine)

```powershell
uv tool install graphifyy      # Python 3.11.5-3.14
pnpm graph:update              # or: graphify extract . --code-only
```

## Limits

- Code pass is local and deterministic. Community names and the doc/markdown semantic pass need an LLM backend
  (`graphify extract . --backend <claude|gemini|openai|ollama>`); doc text is sent to that backend.
- Test files with no top-level symbols (e.g. some `*.test.ts`) yield no nodes.
