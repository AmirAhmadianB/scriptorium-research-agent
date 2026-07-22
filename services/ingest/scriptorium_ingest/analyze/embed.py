"""Embeddings for semantic search over the corpus (libSQL native vector
columns — see apps/api/src/db/schema.ts, F32_BLOB(384)).

Default: a free, local, no-API-key model via `fastembed` (ONNX runtime, no
torch, no billed account) — BAAI/bge-small-en-v1.5, chosen specifically for
its small download (~130MB vs. bge-large's ~1.3GB) so this actually
finishes on a normal connection; 384 dimensions, which is what the
`embedding`/`paper_chunks.embedding` columns are sized for. If
VOYAGE_API_KEY is set, Voyage AI is used instead — this project
deliberately avoids provisioning paid keys on the operator's behalf (see
project memory), so local is the default, not a fallback-of-last-resort.
Pick a Voyage model whose output dimension is exactly DIM (below); the
Voyage path asserts on the response so a mismatch fails loudly with a
clear error instead of silently corrupting the vector column."""
from __future__ import annotations
import os
import httpx

VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
VOYAGE_MODEL = os.environ.get("VOYAGE_EMBED_MODEL", "voyage-3-lite")
LOCAL_MODEL = "BAAI/bge-small-en-v1.5"     # 384-dim, ONNX via fastembed
DIM = 384

_local_model = None  # lazy-loaded singleton — downloads/loads once, not per call


def _embed_batch_local(texts: list[str]) -> list[list[float]]:
    global _local_model
    if _local_model is None:
        from fastembed import TextEmbedding
        _local_model = TextEmbedding(model_name=LOCAL_MODEL)
    return [vec.tolist() for vec in _local_model.embed(texts)]


def _embed_batch_voyage(texts: list[str], key: str) -> list[list[float]]:
    r = httpx.post(VOYAGE_URL, timeout=60,
                   headers={"Authorization": f"Bearer {key}"},
                   json={"model": VOYAGE_MODEL, "input": texts, "input_type": "document"})
    r.raise_for_status()
    vectors = [d["embedding"] for d in r.json()["data"]]
    if vectors and len(vectors[0]) != DIM:
        raise RuntimeError(
            f"VOYAGE_MODEL={VOYAGE_MODEL!r} returned {len(vectors[0])}-dim vectors, "
            f"but the DB column is sized for {DIM}. Set VOYAGE_EMBED_MODEL to a "
            f"{DIM}-dim Voyage model, or change DIM here and the matching column "
            f"in apps/api/src/db/schema.ts (both papers.embedding and "
            f"paper_chunks.embedding)."
        )
    return vectors


def embed_batch(texts: list[str]) -> list[list[float]]:
    key = os.environ.get("VOYAGE_API_KEY")
    if key:
        return _embed_batch_voyage(texts, key)
    return _embed_batch_local(texts)


# BGE models are trained asymmetrically: passages/documents are embedded
# plain, but queries need this exact instruction prefix prepended to land
# in the same space as passage embeddings (the model card's documented
# convention) — applying it manually rather than depending on fastembed
# exposing a separate query-embedding method works for any local model
# choice and for Voyage's plain document embedding alike.
_BGE_QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "


def embed_query(text: str) -> list[float]:
    key = os.environ.get("VOYAGE_API_KEY")
    if key:
        return _embed_batch_voyage([text], key)[0]
    [vec] = _embed_batch_local([_BGE_QUERY_INSTRUCTION + text])
    return vec


def _cli_main() -> None:
    """CLI entrypoint so the TS API (which can't run ONNX/fastembed itself)
    can get a query embedding via subprocess — same worker-as-subprocess
    convention as every other Python piece here. Prints {"embedding": [...]}."""
    import json
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    print(json.dumps({"embedding": embed_query(query)}))


if __name__ == "__main__":
    _cli_main()
