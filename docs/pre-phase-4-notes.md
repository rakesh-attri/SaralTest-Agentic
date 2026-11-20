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

## Role layout (local `config/models.yaml`)

| Role | Primary | Fallbacks |
|---|---|---|
| reasoning | nvidia-nim `<nim-reasoning-model-id>` | google `gemini-3.5-flash-lite` |
| coder | nvidia-nim `<nim-coder-model-id>` | groq `<groq-coder-model-id>` → google `gemini-3.5-flash-lite` |
| fast | groq `<groq-fast-model-id>` | google `gemini-3.5-flash-lite` |
| judge | nvidia-nim `<nim-judge-model-id>` (family ≠ coder) | google `gemini-3.1-pro-preview` |
| embeddings | google `gemini-embedding-2` (unchanged, no re-index) | — |

The NIM and Groq ids are placeholders: I don't invent model ids. Until they are filled in, each role runs on its
Gemini fallback, which is the same Gemini models as before this change.

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

## Not verified / blocked

- **No live NIM or Groq call yet:** `NVIDIA_API_KEY` and `GROQ_API_KEY` are not set. Add them, run `pnpm qa doctor`
  to list the models, pick ids, then run `pnpm qa doctor --live`.
- The forced-429 manual check against a real provider (NIM RPM 1, `maxWaitMs: 0`) waits on the keys. Failover is
  covered by unit tests only.
