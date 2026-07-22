"""Sprint 3 Pass 3 gate — real claude CLI call, not mocked. Run explicitly:
pytest tests_live/test_llm_backend_live.py -v (excluded from the fast
suite's testpaths, same convention as test_ask_corpus_harness.py)."""
from __future__ import annotations

from scriptorium_ingest.llm.backend import ClaudeCliBackend
from scriptorium_ingest.llm.cost import LoopCostTracker


def test_live_call_returns_content_and_a_logged_cost_figure():
    tracker = LoopCostTracker()
    backend = ClaudeCliBackend(cost_tracker=tracker)

    result = backend.complete_for_task("Reply with exactly the word: pong", task="metadata_cleanup")

    assert "pong" in result.content.lower()
    assert result.model  # a real configured model string, not empty
    assert result.duration_seconds > 0

    summary = tracker.summary()
    assert summary["call_count"] == 1
    assert summary["total_duration_seconds"] > 0
    assert summary["estimated_cost_usd"] == 0.0  # honest — see llm/cost.py docstring
