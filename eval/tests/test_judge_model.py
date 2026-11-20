"""Smoke tests for the OpenAI-compatible DeepEval judge (no network: a fake OpenAI client)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import BaseModel

from qa_eval.judge_model import Endpoint, OpenAICompatibleJudge, ProviderLimiter, RateLimited, load_chain_from_env

NIM = Endpoint("nvidia-nim", "https://integrate.api.nvidia.com/v1", "qwen/qwen3-235b-a22b", "NVIDIA_API_KEY", rpm=40)
GEMINI = Endpoint(
    "google", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.1-pro-preview", "GOOGLE_API_KEY", rpm=15
)
ENV = {"NVIDIA_API_KEY": "nvapi-test", "GOOGLE_API_KEY": "AIza-test"}


class Http429(Exception):
    status_code = 429

    def __init__(self) -> None:
        super().__init__("429 Too Many Requests")
        self.response = SimpleNamespace(headers={"retry-after": "9"})


def fake_factory(script: dict[str, list[Any]], calls: list[str]):
    def factory(endpoint: Endpoint, key: str) -> Any:
        assert key == ENV[endpoint.api_key_env or ""]

        def create(model: str, messages: list[dict[str, str]], temperature: float) -> Any:
            calls.append(endpoint.label)
            step = script[endpoint.label].pop(0)
            if isinstance(step, Exception):
                raise step
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=step))],
                usage=SimpleNamespace(total_tokens=42),
            )

        return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))

    return factory


class Verdict(BaseModel):
    score: float
    reason: str


def test_answers_from_primary_and_reports_its_name() -> None:
    calls: list[str] = []
    judge = OpenAICompatibleJudge([NIM, GEMINI], env=ENV, client_factory=fake_factory({NIM.label: ["ok"]}, calls))
    assert judge.generate("rate this") == "ok"
    assert judge.get_model_name() == "nvidia-nim/qwen/qwen3-235b-a22b"


def test_fails_over_to_gemini_on_429_and_skips_nim_while_cooling_down() -> None:
    calls: list[str] = []
    script = {NIM.label: [Http429()], GEMINI.label: ['<think>hm</think>{"score": 0.9, "reason": "grounded"}', "second"]}
    judge = OpenAICompatibleJudge([NIM, GEMINI], env=ENV, client_factory=fake_factory(script, calls), sleep=lambda s: None)
    verdict = judge.generate("rate this", schema=Verdict)
    assert verdict == Verdict(score=0.9, reason="grounded")
    assert judge.get_model_name() == "google/gemini-3.1-pro-preview"
    # NIM is cooling down (Retry-After 9 s): the next call goes straight to Gemini, no NIM request.
    assert judge.generate("again") == "second"
    assert calls == [NIM.label, GEMINI.label, GEMINI.label]
    assert judge.attempts[0]["outcome"].startswith("RATE_LIMITED: HTTP 429")


def test_every_model_failing_raises() -> None:
    calls: list[str] = []
    script = {NIM.label: [RuntimeError("boom")], GEMINI.label: [RuntimeError("boom")]}
    judge = OpenAICompatibleJudge([NIM, GEMINI], env=ENV, client_factory=fake_factory(script, calls))
    with pytest.raises(RuntimeError, match="every judge model failed"):
        judge.generate("x")


def test_limiter_fails_fast_beyond_max_wait_and_waits_when_short() -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    lim = ProviderLimiter("groq", rpm=1, tpm=None, clock=lambda: now[0], sleep=sleep)
    lim.acquire(10, max_wait_s=20)
    with pytest.raises(RateLimited):
        lim.acquire(10, max_wait_s=20)
    lim.acquire(10, max_wait_s=61)
    assert slept and slept[0] >= 59


def test_chain_comes_from_env_without_keys() -> None:
    raw = json.dumps([{"provider": "nvidia-nim", "baseURL": NIM.base_url, "model": NIM.model, "apiKeyEnv": "NVIDIA_API_KEY"}])
    chain = load_chain_from_env({"QA_JUDGE_CHAIN": raw})
    assert chain[0].label == NIM.label and chain[0].api_key_env == "NVIDIA_API_KEY"
    with pytest.raises(RuntimeError, match="QA_JUDGE_CHAIN is not set"):
        load_chain_from_env({})
