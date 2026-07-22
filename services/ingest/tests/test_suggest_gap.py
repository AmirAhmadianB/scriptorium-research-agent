"""Sprint 4 (C3) gate (fast/mocked slice): suggest_gap() grounds a
researcher's statement without rewriting it, produces the same record
shape brainstorm_gaps() does (source='researcher'), and never fabricates
support it didn't find. The live end-to-end path (real corpus + real
graph + real LLM grounding call) was run manually against the dev server;
see docs/DASHBOARD-CORRECTIONS-SPRINT4-PASS0.md."""
from __future__ import annotations
import json

import pytest
import scriptorium_ingest.analyze.proposal_orchestrator as po


def _stub_session(monkeypatch, existing_gaps=None):
    session = {
        "id": 42, "professorId": "default", "status": "idle",
        "context": {"funding": {"opportunity": {"program": "P", "sponsor": "S", "eligibility": None}},
                     "corpus": {"synthesis": None}, "researchFocus": {"keywords": ["widgets"], "focusSynthesis": None}},
        "state": {"gaps": existing_gaps or []},
    }
    monkeypatch.setattr(po, "_load_session", lambda c, sid: session)
    monkeypatch.setattr(po, "_save_session", lambda c, sid, status, state: session.update(
        {"status": status, "state": state}))
    monkeypatch.setattr(po, "conn", lambda: _NullConn())
    return session


class _NullConn:
    def __enter__(self): return None
    def __exit__(self, *a): return False


def test_suggest_gap_stores_statement_verbatim_not_llm_rewritten(monkeypatch):
    _stub_session(monkeypatch)
    # suggest_gap() does `from .corpus_ingest import query_corpus` INSIDE the
    # function (a local import, avoiding a module-load-time cycle) — patch
    # the source module so that late-binding import picks up the stub.
    import scriptorium_ingest.analyze.corpus_ingest as ci
    monkeypatch.setattr(ci, "query_corpus", lambda *a, **k: [])
    monkeypatch.setattr(po, "load_graph", lambda pid: _EmptyGraph())
    monkeypatch.setattr(po, "complete", lambda prompt, model: json.dumps({
        "citedSources": [], "rationale": "some rationale", "overlapFlag": False, "overlapExplanation": "",
    }))

    result = po.suggest_gap(42, "  My own hypothesis about widget fatigue.  ")

    assert result["gap"]["gap"] == "My own hypothesis about widget fatigue."
    assert result["gap"]["source"] == "researcher"
    assert result["gap"]["researcherAnswer"] is None


def test_suggest_gap_requires_a_nonempty_statement(monkeypatch):
    _stub_session(monkeypatch)
    with pytest.raises(ValueError):
        po.suggest_gap(42, "   ")


def test_suggest_gap_surfaces_overlap_flag_honestly(monkeypatch):
    _stub_session(monkeypatch)
    import scriptorium_ingest.analyze.corpus_ingest as ci
    monkeypatch.setattr(ci, "query_corpus", lambda *a, **k: [
        {"paperId": 1, "paperTitle": "Widget Fatigue Already Solved", "score": 0.9, "snippet": "...", "sectionHead": "Results"},
    ])
    monkeypatch.setattr(po, "load_graph", lambda pid: _EmptyGraph())
    monkeypatch.setattr(po, "complete", lambda prompt, model: json.dumps({
        "citedSources": ["Widget Fatigue Already Solved"], "rationale": "already covered",
        "overlapFlag": True, "overlapExplanation": "Widget Fatigue Already Solved addresses this directly.",
    }))

    result = po.suggest_gap(42, "Widgets fatigue under cyclic load.")

    assert result["groundingReport"]["overlapFlag"] is True
    assert "Widget Fatigue Already Solved" in result["groundingReport"]["overlapExplanation"]
    assert len(result["groundingReport"]["supportingPapers"]) == 1


def test_suggest_gap_appends_to_existing_gaps_with_a_fresh_id(monkeypatch):
    existing = [{"id": 0, "gap": "agent gap", "citedSources": [], "rationale": "", "researcherAnswer": None, "source": "agent"}]
    _stub_session(monkeypatch, existing_gaps=existing)
    import scriptorium_ingest.analyze.corpus_ingest as ci
    monkeypatch.setattr(ci, "query_corpus", lambda *a, **k: [])
    monkeypatch.setattr(po, "load_graph", lambda pid: _EmptyGraph())
    monkeypatch.setattr(po, "complete", lambda prompt, model: json.dumps({
        "citedSources": [], "rationale": "", "overlapFlag": False, "overlapExplanation": "",
    }))

    result = po.suggest_gap(42, "A new researcher gap.")

    assert result["gap"]["id"] == 1  # continues after the existing agent gap's id=0
    assert len(result["status"]) > 0


class _EmptyGraph:
    def size(self): return 0
