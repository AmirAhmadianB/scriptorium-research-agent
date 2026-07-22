"""Persistence base for the knowledge stores (Sprint 3 Pass 1). Adapted from
microsoft/RD-Agent's rdagent/core/knowledge_base.py (MIT — see ../NOTICE);
the only change of substance is swapping RD-Agent's own logger for stdlib
logging, since nothing else in this module was coupled to rdagent.*.

dill (not stdlib pickle) because the objects being persisted — graph nodes
holding `neighbors: set[UndirectedNode]` back-references — are exactly the
self-referential structures dill was built to handle; plain pickle already
manages this fine too, but dill is the RD-Agent-tested choice and is a
one-line dependency."""
from __future__ import annotations
import logging
from pathlib import Path

import dill as pickle  # type: ignore[import-untyped]

logger = logging.getLogger("scriptorium_ingest.knowledge")


class KnowledgeBase:
    def __init__(self, path: str | Path | None = None) -> None:
        self.path = Path(path) if path else None
        self.load()

    def load(self) -> None:
        if self.path is not None and self.path.exists():
            with self.path.open("rb") as f:
                loaded = pickle.load(f)
                if isinstance(loaded, dict):
                    self.__dict__.update({k: v for k, v in loaded.items() if k != "path"})
                else:
                    self.__dict__.update({k: v for k, v in loaded.__dict__.items() if k != "path"})

    def dump(self) -> None:
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("wb") as f:
                pickle.dump(self.__dict__, f)
        else:
            logger.warning("KnowledgeBase path is not set, dump failed.")
