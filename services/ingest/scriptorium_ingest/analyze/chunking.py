"""Sprint 2 Pass 2 — extracted from analyze/corpus_ingest.py so BOTH
ingestion paths (Pass 2.2's locally-uploaded PDFs, and paper_analyst.py's
oa_url-fetched bulk corpus) chunk and embed through the same code, not two
copies. Section-aware: chunks never cross a parsed section boundary, so a
chunk's `section_head` is always meaningful for source attribution."""
from __future__ import annotations

from .embed import embed_batch

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
MAX_CHUNKS_PER_PAPER = 60
EMBED_BATCH_SIZE = 32


def _chunk_text(text: str, section_head: str | None) -> list[dict]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text) and len(chunks) < MAX_CHUNKS_PER_PAPER:
        end = start + CHUNK_SIZE
        piece = text[start:end].strip()
        if piece:
            chunks.append({"section_head": section_head, "text": piece})
        if end >= len(text):
            break
        start = end - CHUNK_OVERLAP
    return chunks


def chunk_parsed(parsed: dict) -> list[dict]:
    chunks = []
    for section in parsed["sections"]:
        if len(chunks) >= MAX_CHUNKS_PER_PAPER:
            break
        chunks.extend(_chunk_text(section["text"], section["head"]))
    return chunks[:MAX_CHUNKS_PER_PAPER]


def embed_chunks(chunks: list[dict]) -> list[dict]:
    embedded = []
    for i in range(0, len(chunks), EMBED_BATCH_SIZE):
        batch = chunks[i:i + EMBED_BATCH_SIZE]
        vectors = embed_batch([ch["text"] for ch in batch])
        for ch, vec in zip(batch, vectors):
            embedded.append({**ch, "embedding": vec})
    return embedded
