"""DeepEval judge model over OpenAI-compatible endpoints (PLAN.md section 9).

The TS side (src/eval/judgeEndpoint.ts) resolves the `judge` role chain from config/models.yaml and starts this
sidecar with:
  QA_JUDGE_CHAIN  JSON list of {provider, baseURL, model, apiKeyEnv?, requestsPerMinute?, tokensPerMinute?}
  <apiKeyEnv>     one env var per key the chain needs (never inside QA_JUDGE_CHAIN, never logged)

The judge tries the chain in order (e.g. NVIDIA NIM, then Gemini through its OpenAI-compatible endpoint), keeps
each provider within its requests/tokens per minute, fails over on HTTP 429 or a provider error, and reports the
model that actually answered via get_model_name() so eval scores are labelled honestly.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Optional

# No DeepEval telemetry: nothing about runs leaves the machine except the judge calls themselves (rule 14).
os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")

try:  # DeepEval is the runtime base class; tests can run without it installed.
    from deepeval.models import DeepEvalBaseLLM
except ImportError:  # pragma: no cover - exercised only without deepeval

    class DeepEvalBaseLLM:  # type: ignore[no-redef]
        def __init__(self, model: Optional[str] = None, *args: Any, **kwargs: Any) -> None:
            self.model = self.load_model(*args, **kwargs)


WINDOW_S = 60.0
DEFAULT_MAX_WAIT_S = 20.0
LAST_IN_CHAIN_MAX_WAIT_S = 61.0
DEFAULT_429_COOLDOWN_S = 30.0
_THINK = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)


@dataclass(frozen=True)
class Endpoint:
    provider: str
    base_url: str
    model: str
    api_key_env: Optional[str] = None
    rpm: Optional[int] = None
    tpm: Optional[int] = None

    @property
    def label(self) -> str:
        return f"{self.provider}/{self.model}"


class RateLimited(Exception):
    """A provider is out of quota or cooling down after HTTP 429; the caller fails over."""

    def __init__(self, message: str, retry_after_s: float) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class ProviderLimiter:
    """Sliding 60 s window of (time, tokens) per provider, plus a cooldown after HTTP 429. Thread-safe."""

    def __init__(
        self,
        name: str,
        rpm: Optional[int],
        tpm: Optional[int],
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.name, self.rpm, self.tpm = name, rpm, tpm
        self._clock, self._sleep = clock, sleep
        self._window: deque[list[float]] = deque()
        self._cooldown_until = 0.0
        self._lock = threading.Lock()

    def _wait_for(self, now: float, tokens: int) -> float:
        while self._window and now - self._window[0][0] >= WINDOW_S:
            self._window.popleft()
        wait = max(0.0, self._cooldown_until - now)
        if self.rpm is not None and len(self._window) >= self.rpm:
            gate = self._window[len(self._window) - self.rpm]
            wait = max(wait, gate[0] + WINDOW_S - now)
        if self.tpm is not None:
            used = sum(e[1] for e in self._window)
            for e in self._window:
                if used + tokens <= self.tpm:
                    break
                used -= e[1]
                wait = max(wait, e[0] + WINDOW_S - now)
        return wait

    def acquire(self, tokens: int, max_wait_s: float, wait_on_cooldown: bool = False) -> list[float]:
        """Reserve a request. During a 429 cooldown this fails at once unless wait_on_cooldown (last in chain)."""
        with self._lock:
            cooling = self._cooldown_until - self._clock()
        if cooling > 0 and not wait_on_cooldown:
            raise RateLimited(f"{self.name}: cooling down after HTTP 429 ({cooling:.0f} s left)", cooling)
        if self.tpm is not None and tokens > self.tpm:
            raise RateLimited(f"{self.name}: request needs ~{tokens} tokens, more than its {self.tpm}/min", WINDOW_S)
        while True:
            with self._lock:
                now = self._clock()
                wait = self._wait_for(now, tokens)
                if wait <= 0:
                    ticket = [now, float(tokens)]
                    self._window.append(ticket)
                    return ticket
            if wait > max_wait_s:
                raise RateLimited(f"{self.name}: rate limited (next slot in {wait:.0f} s)", wait)
            self._sleep(wait)

    def settle(self, ticket: list[float], tokens: int) -> None:
        with self._lock:
            ticket[1] = float(tokens)

    def cooldown(self, seconds: float) -> None:
        with self._lock:
            self._cooldown_until = max(self._cooldown_until, self._clock() + seconds)


def load_chain_from_env(env: Optional[dict[str, str]] = None) -> list[Endpoint]:
    raw = (env if env is not None else os.environ).get("QA_JUDGE_CHAIN")
    if not raw:
        raise RuntimeError("QA_JUDGE_CHAIN is not set (the sidecar is started by src/eval/judgeEndpoint.ts)")
    chain = [
        Endpoint(
            provider=str(e["provider"]),
            base_url=str(e["baseURL"]),
            model=str(e["model"]),
            api_key_env=e.get("apiKeyEnv"),
            rpm=e.get("requestsPerMinute"),
            tpm=e.get("tokensPerMinute"),
        )
        for e in json.loads(raw)
    ]
    if not chain:
        raise RuntimeError("QA_JUDGE_CHAIN is empty: no usable judge model (check qa doctor)")
    return chain


def _status(err: BaseException) -> Optional[int]:
    code = getattr(err, "status_code", None) or getattr(err, "status", None)
    return code if isinstance(code, int) else None


def _retry_after_s(err: BaseException) -> float:
    headers = getattr(getattr(err, "response", None), "headers", None) or getattr(err, "headers", None) or {}
    try:
        ms = headers.get("retry-after-ms")
        if ms is not None:
            return min(600.0, max(1.0, float(ms) / 1000))
        ra = headers.get("retry-after")
        if ra is not None:
            return min(600.0, max(1.0, float(ra)))
    except (TypeError, ValueError, AttributeError):
        pass
    return DEFAULT_429_COOLDOWN_S


def _openai_client(endpoint: Endpoint, api_key: str) -> Any:
    from openai import OpenAI

    return OpenAI(base_url=endpoint.base_url, api_key=api_key, max_retries=0, timeout=120)


def extract_json(text: str) -> str:
    """The JSON part of a reply (drops <think> blocks and markdown fences)."""
    t = _THINK.sub("", text).strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.IGNORECASE)
    if fenced:
        return fenced.group(1).strip()
    start = min((i for i in (t.find("{"), t.find("[")) if i >= 0), default=-1)
    if start < 0:
        return t
    end = t.rfind("}" if t[start] == "{" else "]")
    return t[start : end + 1] if end > start else t


class OpenAICompatibleJudge(DeepEvalBaseLLM):
    """DeepEval custom model: the `judge` role chain over OpenAI-compatible endpoints with failover on 429."""

    def __init__(
        self,
        chain: Optional[list[Endpoint]] = None,
        *,
        env: Optional[dict[str, str]] = None,
        client_factory: Callable[[Endpoint, str], Any] = _openai_client,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
        max_wait_s: float = DEFAULT_MAX_WAIT_S,
    ) -> None:
        self._env = env if env is not None else dict(os.environ)
        self.chain = chain if chain is not None else load_chain_from_env(self._env)
        self._client_factory = client_factory
        self._clients: dict[Endpoint, Any] = {}
        self._max_wait_s = max_wait_s
        self._limiters: dict[str, ProviderLimiter] = {}
        for e in self.chain:
            if e.provider not in self._limiters:
                self._limiters[e.provider] = ProviderLimiter(e.provider, e.rpm, e.tpm, clock, sleep)
        self.last_model: Optional[str] = None
        self.attempts: list[dict[str, str]] = []
        super().__init__(self.chain[0].label)

    # --- DeepEvalBaseLLM interface ---------------------------------------------------------------
    def load_model(self, *args: Any, **kwargs: Any) -> "OpenAICompatibleJudge":
        return self

    def get_model_name(self) -> str:
        return self.last_model or self.chain[0].label

    def generate(self, prompt: str, schema: Any = None) -> Any:
        text = self._complete(prompt)
        if schema is not None:
            return schema.model_validate_json(extract_json(text))
        return _THINK.sub("", text).strip()

    async def a_generate(self, prompt: str, schema: Any = None) -> Any:
        return await asyncio.to_thread(self.generate, prompt, schema)

    # --- chain -----------------------------------------------------------------------------------
    def _client(self, e: Endpoint) -> Any:
        if e not in self._clients:
            key = self._env.get(e.api_key_env, "") if e.api_key_env else "unused"
            if not key:
                raise RuntimeError(f"{e.label}: {e.api_key_env} is not set")
            self._clients[e] = self._client_factory(e, key)
        return self._clients[e]

    def _complete(self, prompt: str) -> str:
        estimate = len(prompt) // 4 + 1024
        last_err: Optional[BaseException] = None
        for i, e in enumerate(self.chain):
            limiter = self._limiters[e.provider]
            is_last = i == len(self.chain) - 1
            try:
                max_wait = max(self._max_wait_s, LAST_IN_CHAIN_MAX_WAIT_S) if is_last else self._max_wait_s
                ticket = limiter.acquire(estimate, max_wait, wait_on_cooldown=is_last)
                res = self._client(e).chat.completions.create(
                    model=e.model, messages=[{"role": "user", "content": prompt}], temperature=0
                )
                usage = getattr(res, "usage", None)
                total = getattr(usage, "total_tokens", None)
                limiter.settle(ticket, int(total) if isinstance(total, int) else estimate)
                text = res.choices[0].message.content or ""
                self.last_model = e.label
                self.attempts.append({"model": e.label, "outcome": "OK"})
                return text
            except RateLimited as err:
                self.attempts.append({"model": e.label, "outcome": f"RATE_LIMITED: {err}"})
                last_err = err
            except Exception as err:  # provider error → next model (secrets are never in these messages)
                if _status(err) == 429:
                    wait = _retry_after_s(err)
                    limiter.cooldown(wait)
                    outcome = f"RATE_LIMITED: HTTP 429, cooling down {wait:.0f} s"
                    self.attempts.append({"model": e.label, "outcome": outcome})
                else:
                    self.attempts.append({"model": e.label, "outcome": f"ERROR: {type(err).__name__}"})
                last_err = err
        raise RuntimeError(f"every judge model failed: {self.attempts}") from last_err
