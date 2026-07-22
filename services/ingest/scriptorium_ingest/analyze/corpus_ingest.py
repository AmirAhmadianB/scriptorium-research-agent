"""Pass 2.2 — Corpus ingestion pipeline (Change 2: the corpus tab's PDFs get
read comprehensively, not superficially, and what's learned persists).

Runs after Pass 2.1's folder upload has already saved PDFs into
library-inbox/<professor_id>/ and registered them as `papers` rows (source
'pdf_folder') via library/watch_folder.py's scan_pdf_folder(). This module:

1. Re-parses each PDF via parse.pdf_parser.parse_pdf — the SAME shared
   parser Change 1 (Pass 1.3) and Change 2 both use; no second parser.
2. Deep-reads it via analyze.paper_analyst.analyze_parsed — the SAME
   prompt-building/LLM-call logic paper_analyst.py's oa_url path uses, just
   fed locally-parsed content instead of an HTTP fetch (locally-uploaded
   PDFs have no oa_url to fetch from).
3. Chunks the full parsed text and embeds each chunk (analyze.embed) for
   grounded, source-attributed retrieval — finer-grained than the one
   whole-paper vector papers.embedding already provides.
4. After the batch, regenerates a running corpus-wide synthesis (not just
   per-paper summaries) grounded in the current Research Focus.

Resumable by construction: a paper already having chunks is skipped
(replace_paper_chunks always fully replaces rather than appends, so even a
forced re-run of one paper can't duplicate its own chunk rows).

Run: python -m scriptorium_ingest.analyze.corpus_ingest [--limit N] [--professor default]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..config import resolve_data_relative_path, sources, task_model
from ..db import (
    conn, delete_paper_and_chunks, describe_current_research_focus, get_corpus_synthesis,
    get_paper_by_digest, log_run, paper_has_chunks, replace_paper_chunks, set_paper_embedding,
    set_structured_summary, upsert_corpus_synthesis,
)
from ..parse.pdf_parser import parse_pdf
from ..llm.dispatch import complete
from .embed import embed_batch, embed_query
from .chunking import chunk_parsed, embed_chunks
from .paper_analyst import _persona_body, analyze_parsed

SYNTHESIS_PROMPT = """You maintain a running synthesis of a researcher's corpus of \
reference papers. Given per-paper structured summaries below, write a \
grounded synthesis (4-8 sentences): the corpus's overall themes, methods \
in common use, and open gaps across papers (not per-paper — look for \
patterns ACROSS them). Do not invent a domain; infer it entirely from what \
is below, whatever field that turns out to be.

Research group's focus: {goal}

Per-paper summaries ({count} papers):
---
{summaries}
---

Return ONLY the synthesis paragraph, no headings, no markdown."""


def _library_root() -> Path:
    cfg = next((c for c in sources()["library_connectors"] if c["kind"] == "pdf_folder"), None)
    # Sprint 6 Pass 1: same mode-aware resolution as library/watch_folder.py
    # — must agree with it exactly, since this walks the same folder that
    # module's scan_pdf_folder() populates.
    return resolve_data_relative_path(cfg["path"] if cfg else "./library-inbox")


def _find_local_papers(professor_id: str) -> list[tuple[Path, dict]]:
    """Walk this professor's library-inbox folder, matching each PDF to its
    already-upserted `papers` row by content digest (same digest
    watch_folder.py used) — avoids needing a stored file-path column."""
    prof_dir = _library_root() / professor_id
    if not prof_dir.is_dir():
        return []
    found = []
    with conn() as c:
        for pdf in prof_dir.glob("*.pdf"):
            digest = hashlib.sha1(pdf.read_bytes()).hexdigest()
            row = get_paper_by_digest(c, digest)
            if row:
                found.append((pdf, row))
    return found


def _ingest_one(pdf_path: Path, paper: dict, persona: str, model: str, goal: str) -> None:
    parsed = parse_pdf(str(pdf_path))
    with conn() as c:
        if paper["structured_summary"] is None:
            result = analyze_parsed(parsed, paper["title"], persona, model, goal, paper.get("abstract") or "")
            set_structured_summary(c, paper["id"], result)

        chunks = chunk_parsed(parsed)
        embedded = embed_chunks(chunks) if chunks else []
        replace_paper_chunks(c, paper["id"], embedded)

        # Whole-paper vector for the existing /api/corpus/semantic route —
        # embed title + abstract (cheap, one call) rather than the full text.
        doc_summary = f"{paper['title'] or ''}\n{paper.get('abstract') or ''}".strip()
        if doc_summary:
            [doc_vec] = embed_batch([doc_summary])
            set_paper_embedding(c, paper["id"], doc_vec)


def _regenerate_corpus_synthesis(professor_id: str, model: str) -> dict:
    with conn() as c:
        # Sprint 2 Pass 2: bulk-scanned papers (run_scan.py's OpenAlex/arXiv/
        # Semantic Scholar sources) are never assigned a professor_id — only
        # locally-uploaded PDFs are. In this single-professor deployment
        # those unscoped rows ARE the bulk of the corpus, so "the corpus"
        # for comment 12's purposes means professor_id = ? OR NULL, not a
        # strict match that would silently exclude almost everything.
        rows = c.execute(
            "SELECT title, structured_summary FROM papers "
            "WHERE (professor_id = ? OR professor_id IS NULL) AND structured_summary IS NOT NULL "
            "ORDER BY id DESC LIMIT 40",
            (professor_id,),
        ).fetchall()
        goal = describe_current_research_focus(c, professor_id)
    if not rows:
        return {"skipped": True, "reason": "no analyzed papers yet"}

    summaries = []
    for title, raw in rows:
        try:
            s = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        summaries.append(f"- {title}: problem={s.get('problem', '')!r} findings={s.get('findings', '')!r} "
                          f"gaps={s.get('gaps', [])!r}")

    prompt = SYNTHESIS_PROMPT.format(goal=goal, count=len(summaries), summaries="\n".join(summaries))
    text = complete(prompt, model=model).strip()
    with conn() as c:
        upsert_corpus_synthesis(c, professor_id, text, len(rows))
    return {"paperCount": len(rows), "synthesisLength": len(text)}


def resync_after_change(professor_id: str) -> dict:
    """Pass 2.3 — call after ANY add or remove so corpus memory (the
    synthesis) never goes stale relative to what's actually in the corpus.
    Distinct from a "skip" during ingestion (no analyzed papers YET) vs. a
    genuine removal down to zero (clear the stale synthesis instead of
    leaving old text describing papers that no longer exist)."""
    with conn() as c:
        remaining = c.execute(
            "SELECT COUNT(*) FROM papers WHERE (professor_id = ? OR professor_id IS NULL) "
            "AND structured_summary IS NOT NULL",
            (professor_id,),
        ).fetchone()[0]
    if remaining == 0:
        with conn() as c:
            c.execute("DELETE FROM corpus_synthesis WHERE professor_id = ?", (professor_id,))
        return {"cleared": True}
    return _regenerate_corpus_synthesis(professor_id, task_model("knowledge_curation")["model"])


def remove_paper_by_digest(professor_id: str, digest: str) -> dict:
    """Pass 2.3 Gate: "removing one removes it from retrieval." Deletes the
    paper's chunks (so it stops surfacing in query_corpus/ask) and its row,
    then resyncs the corpus synthesis so it no longer reflects the removed
    paper either."""
    with conn() as c:
        row = get_paper_by_digest(c, digest)
        if row is None:
            return {"removed": False, "reason": "no matching paper for this file"}
        delete_paper_and_chunks(c, row["id"])
    return {"removed": True, "paperId": row["id"], "resync": resync_after_change(professor_id)}


def query_corpus(query: str, professor_id: str = "default", k: int = 8) -> list[dict]:
    """Pass 2.3's retrieval interface for OTHER agents (Change 3's
    orchestrator, a future gap-brainstorming worker) to call directly from
    Python, without an HTTP round-trip through the API. Mirrors
    apps/api/src/routes/corpus-analysis.ts's GET /api/corpus/ask (that one
    is for the dashboard/TS-side agents); both read the same paper_chunks
    table so results are identical either way. Grounded: every result
    carries paperId/title/section, never a bare snippet with no source."""
    import numpy as np

    qvec = np.array(embed_query(query), dtype=np.float32)
    qnorm = qvec / (np.linalg.norm(qvec) or 1.0)

    with conn() as c:
        # Same professor_id-or-NULL reasoning as _regenerate_corpus_synthesis
        # above — bulk-scanned papers have no professor_id, and excluding
        # them would make "Ask the corpus" blind to most of the corpus.
        rows = c.execute(
            """SELECT pc.id, pc.section_head, pc.text, pc.embedding,
                      p.id, p.title, p.year, p.venue
               FROM paper_chunks pc JOIN papers p ON p.id = pc.paper_id
               WHERE pc.embedding IS NOT NULL AND (p.professor_id = ? OR p.professor_id IS NULL)""",
            (professor_id,),
        ).fetchall()

    scored = []
    for chunk_id, section_head, text, emb_blob, paper_id, title, year, venue in rows:
        vec = np.frombuffer(emb_blob, dtype="<f4")
        vnorm = vec / (np.linalg.norm(vec) or 1.0)
        score = float(np.dot(qnorm, vnorm))
        scored.append({
            "chunkId": chunk_id, "sectionHead": section_head, "snippet": text,
            "paperId": paper_id, "paperTitle": title, "paperYear": year, "paperVenue": venue,
            "score": score,
        })
    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:k]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--professor", default="default")
    ap.add_argument("--remove-digest", default=None, help="Pass 2.3: remove one paper by its content digest")
    ap.add_argument("--query", default=None, help="Pass 2.3: query_corpus() from the CLI, prints JSON results")
    ap.add_argument("--resync", action="store_true",
                     help="Sprint 6 Pass 1: resync_after_change() from the CLI, prints JSON — "
                          "a proper entrypoint for what routes/corpus-analysis.ts used to invoke via "
                          "`python -c \"...\"`, which a packaged PyInstaller sidecar has no interpreter "
                          "to run arbitrary source through")
    args = ap.parse_args()

    if args.remove_digest:
        print(json.dumps(remove_paper_by_digest(args.professor, args.remove_digest), indent=2))
        return
    if args.query:
        print(json.dumps(query_corpus(args.query, args.professor), indent=2))
        return
    if args.resync:
        print(json.dumps(resync_after_change(args.professor), indent=2))
        return

    cfg = task_model("deep_paper_analysis")
    persona = _persona_body()
    summary = {"ingested": 0, "skipped_already_done": 0, "errors": []}

    with conn() as c:
        goal = describe_current_research_focus(c, args.professor)

    candidates = _find_local_papers(args.professor)
    if args.limit:
        candidates = candidates[:args.limit]
    total = len(candidates)

    for i, (pdf_path, paper) in enumerate(candidates, 1):
        with conn() as c:
            already_done = paper["structured_summary"] is not None and paper_has_chunks(c, paper["id"])
        if already_done:
            summary["skipped_already_done"] += 1
            print(f"[{i}/{total}] skip (already ingested): {paper['title'] or paper['id']}", flush=True)
            continue
        try:
            _ingest_one(pdf_path, paper, persona, cfg["model"], goal)
            summary["ingested"] += 1
            print(f"[{i}/{total}] ok: {paper['title'] or paper['id']}", flush=True)
        except Exception as e:
            msg = f"paper {paper['id']} ({paper.get('title') or 'untitled'}): {type(e).__name__}: {e}"
            summary["errors"].append(msg)
            print(f"[{i}/{total}] ERROR: {msg}", flush=True)

    if summary["ingested"] > 0:
        summary["corpus_synthesis"] = resync_after_change(args.professor)

    with conn() as c:
        log_run(c, "corpus_ingest", summary)

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
