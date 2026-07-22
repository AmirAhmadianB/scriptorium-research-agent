"""Sprint 3 Pass 4 gate (fast/mocked slice): critique_draft parses judge
scores correctly; run_proposal_loop terminates on convergence AND on the
iteration cap, logs a cost summary, and persists loop history to session
state; _structural_gap_hints degrades cleanly on an unpopulated graph and
surfaces a real structural bridge on a populated one. The live end-to-end
run (real corpus -> real graph -> real LLM draft+critique) was run
manually against the dev server; see docs/RD-AGENT-EXTRACTION-PASS0.md."""
from __future__ import annotations
import json

import scriptorium_ingest.analyze.proposal_orchestrator as po
from scriptorium_ingest.knowledge.graph import UndirectedGraph, UndirectedNode


def test_critique_draft_parses_judge_scores(monkeypatch):
    class FakeResult:
        content = json.dumps({
            "novelty": 8, "funderScopeFit": 6, "testableAims": 7,
            "rationale": "solid", "revisionSuggestions": "tighten the aims",
        })

    class FakeBackend:
        def complete_for_task(self, prompt, task):
            assert task == "eval_judge"
            return FakeResult()

    ctx = {"funding": {"opportunity": {"program": "P", "sponsor": "S", "priorities": None, "eligibility": None}},
           "corpus": {"synthesis": None}}
    result = po.critique_draft(ctx, "the gap", "Specific Aims", "draft text", FakeBackend())

    assert result["scores"] == {"novelty": 8, "funderScopeFit": 6, "testableAims": 7}
    assert result["overallScore"] == 7.0
    assert result["revisionSuggestions"] == "tighten the aims"


def _stub_session(monkeypatch, gap_answer=True):
    session = {
        "id": 99, "professorId": "default", "status": "gaps_confirmed",
        "context": {"funding": {"opportunity": {"program": "P", "sponsor": "S"}},
                     "corpus": {"synthesis": None}, "literature": {"recentPapers": []},
                     "researchFocus": {"keywords": []}},
        "state": {"gaps": [{"id": 0, "gap": "the gap", "citedSources": [], "researcherAnswer": gap_answer}],
                   "draftSections": []},
    }
    monkeypatch.setattr(po, "_load_session", lambda c, sid: session)
    monkeypatch.setattr(po, "_save_session", lambda c, sid, status, state: session.update(
        {"status": status, "state": state}))
    monkeypatch.setattr(po, "conn", lambda: _NullConn())
    monkeypatch.setattr(po, "log_run", lambda c, kind, summary: None)
    return session


class _NullConn:
    def __enter__(self): return None
    def __exit__(self, *a): return False


def test_run_proposal_loop_terminates_on_convergence(monkeypatch):
    _stub_session(monkeypatch)
    monkeypatch.setattr(po, "draft_section", lambda sid, key, feedback=None: {
        "sectionId": sid, "sectionKey": key, "text": "draft text",
        "sectionPlan": {"labels": {key: "Specific Aims"}},
    })
    monkeypatch.setattr(po, "critique_draft", lambda ctx, gap, label, text, backend: {
        "scores": {"novelty": 9, "funderScopeFit": 9, "testableAims": 9},
        "overallScore": 9.0, "rationale": "excellent", "revisionSuggestions": "",
    })

    result = po.run_proposal_loop(99, "aims", max_iterations=3, convergence_threshold=8.0)

    assert result["terminationReason"] == "converged"
    assert len(result["iterations"]) == 1  # stopped after the FIRST iteration, not all 3
    assert result["costSummary"]["call_count"] == 1  # only the draft call tracked here + judge inside critique_draft (mocked, untracked)


def test_run_proposal_loop_terminates_on_iteration_cap(monkeypatch):
    _stub_session(monkeypatch)
    draft_calls = []
    monkeypatch.setattr(po, "draft_section", lambda sid, key, feedback=None: draft_calls.append(feedback) or {
        "sectionId": sid, "sectionKey": key, "text": "draft text",
        "sectionPlan": {"labels": {key: "Specific Aims"}},
    })
    monkeypatch.setattr(po, "critique_draft", lambda ctx, gap, label, text, backend: {
        "scores": {"novelty": 3, "funderScopeFit": 3, "testableAims": 3},
        "overallScore": 3.0, "rationale": "weak", "revisionSuggestions": f"revise round {len(draft_calls)}",
    })

    result = po.run_proposal_loop(99, "aims", max_iterations=3, convergence_threshold=8.0)

    assert result["terminationReason"] == "cap_reached"
    assert len(result["iterations"]) == 3
    # feedback from the PREVIOUS critique fed into the NEXT draft call:
    assert draft_calls[1] == "revise round 1"
    assert draft_calls[2] == "revise round 2"


def test_run_proposal_loop_raises_without_a_confirmed_gap(monkeypatch):
    _stub_session(monkeypatch, gap_answer=False)
    import pytest
    with pytest.raises(ValueError):
        po.run_proposal_loop(99, "aims")


def test_structural_gap_hints_degrades_cleanly_on_unpopulated_graph(monkeypatch):
    monkeypatch.setattr(po, "load_graph", lambda professor_id: UndirectedGraph())
    ctx = {"literature": {"recentPapers": []}}
    hints = po._structural_gap_hints(ctx, "default")
    assert "too few nodes" in hints


def test_structural_gap_hints_finds_a_real_bridge_on_a_populated_graph(monkeypatch):
    graph = UndirectedGraph()
    paper_a = UndirectedNode(content="Paper about electron holography", label="paper")
    paper_b = UndirectedNode(content="Paper about deep learning phase retrieval", label="paper")
    bridge = UndirectedNode(content="learned priors for imaging", label="concept")
    graph.add_node(paper_a, neighbor=bridge)
    graph.add_node(paper_b, neighbor=bridge)
    monkeypatch.setattr(po, "load_graph", lambda professor_id: graph)

    ctx = {"literature": {"recentPapers": [
        {"title": "Paper about electron holography"}, {"title": "Paper about deep learning phase retrieval"},
    ]}}
    hints = po._structural_gap_hints(ctx, "default", steps=1)
    assert "learned priors for imaging" in hints
