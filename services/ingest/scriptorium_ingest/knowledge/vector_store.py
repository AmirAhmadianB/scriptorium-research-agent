"""Vector store for the entity graph's own nodes (Sprint 3 Pass 1). Adapted
from microsoft/RD-Agent's components/knowledge_management/vector_base.py
(MIT — see ../NOTICE).

NOT a second paper/chunk corpus store — that already exists and stays
exactly as-is (papers.embedding / paper_chunks.embedding, libSQL F32_BLOB +
vector_distance_cos, populated by analyze/chunking.py, queried by
analyze/corpus_ingest.py and analyze/ask_corpus.py). This store only ever
holds entity-graph nodes (concepts/topics extracted from papers), which
have no existing table — see docs/RD-AGENT-EXTRACTION-PASS0.md ("Overlap
finding" for vector_base.py). graph.py is the only intended caller.

Embedding calls route through analyze/embed.py's embed_batch/embed_query —
the project's one embedding provider (free local fastembed by default,
Voyage if VOYAGE_API_KEY is set) — never a second embedding path."""
from __future__ import annotations
import uuid
from pathlib import Path
from typing import Union

import pandas as pd
from scipy.spatial.distance import cosine

from .persistence import KnowledgeBase
from ..analyze.embed import embed_batch, embed_query


class KnowledgeMetaData:
    def __init__(self, content: str = "", label: str | None = None, embedding=None, identity=None):
        self.label = label
        self.content = content
        self.id = str(uuid.uuid3(uuid.NAMESPACE_DNS, str(content))) if identity is None else identity
        self.embedding = embedding
        self.trunks: list[str] = []
        self.trunks_embedding: list[list[float]] = []

    def create_embedding(self) -> None:
        if self.embedding is None:
            self.embedding = embed_query(self.content) if self.content else []

    def from_dict(self, data: dict) -> "KnowledgeMetaData":
        for key, value in data.items():
            setattr(self, key, value)
        return self

    def __repr__(self) -> str:
        return f"Document(id={self.id}, label={self.label}, content={self.content[:80]!r})"


Document = KnowledgeMetaData


class VectorBase(KnowledgeBase):
    """Interface only — see PDVectorBase for the concrete implementation."""

    def add(self, document: Union[Document, list[Document]]) -> None:
        raise NotImplementedError

    def search(self, content: str, topk_k: int | None = None,
               similarity_threshold: float = 0.0) -> tuple[list[Document], list[float]]:
        raise NotImplementedError


class PDVectorBase(VectorBase):
    """Brute-force cosine search over a pandas DataFrame. Fine at graph
    scale (hundreds to low thousands of entity nodes per professor) —
    this is deliberately NOT the corpus-scale search path."""

    def __init__(self, path: Union[str, Path, None] = None):
        self.vector_df = pd.DataFrame(columns=["id", "label", "content", "embedding"])
        super().__init__(path)

    def shape(self) -> tuple[int, int]:
        return self.vector_df.shape

    def add(self, document: Union[Document, list[Document]]) -> None:
        if isinstance(document, list):
            for doc in document:
                self.add(document=doc)
            return
        if document.embedding is None:
            document.create_embedding()
        row = {"id": document.id, "label": document.label, "content": document.content,
               "embedding": document.embedding}
        self.vector_df = pd.concat([self.vector_df, pd.DataFrame([row])], ignore_index=True)

    def search(
        self, content: str, topk_k: int | None = None, similarity_threshold: float = 0.0,
        constraint_labels: list[str] | None = None,
    ) -> tuple[list[Document], list[float]]:
        if not self.vector_df.shape[0]:
            return [], []

        query_embedding = embed_query(content)

        filtered_df = self.vector_df
        if constraint_labels is not None:
            filtered_df = self.vector_df[self.vector_df["label"].isin(constraint_labels)]
        if not filtered_df.shape[0]:
            return [], []

        similarities = filtered_df["embedding"].apply(lambda e: 1 - cosine(e, query_embedding))
        matched = similarities[similarities > similarity_threshold]
        if topk_k is not None:
            matched = matched.nlargest(topk_k)
        rows = filtered_df.loc[matched.index]

        docs = [Document().from_dict(row.to_dict()) for _, row in rows.iterrows()]
        return docs, matched.to_list()


def contents_to_documents(contents: list[str], label: str | None = None) -> list[Document]:
    embeddings = embed_batch(contents)
    return [Document(content=c, label=label, embedding=e) for c, e in zip(contents, embeddings)]
