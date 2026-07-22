"""Sprint 3 Pass 2 — wires ingestion into BOTH stores. Reuses the existing
pipeline for everything that already exists (library/watch_folder.py's
scan_pdf_folder for getting PDFs into the papers table, analyze/paper_analyst.py
for chunking+embedding into the corpus vector store); the only genuinely new
step is populating the entity graph, since nothing did that before this pass.

Run: python -m scriptorium_ingest.knowledge.ingest [--professor-id default] [--limit N]
"""
from __future__ import annotations
import json
import re

from ..llm.dispatch import complete
from ..config import task_model
from ..db import conn, log_run, mark_graph_populated, papers_needing_graph_population
from ..library.watch_folder import scan_pdf_folder
from .graph import UndirectedNode
from .store import load_graph, save_graph

ENTITY_PROMPT = """Extract 4-8 concise topical concepts/entities from this paper — the \
specific methods, phenomena, materials, or techniques it is ABOUT, not generic words \
like "research" or "analysis". Each entry should be a short noun phrase (2-6 words), \
suitable as a node label in a concept graph connecting this paper to related work.

Title: {title}
Abstract: {abstract}
Known gaps this paper surfaces (if any): {gaps}

Return ONLY a JSON array of strings, no prose, no markdown fences."""


def extract_entities(title: str, abstract: str, structured_summary: dict | None) -> list[str]:
    gaps = ", ".join((structured_summary or {}).get("gaps", []) or []) or "(none)"
    cfg = task_model("entity_extraction")
    text = complete(
        ENTITY_PROMPT.format(title=title, abstract=(abstract or "")[:2000], gaps=gaps),
        model=cfg["model"],
    )
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        entities = json.loads(text)
        return [e.strip() for e in entities if isinstance(e, str) and e.strip()][:8]
    except json.JSONDecodeError:
        return []


def populate_graph_for_paper(graph, paper: dict) -> int:
    """Hub-and-spoke: the paper is the connecting node for its own concepts.
    Two concepts from DIFFERENT papers with no shared paper are then >2 hops
    apart until some other paper bridges them — exactly the structural
    signal get_nodes_intersection/n-hop is meant to surface (Pass 4)."""
    concepts = paper.get("concepts") or []
    if not concepts:
        concepts = extract_entities(paper["title"], paper.get("abstract", ""), paper.get("structured_summary"))
    if not concepts:
        return 0

    paper_node = UndirectedNode(content=paper["title"], label="paper", appendix={"paperId": paper["id"]})
    concept_nodes = [UndirectedNode(content=c, label="concept") for c in concepts]
    graph.add_nodes(paper_node, concept_nodes)
    return len(concepts)


def ingest_folder(professor_id: str = "default", limit: int | None = None) -> dict:
    scan_result = scan_pdf_folder()

    graph = load_graph(professor_id)
    populated = 0
    total_concepts = 0
    with conn() as c:
        papers = papers_needing_graph_population(c, limit=limit)
        for paper in papers:
            total_concepts += populate_graph_for_paper(graph, paper)
            mark_graph_populated(c, paper["id"])
            populated += 1
        save_graph(graph)
        summary = {
            "pdf_folder_scan": scan_result,
            "graph_populated": populated,
            "concepts_added": total_concepts,
            "graph_size": graph.size(),
        }
        log_run(c, "graph_ingest", summary)
    return summary


def main() -> None:
    import argparse
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("--professor-id", default="default")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    print(json.dumps(ingest_folder(args.professor_id, args.limit), indent=2))


if __name__ == "__main__":
    main()
