# LangGraph orchestration

The QA run is one LangGraph.js `StateGraph` with a durable checkpointer. Source: `src/graph/`, `src/agents/qa-lead/`.
This document describes the Phase 1 graph. Later phases insert nodes between `clarify` and `report`.

## Graph

```
START → intake → triage → understand → triage ⇄ clarify (interrupt) → triage → report → END
                   │                       │                             │
                   └── retry / degrade ────┴── retry / degrade / ask ────┴── halt → report (BLOCKED)
```

| Node | Agent | What it does |
|---|---|---|
| `intake` | QA Lead | Resolves every requested input through the adapter registry. A failing input becomes an Issue (`DATA`, `AUTH`, `TRANSIENT`, `TOOL_UNAVAILABLE`) and the other inputs continue. Sets `storyKey` and `story`. |
| `understand` | Spec Analyst | `analyzeSpec()`: lint, extract, analyze, status, ids, coverage, evidence. Questions raise one `AMBIGUOUS_SPEC` Issue. |
| `clarify` | QA Lead (human checkpoint) | `interrupt({ kind: 'clarification', questions })`. On resume, answers → `ANSWERED`, skipped or no answer → `ASSUMED`, flagged on requirements. Without asking (L3, `--no-input`) everything is assumed at once. |
| `triage` | QA Lead | After every node: triages that node's new Issues with `config/policy.yaml` and routes. |
| `report` | Reporter | Writes `runs/<runId>/analysis/*`. Runs even when the run is BLOCKED: every path ends here. |

Every working node is wrapped in `resilientNode()` (CLAUDE.md rule 3). Exceptions become Issues, `HardStopError`
becomes status BLOCKED, and LangGraph's own control flow (`interrupt`) passes through untouched.

## State

`QAGraphState` (`src/graph/state.ts`) is `QARunState` (PLAN.md §4) as `Annotation.Root` channels, plus control fields.

- `issues`: merged by id. A node appends new Issues; triage updates their `resolution`.
- `evidence`, `triageLog`, `notes`: append.
- Everything else: the last value wins, because nodes return full replacements.
- Control fields:
  - `interactive`
  - `degradedNodes`
  - `applied`: per `node:IssueKind`, how often each response ran
  - `route`, `lastNode`
  - `clarifyRound`
  - `coverage`
  - `analysisEnvironment`, `analysisModels`
  - `outputs`

## Triage (`src/agents/qa-lead/triage.ts`)

For each unresolved Issue of the last node, take the first response in `policy.issues[kind]` that passes all of these:

1. It was not already done inside the component. `runStructured` marks reflect-retries and the fallback model as
   `detail.handled`.
2. It is not exhausted:
   - `retry` stops at `policy.retry.maxAttempts`, with `backoffSeconds` delays
   - `ask` stops at the clarification round limit
   - other responses run once
3. The node can perform it (`NodeCapabilities`):
   - `intake`: retry, degrade (skip the input)
   - `understand`: retry, degrade (mechanical analysis), ask
   - `clarify`: degrade (assume)
4. It is not a later-phase response (`investigate`, `heal`, `judge`, `file_bug`).

`HARD_STOP` is always `halt`. An optional reorder hook (for example an LLM) may reorder the allowed list and must give
a reason. Responses outside the policy are rejected and logged. When nothing applies, the Issue is `report-only`:
visible for the human, never acted on. Each decision is written to `triageLog` and to the evidence ledger.

Routing priority: `halt` → report; `retry` → same node (after backoff); `degrade` of `understand` without
requirements → `understand` again in mechanical mode; `ask` → `clarify`; otherwise the normal next node.

Final status:

- **BLOCKED**: a hard stop.
- **PARTIAL**: no requirements, or any Issue that is DEGRADED, ESCALATED or unresolved, other than AMBIGUOUS_SPEC.
  Flagged assumptions do not make a run partial.
- **COMPLETE**: everything else.

## Checkpointing, interrupt and resume

- `SqliteCheckpointSaver` (`src/graph/checkpointer.ts`) uses the built-in `node:sqlite`. It needs no native build on
  Windows and stores one row per run (thread id = run id) in `.qa-memory/checkpoints.db`.
- The CLI (`src/cli/analyze.ts → drive()`) invokes the graph. After each invoke it checks for a pending
  `clarification` interrupt, collects answers, and continues with `new Command({ resume })`. Answers come from
  `--answers <yaml>`, then from the console.
  - The console wait is `policy.clarification.waitMinutes[autonomy]`: L1 waits without limit, L2 waits 30 min, L3
    does not ask.
  - Piped stdin works (`Prompter`).
- **Resume:** `qa resume --run <id>` builds a fresh graph on the same checkpoint and continues. That covers a closed
  terminal, a killed process or a later answer. Phase 1 notes show a kill/resume run on the real demo.
- Run ids are single-use: a new `qa analyze` with an existing id is refused.

## Tests

- `src/graph/mainGraph.test.ts`:
  - non-interactive assumptions
  - interrupt, then resume in a new graph instance from SQLite
  - a second clarification round
  - timeout and L3
  - invalid model output → mechanical degrade
  - a corrupt input skipped
  - JIRA 503 retried 3 times, then escalated
  - a secret → BLOCKED with the report still written
- `src/agents/qa-lead/index.test.ts`: every IssueKind maps only to policy responses; backoff; handled responses;
  reorder rejection.
- `src/graph/checkpointer.test.ts`: interrupt and resume across a reopened database.
