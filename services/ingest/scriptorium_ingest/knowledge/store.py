"""Per-professor knowledge-store paths (Sprint 3 Pass 1). One entity graph
per professor, persisted next to the SQLite DB — same "no Docker, local
files" convention as everything else in data/ (config.py:DATA_DIR)."""
from __future__ import annotations
from pathlib import Path

from ..config import DATA_DIR
from .graph import UndirectedGraph

KNOWLEDGE_DIR = DATA_DIR / "knowledge"


def graph_path(professor_id: str = "default") -> Path:
    return KNOWLEDGE_DIR / professor_id / "graph.dill"


def load_graph(professor_id: str = "default") -> UndirectedGraph:
    return UndirectedGraph(path=graph_path(professor_id))


def save_graph(graph: UndirectedGraph) -> None:
    graph.dump()
