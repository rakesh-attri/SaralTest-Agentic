# AI & embedding configuration

How sf-qa-agent reaches language models, how a role fails over between providers, and how rate limits are kept.
Agents never pick a provider: they ask `ModelRouter` for a role (`reasoning`, `coder`, `fast`, `judge`, CLAUDE.md rule 8).

Source: `src/models/router.ts`, `src/models/rateLimiter.ts`, `src/models/guarded.ts`, `src/models/endpoints.ts`,
`src/models/providers/index.ts`, `src/agents/shared/structured.ts`, `src/eval/judgeEndpoint.ts`.
Config: `config/models.yaml` (copy from `config/models.example.yaml`), keys in Windows Credential Manager or `.env`.

## Providers

| Provider | Endpoint | Key |
|---|---|---|
| `google` | Gemini API | `GOOGLE_API_KEY` |
| `nvidia-nim` | preset of `openai-compatible`: `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `groq` | preset of `openai-compatible`: `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `openai-compatible` | `endpoints.openai-compatible.baseURL` or `OPENAI_COMPATIBLE_BASE_URL` | `OPENAI_COMPATIBLE_API_KEY` (or `apiKeyEnv`) |
| `anthropic`, `openai`, `azure-openai`, `ollama`, `mock` | as before | as before |

OpenAI-compatible providers use LangChain's `ChatOpenAICompletions` (Chat Completions, never the Responses API).
A preset can be overridden, e.g. a self-hosted NIM:

```yaml
endpoints:
  nvidia-nim: { baseURL: http://localhost:8000/v1 }
```

An API key only travels over `https://`; plain `http://` is accepted for `localhost` / `127.0.0.1` / `[::1]` only.
`apiKeyEnv` must name a key in `SECRET_ENV_KEYS`, so its value is masked and blocked from prompts like every other secret.

## Roles and fallback chains

Each role has a primary model and an optional `fallback` — one model or an ordered list:

```yaml
coder:
  provider: nvidia-nim
  model: <nim-coder-model-id>
  fallback:
    - { provider: groq, model: <groq-coder-model-id> }
    - { provider: google, model: gemini-3.5-flash-lite }
```

`runStructured` walks the chain: a provider error or rate limit moves to the next model at once; invalid output is
reflected back to the same model twice first (rule 2). `HARD_STOP` and `BUDGET` never fail over. Every result records
the model that actually answered (`StructuredResult.model`, `attempts[]`), and each failover is logged with
`from`, `to` and the reason.

Entries whose model id is still a `<placeholder>` or whose key is missing are skipped. `qa doctor` shows which
model a role currently runs on.

**Judge independence (rule 8).** The schema rejects a judge that shares a model with any entry of the coder's chain,
so a fallback can never make them equal. `qa doctor` warns when the judge and coder primaries come from the same
model family (`src/config/modelFamily.ts`: llama, qwen, gpt-oss, nemotron, deepseek, mistral, gemma, gemini, …).

**Tool calling.** Some hosted models reject tool calls. Mark them `tools: false`; agents then get the full skill
bodies in the system prompt instead of the `load_skill` tool. `qa doctor --live` probes tool calling for every model.

## Rate limits and 429 failover

Quotas are per provider and shared by all roles:

```yaml
quotas:
  nvidia-nim: { requestsPerMinute: 40 }
  groq: { requestsPerMinute: 30, tokensPerMinute: 6000 }
  google: { requestsPerMinute: 15 }
  # maxWaitMs (default 20000)
```

The values are conservative defaults; set them to your account's real limits. Before each call the guard reserves one
request and an estimated token count (prompt chars / 4 + up to 1024 output tokens). The estimate is corrected from the
provider's reported usage.

- When the slot is free, the call goes ahead.
- When the wait is ≤ `maxWaitMs`, the call waits.
- When the wait is longer, or one request alone exceeds the token quota, the call fails at once with a rate-limited
  `TRANSIENT` error, and the chain moves to the next provider.
- When a provider answers **HTTP 429**, it is put on cooldown for its `Retry-After` (30 s if none). Calls from any role
  then skip it without a request until the cooldown ends.
- The **last** model of a chain has nothing to fail over to: it waits out a cooldown or quota up to one minute,
  and after that the error goes to QA Lead triage (`TRANSIENT: [retry, fallback, escalate]` in `config/policy.yaml`).

## Picking model ids

```powershell
pnpm qa doctor
```

For each provider in use, doctor lists the models your key can call, grouped by namespace (e.g. `meta`, `qwen`,
`deepseek-ai`), and hides embedding/rerank/speech/guard ids. Put the ids you choose in `config/models.yaml`, then run:

```powershell
pnpm qa doctor --live
```

This makes one tiny call to every model of every chain and probes tool calling. No model ids are guessed in the
config.

## Embeddings

Embeddings stay on Google (`gemini-embedding-2`). The model id is stored with every vector, and changing it requires
`pnpm memory:reindex`. Chat provider changes never touch embeddings.

## DeepEval judge

The DeepEval sidecar (`eval/`, Python, `uv`) uses the **same judge chain**, all over the OpenAI-compatible protocol:
NIM / Groq directly, and Gemini through `https://generativelanguage.googleapis.com/v1beta/openai`.

- `resolveJudgeChain(config)` returns the chain with each provider's quotas.
- `judgeSidecarEnv()` builds the child-process env:
  - `QA_JUDGE_CHAIN`: JSON with key **names** only
  - one env var per key value
  - `DEEPEVAL_TELEMETRY_OPT_OUT=YES`
- `eval/qa_eval/judge_model.py` → `OpenAICompatibleJudge(DeepEvalBaseLLM)`:
  - applies the same RPM/TPM/cooldown rules
  - fails over on 429
  - reports the answering model through `get_model_name()`

The runner, metrics and gates come in Phase 8. To run the judge tests:

```powershell
cd eval; uv run --python 3.12 pytest -q
```
