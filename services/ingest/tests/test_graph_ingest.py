"""Sprint 3 Pass 2 gate (fast/isolated slice): populate_graph_for_paper adds
a paper node plus its concept nodes and connects them, using the concepts
column directly (no LLM call needed when concepts are already present —
the common case for OpenAlex-sourced papers). The live end-to-end path
(scan_pdf_folder -> entity extraction for concept-less papers -> graph
persistence) was run manually against the real corpus; see
docs/RD-AGENT-EXTRACTION-PASS0.md's Pass 2 note. The Azure Document
Intelligence toggle is exercised directly here since it needs no network
or LLM call to prove it degrades cleanly both ways."""
from __future__ import annotations
import os

from scriptorium_ingest.knowledge.graph import UndirectedGraph
from scriptorium_ingest.knowledge.ingest import populate_graph_for_paper


def test_populate_graph_for_paper_uses_existing_concepts_no_llm_call():
    graph = UndirectedGraph()
    paper = {"id": 1, "title": "A Study of Widgets", "abstract": "widgets are great",
             "concepts": ["widget design", "materials science"], "structured_summary": None}

    added = populate_graph_for_paper(graph, paper)

    assert added == 2
    paper_node = next(n for n in graph.get_all_nodes() if n.label == "paper")
    assert {n.content for n in paper_node.neighbors} == {"widget design", "materials science"}


def test_populate_graph_for_paper_falls_back_to_extraction_when_concepts_missing(monkeypatch):
    """No concepts column (e.g. an uploaded PDF, not OpenAlex-sourced) ->
    populate_graph_for_paper must call extract_entities. Stub it so this
    fast test never shells out to the real claude CLI (tests/ vs
    tests_live/ split — see conftest.py's docstring convention)."""
    import scriptorium_ingest.knowledge.ingest as ingest_mod
    monkeypatch.setattr(ingest_mod, "extract_entities", lambda *a, **k: ["stubbed concept"])

    graph = UndirectedGraph()
    paper = {"id": 2, "title": "Untitled", "abstract": "", "concepts": [], "structured_summary": None}
    added = populate_graph_for_paper(graph, paper)

    assert added == 1
    paper_node = next(n for n in graph.get_all_nodes() if n.label == "paper")
    assert {n.content for n in paper_node.neighbors} == {"stubbed concept"}


def test_extract_entities_returns_empty_list_on_unparseable_response(monkeypatch):
    """Never fabricates a node from unparseable LLM output."""
    import scriptorium_ingest.knowledge.ingest as ingest_mod
    monkeypatch.setattr(ingest_mod, "complete", lambda *a, **k: "not json")
    assert ingest_mod.extract_entities("t", "a", None) == []


def test_azure_document_intelligence_toggle_unconfigured_degrades_to_empty():
    from scriptorium_ingest.parse.pdf_parser import _ocr_via_azure
    os.environ.pop("AZURE_DOC_INTEL_KEY", None)
    os.environ.pop("AZURE_DOC_INTEL_ENDPOINT", None)
    assert _ocr_via_azure("nonexistent.pdf", 1) == ""


def test_azure_document_intelligence_toggle_configured_but_unreachable_degrades_to_empty():
    from scriptorium_ingest.parse.pdf_parser import _ocr_via_azure
    os.environ["AZURE_DOC_INTEL_KEY"] = "fake-key"
    os.environ["AZURE_DOC_INTEL_ENDPOINT"] = "https://example.invalid"
    try:
        assert _ocr_via_azure("nonexistent.pdf", 1) == ""
    finally:
        os.environ.pop("AZURE_DOC_INTEL_KEY", None)
        os.environ.pop("AZURE_DOC_INTEL_ENDPOINT", None)
