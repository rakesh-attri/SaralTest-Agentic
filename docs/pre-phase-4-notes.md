# Pre-Phase-4 notes — model providers, fallback chains, rate limits (2026-11-20)

Operator request before Phase 4: spread model load across NVIDIA NIM, Groq and Gemini, keep each provider in its
limits, and fail over automatically on 429. Guide: `docs/ai-embedding-config.md`.

## What changed

- **Providers.** Added `openai-compatible` (base URL + key) with presets `nvidia-nim` and `groq`.
  - `endpoints:` overrides; https-or-localhost only.
  - New secret keys: `NVIDIA_API_KEY`, `GROQ_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`.
- **Chains.** `fallback:` takes one model or a list.
  - `runStructured` and `withFallback` walk the whole chain.
  - Results are labelled with the model that answered.
- **Limits.** Per-provider requests and tokens per minute, `maxWaitMs` (default 20 s) before failing over, and a
  Retry-After cooldown after an HTTP 429. No new `IssueKind`: rate limits are `TRANSIENT` with `rateLimited: true`.
- **Rule 8.** The judge may not share a model with any coder chain entry (schema). Doctor warns when the judge and
  coder primaries are from the same family.
- **Doctor.**
  - Lists NIM / Groq / Gemini models grouped by namespace.
  - Prints effective quotas and the DeepEval judge chain.
  - `--live` calls every chain model and probes tool calling.
- **DeepEval.**
  - `src/eval/judgeEndpoint.ts` plus a minimal `eval/` uv project with `OpenAICompatibleJudge`. This includes
    DeepEval 4.3.4, the version resolved by `uv`.
  - Telemetry is opted out.
- `<think>…</think>` blocks are stripped before JSON parsing.

## Role layout (local `config/models.yaml`, picked 2026-11-21 from the `qa doctor` lists)

| Role | Primary | Fallbacks |
|---|---|---|
| reasoning | nvidia-nim `nvidia/nemotron-3-ultra-550b-a55b` | google `gemini-3.5-flash-lite` |
| coder | nvidia-nim `poolside/laguna-xs-2.1` | groq `openai/gpt-oss-120b` → google `gemini-3.5-flash-lite` |
| fast | groq `openai/gpt-oss-20b` | google `gemini-3.5-flash-lite` |
| judge | nvidia-nim `minimaxai/minimax-m3.1-flash` | google `gemini-3.1-flash-lite` |
| embeddings | google `gemini-embedding-2` (unchanged, no re-index) | — |

The families are nemotron (reasoning), poolside (coder) and minimax (judge). The judge is independent of the coder,
and also of the planner whose output the Test Reviewer checks.

**How the ids were chosen.** All candidates came from what the keys list, filtered by a live probe on a short
Salesforce JSON task (latency + valid JSON). Benchmark quality was not measured.

| Candidate | Result |
|---|---|
| `moonshotai/kimi-k3.1-pro` | timed out (> 120 s in `--live`, > 90 s in the probe) |
| `z-ai/glm-5.3-flash` | timed out (> 90 s) |
| `stepfun-ai/step-5-preview` | timed out (> 90 s) |
| `mistralai/mistral-large-4-1t-a52b` | answered, but in 25–67 s; too slow for a judge |
| `poolside/laguna-xs-2.1` | 0.8 s, valid JSON |
| `nemotron-3-ultra` | 3.3 s, valid JSON |
| `minimax-m3.1-flash` | 5.4 s, valid JSON |
| Groq `qwen/qwen3.8-27b` | 0.4 s, valid JSON (spare option) |

`gemini-3.1-pro-preview` returned **HTTP 429** (the free tier has no Pro quota). The judge fallback is therefore
`gemini-3.1-flash-lite`, which also keeps it different from the coder's Gemini model.
The coder is not exercised before Phase 4. Watch `laguna-xs` (a small model) on real test generation; the Groq
`gpt-oss-120b` fallback is there if it falls short.

## Decisions / deviations from the plan

- The plan made a same-family judge/coder a schema error. It is a **doctor warning** instead, because a hard error
  would invalidate Gemini-only setups (every Gemini model is one family). The hard rule is still that the judge never
  equals any coder chain model.
- Quotas apply per provider. Groq's real limits are per model, so per-provider is the conservative choice.
- Default quotas (NIM 40 rpm; Groq 30 rpm / 6000 tpm; Google 15 rpm in the local config) are conservative
  placeholders, not your account's verified limits. Adjust them in `quotas:`.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`: pass.
- `pnpm test`: 343 tests pass, 26 of them new:
  - `src/models/chain.test.ts`: presets; https rule; chain order and labels; NIM 429 → Groq → Gemini; Retry-After
    cooldown with no second request; TPM fail-fast; settle; last-in-chain wait; `tools: false`; `<think>`
  - `src/eval/judgeEndpoint.test.ts`: no key ever in `QA_JUDGE_CHAIN`
  - doctor: NIM/Groq listing with mocked HTTP
- `cd eval; uv run --python 3.12 pytest -q`: 5 pass (fake OpenAI client), with the real DeepEval base class.
- Manual: `pnpm qa doctor` on this machine (Windows) listed 66 Gemini models. It reported both NIM and Groq keys as
  not set (WARN) and showed every role running on its Gemini fallback.

## Live verification (2026-11-21, after the keys were added)

- `pnpm qa doctor` listed 33 NIM and 11 Groq models, grouped by namespace.
- `pnpm qa doctor --live` was **green**: all 7 distinct chain models answered in 0.6–1.4 s and accepted tool calls.
  - The first attempt exceeded doctor's 120 s per-check limit (11 sequential calls plus kimi's timeout). Live probes now
    run once per distinct model, in parallel, with latency shown, and the models check limit is 300 s.
  - The live run also hit a real provider 429 (Gemini Pro). It was tagged rate-limited and cooled down as designed.
- `pnpm qa analyze --story SF-219 --no-input --run-id nim-live-1` was **COMPLETE / LIVE** with analysis model
  `nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b`: 8 requirements, 5 questions, 13 findings, no failover.
- Forced failover: NIM was set to `requestsPerMinute: 1, maxWaitMs: 0` temporarily (since restored), and
  `--run-id nim-failover-1` was run.
  - Both reasoning calls (extract, analyze) logged `rateLimited: true … failing over to google/gemini-3.5-flash-lite`.
  - The run was COMPLETE in 40 s, labelled `google/gemini-3.5-flash-lite`.
- DeepEval judge chain resolves to `nvidia-nim/minimaxai/minimax-m3.1-flash → google/gemini-3.1-flash-lite`. The
  Python judge has not called a real endpoint yet (runner is Phase 8).

## Open / known gaps

- **Fixed 2026-11-21: run budget now receives model tokens.**
  - Before: `run.json` reported `tokensUsed: 0` for every run, including Phase 3, because the router (built in the
    CLI before the graph) had no budget.
  - Now: `resilientNode` runs each node inside its run's `BudgetTracker` (`runWithBudget`, AsyncLocalStorage),
    and the router charges `currentBudget()` by default. This covers `qa analyze`, `qa discover`, `qa chat` and
    concurrent runs.
  - Over the token limit → BUDGET issue → run PARTIAL. Tested in `src/models/budget.test.ts` and `mainGraph.test.ts`.
  - Live: `--run-id nim-budget-1` recorded `tokensUsed: 35928`.
  - Embedding calls (RAG ingest) are still not charged to a run budget.
- Quotas are conservative defaults, not your accounts' verified limits.
- The NIM catalogue changes over time. Re-run `pnpm qa doctor` when a model starts failing.
