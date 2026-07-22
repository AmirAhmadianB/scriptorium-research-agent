"""Sprint 3 Pass 3 gate (fast/mocked slice): a call returns content and a
logged cost figure; failover switches to config/models.yaml's `default`
model on error. The live end-to-end call (real claude CLI) is in
tests_live/test_llm_backend_live.py, per the tests/ vs tests_live/ split."""
from __future__ import annotations
import pytest

from scriptorium_ingest.llm.backend import ClaudeCliBackend, estimate_tokens, chat_token_limit, supports_response_schema
from scriptorium_ingest.llm.cost import LoopCostTracker
from scriptorium_ingest.llm.json_parser import JSONParser
from scriptorium_ingest.claude_cli import ClaudeCliError


def test_complete_for_task_returns_content_and_records_cost(monkeypatch):
    import scriptorium_ingest.llm.backend as backend_mod
    monkeypatch.setattr(backend_mod, "complete", lambda prompt, model, timeout=180: f"echo:{prompt}")

    tracker = LoopCostTracker()
    backend = ClaudeCliBackend(cost_tracker=tracker)
    result = backend.complete_for_task("hello", task="metadata_cleanup")

    assert result.content == "echo:hello"
    assert result.fallback_used is False
    assert result.estimated_input_tokens > 0

    summary = tracker.summary()
    assert summary["call_count"] == 1
    assert summary["estimated_cost_usd"] == 0.0
    assert "cost_model" in summary


def test_complete_for_task_fails_over_to_default_model_on_error(monkeypatch):
    import scriptorium_ingest.llm.backend as backend_mod

    calls = []

    def fake_complete(prompt, model, timeout=180):
        calls.append(model)
        if len(calls) == 1:
            raise ClaudeCliError("simulated transient failure, retries exhausted")
        return "recovered on fallback model"

    monkeypatch.setattr(backend_mod, "complete", fake_complete)

    tracker = LoopCostTracker()
    backend = ClaudeCliBackend(cost_tracker=tracker)
    result = backend.complete_for_task("hello", task="crawl_extraction")

    assert result.content == "recovered on fallback model"
    assert result.fallback_used is True
    assert len(calls) == 2
    assert calls[0] != calls[1]
    assert tracker.summary()["fallback_count"] == 1


def test_complete_for_task_raises_when_fallback_also_fails(monkeypatch):
    import scriptorium_ingest.llm.backend as backend_mod

    def always_fails(prompt, model, timeout=180):
        raise ClaudeCliError("down")

    monkeypatch.setattr(backend_mod, "complete", always_fails)

    backend = ClaudeCliBackend()
    with pytest.raises(ClaudeCliError):
        backend.complete_for_task("hello", task="crawl_extraction")


def test_capability_helpers_are_honest_not_fabricated():
    assert chat_token_limit("claude-sonnet-4-6") == 200_000
    assert chat_token_limit("some-unknown-future-model") == 200_000  # safe default, not a crash
    assert supports_response_schema("claude-sonnet-4-6") is False  # CLI has no schema mode


def test_estimate_tokens_is_a_rough_proxy_not_a_real_count():
    assert estimate_tokens("") >= 1
    assert estimate_tokens("a" * 400) == 100


def test_json_parser_handles_fenced_and_python_style_output():
    parser = JSONParser()
    assert parser.parse_obj('```json\n{"a": 1}\n```') == {"a": 1}
    # Python-style booleans (a model occasionally emits these instead of
    # lowercase JSON booleans) inside an otherwise-valid-looking blob:
    assert parser.parse_obj('{"ok": True, "val": None}') == {"ok": True, "val": None}
    # Extra trailing prose after a valid JSON object:
    assert parser.parse_obj('{"a": 1} — that is the answer.') == {"a": 1}
