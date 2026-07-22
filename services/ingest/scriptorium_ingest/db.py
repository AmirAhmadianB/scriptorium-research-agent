"""Thin SQLite layer (stdlib sqlite3). Schema is owned by Drizzle in
apps/api/src/db/schema.ts — this module only reads/writes. Same DB file as
the API (a libSQL file, but plain-SQLite-compatible for the tables/columns
this module touches); path resolved from SCRIPTORIUM_DB_PATH. Note: the
`vector32()`/`vector_distance_cos()` SQL FUNCTIONS are libSQL-only and
stdlib sqlite3 can't call them (only used query-side, in apps/api/src/
server.ts) — but F32_BLOB is just a flat little-endian float32 BLOB on
disk, so this module WRITES embeddings with plain `struct.pack`, no
libSQL-specific call needed (live-verified in Pass 2.2 that libSQL's
vector_distance_cos() correctly reads blobs written this way from the
Python side)."""
from __future__ import annotations
import json
import os
import sqlite3
import struct
from pathlib import Path

from .config import DATA_DIR

# Sprint 6 Pass 1 (A0/A4): same precedence as apps/api/src/dataDir.ts's
# `paths.db` — SCRIPTORIUM_DB_PATH first (most specific, and pre-dates
# SCRIPTORIUM_DATA_DIR), then DATA_DIR/scriptorium.db (config.py's shared
# resolution, which the Node API sets via SCRIPTORIUM_DATA_DIR on every
# worker spawn), which is the original repo-relative data/ default for a
# worker run standalone from a terminal in dev with neither env var set.
DEFAULT_DB_PATH = DATA_DIR / "scriptorium.db"
DB_PATH = os.environ.get("SCRIPTORIUM_DB_PATH", str(DEFAULT_DB_PATH))


def conn():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH, isolation_level=None)  # autocommit
    c.execute("PRAGMA journal_mode = WAL")
    return c


def upsert_paper(c, p: dict, professor_id: str | None = None) -> bool:
    """Insert by DOI (or source+external_id when DOI missing). Returns True if new."""
    dedupe_key = p.get("doi") or f"{p['source']}:{p.get('external_id')}"
    existing = c.execute(
        "SELECT 1 FROM papers WHERE dedupe_key = ?", (dedupe_key,)
    ).fetchone()
    c.execute(
        """
        INSERT INTO papers (doi, external_id, source, title, abstract, year, published_date,
                            venue, authors, cited_by_count, oa_url, concepts, professor_id)
        VALUES (:doi, :external_id, :source, :title, :abstract, :year, :published_date,
                :venue, :authors, :cited_by_count, :oa_url, :concepts, :prof)
        ON CONFLICT (dedupe_key) DO UPDATE
          SET cited_by_count = MAX(COALESCE(papers.cited_by_count, 0), COALESCE(excluded.cited_by_count, 0)),
              oa_url = COALESCE(papers.oa_url, excluded.oa_url),
              published_date = COALESCE(papers.published_date, excluded.published_date)
        """,
        {**p, "authors": json.dumps(p.get("authors", [])),
         "concepts": json.dumps(p.get("concepts", [])), "prof": professor_id,
         "published_date": p.get("published_date")},
    )
    return existing is None


def upsert_funding(c, f: dict) -> str:
    """Returns 'new' | 'changed' | 'same' by content hash. Sprint 2 Pass 4
    (comments 5/6/9) added source/priorities/requirements/proposal_template
    — optional in the input dict so older callers (or a manual add that
    doesn't have all of them) still work; defaults keep behavior unchanged
    for callers that never pass them."""
    params = {
        **f,
        "keywords": json.dumps(f.get("keywords", [])),
        "source": f.get("source", "crawl"),
        "priorities": f.get("priorities"),
        "requirements": f.get("requirements"),
        "proposal_template": json.dumps(f["proposal_template"]) if f.get("proposal_template") else None,
        "submission_format": f.get("submission_format"),
    }
    existing = c.execute(
        "SELECT content_hash FROM funding_opportunities WHERE url = :url AND program = :program",
        params,
    ).fetchone()
    if existing is None:
        c.execute(
            """
            INSERT INTO funding_opportunities
                  (sponsor, program, url, deadline, deadline_uncertain, amount,
                   duration, eligibility, keywords, scope, content_hash,
                   source, priorities, requirements, proposal_template, submission_format)
            VALUES (:sponsor, :program, :url, :deadline, :deadline_uncertain, :amount,
                    :duration, :eligibility, :keywords, :scope, :content_hash,
                    :source, :priorities, :requirements, :proposal_template, :submission_format)
            """,
            params,
        )
        return "new"
    if existing[0] == params["content_hash"]:
        return "same"
    c.execute(
        """
        UPDATE funding_opportunities
           SET deadline = :deadline, amount = :amount, eligibility = :eligibility,
               content_hash = :content_hash, updated_at = unixepoch(),
               priorities = :priorities, requirements = :requirements,
               proposal_template = :proposal_template, submission_format = :submission_format
         WHERE url = :url AND program = :program
        """,
        params,
    )
    return "changed"


def papers_needing_analysis_or_chunking(c, limit: int | None = None) -> list[dict]:
    """Sprint 2 Pass 2 (comment 12): the full-corpus backfill target — an
    oa_url paper missing EITHER its structured analysis OR its chunks
    (papers analyzed before chunking existed have summaries but no
    chunks). Caller decides per-paper which of the two steps to actually
    run, so an already-analyzed paper isn't re-sent to the LLM just to
    backfill chunks."""
    q = """SELECT p.id, p.title, p.abstract, p.oa_url, p.structured_summary
           FROM papers p
           WHERE p.oa_url IS NOT NULL AND p.oa_url <> ''
             AND (p.structured_summary IS NULL
                  OR NOT EXISTS (SELECT 1 FROM paper_chunks pc WHERE pc.paper_id = p.id))
           ORDER BY p.cited_by_count DESC NULLS LAST"""
    if limit:
        q += f" LIMIT {int(limit)}"
    cur = c.execute(q)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def set_structured_summary(c, paper_id: int, summary: dict) -> None:
    c.execute("UPDATE papers SET structured_summary = ? WHERE id = ?",
              (json.dumps(summary), paper_id))


def papers_needing_graph_population(c, limit: int | None = None) -> list[dict]:
    """Sprint 3 Pass 2 — the entity-graph backfill target. Unlike
    papers_needing_analysis_or_chunking, this does NOT require oa_url: an
    uploaded PDF with no external link is equally valid graph content."""
    q = """SELECT id, title, abstract, concepts, structured_summary
           FROM papers
           WHERE title IS NOT NULL AND title <> '' AND graph_populated_at IS NULL
           ORDER BY cited_by_count DESC NULLS LAST"""
    if limit:
        q += f" LIMIT {int(limit)}"
    cur = c.execute(q)
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    for r in rows:
        r["concepts"] = json.loads(r["concepts"]) if r.get("concepts") else []
        r["structured_summary"] = json.loads(r["structured_summary"]) if r.get("structured_summary") else None
    return rows


def mark_graph_populated(c, paper_id: int) -> None:
    c.execute("UPDATE papers SET graph_populated_at = unixepoch() WHERE id = ?", (paper_id,))


def current_research_focus(c, professor_id: str = "default") -> dict:
    """Pass 1.5: the Research Focus profile (Change 1), not the legacy
    config/focus.yaml, is the field-adaptive source of truth every consumer
    must read from. Returns an empty/neutral shape for a DRAFT/never-
    committed profile rather than falling back to focus.yaml — a silent
    YAML fallback would reintroduce exactly the hardcoded-discipline
    coupling Change 1 removes."""
    row = c.execute(
        "SELECT id, focus_synthesis FROM research_profiles WHERE professor_id = ?", (professor_id,)
    ).fetchone()
    if row is None:
        return {"keywords": [], "focus_synthesis": None}
    profile_id, focus_synthesis = row
    rows = c.execute(
        "SELECT value FROM research_profile_keywords WHERE profile_id = ? ORDER BY position",
        (profile_id,),
    ).fetchall()
    return {"keywords": [r[0] for r in rows], "focus_synthesis": focus_synthesis}


def current_research_focus_keywords(c, professor_id: str = "default") -> list[str]:
    return current_research_focus(c, professor_id)["keywords"]


def current_research_focus_version(c, professor_id: str = "default") -> int | None:
    """Sprint 4 (C1) — the profile's own monotonic version counter (already
    incremented on every commit by apps/api/src/profile/store.ts). Stamped
    onto every literature_scan run's summary so the radar tab can tell
    'ran against the current focus' from 'ran against a stale one' by
    comparing two integers, no new schema column needed. None for a
    professor with no committed profile yet (never stale — nothing to be
    stale against)."""
    row = c.execute(
        "SELECT version FROM research_profiles WHERE professor_id = ?", (professor_id,)
    ).fetchone()
    return row[0] if row else None


def describe_current_research_focus(c, professor_id: str = "default") -> str:
    """One-line prompt-ready description for agent personas (Pass 1.5d):
    prefers the researcher's own focus synthesis, falls back to a raw
    keyword list, and degrades to an explicit no-assumption statement for a
    DRAFT/empty profile instead of ever describing a domain nobody set."""
    profile = current_research_focus(c, professor_id)
    if profile["focus_synthesis"]:
        return profile["focus_synthesis"].strip()
    if profile["keywords"]:
        return "Keywords: " + ", ".join(profile["keywords"])
    return ("No Research Focus has been set yet — analyze on the paper's own "
            "merits without assuming any particular research domain.")


def _pack_vector(embedding: list[float]) -> bytes:
    return struct.pack(f"<{len(embedding)}f", *embedding)


def get_paper_by_digest(c, digest: str, source: str = "pdf_folder") -> dict | None:
    row = c.execute(
        "SELECT id, title, abstract, structured_summary FROM papers WHERE source = ? AND external_id = ?",
        (source, digest),
    ).fetchone()
    if row is None:
        return None
    return {"id": row[0], "title": row[1], "abstract": row[2], "structured_summary": row[3]}


def paper_has_chunks(c, paper_id: int) -> bool:
    return c.execute("SELECT 1 FROM paper_chunks WHERE paper_id = ? LIMIT 1", (paper_id,)).fetchone() is not None


def set_paper_embedding(c, paper_id: int, embedding: list[float]) -> None:
    c.execute("UPDATE papers SET embedding = ? WHERE id = ?", (_pack_vector(embedding), paper_id))


def replace_paper_chunks(c, paper_id: int, chunks: list[dict]) -> None:
    """chunks: [{"section_head": str|None, "text": str, "embedding": list[float]}, ...].
    Deletes any existing chunks for this paper first — re-ingesting a paper
    (e.g. after a re-parse improvement) replaces rather than appends, so
    re-running never duplicates rows."""
    c.execute("DELETE FROM paper_chunks WHERE paper_id = ?", (paper_id,))
    c.executemany(
        "INSERT INTO paper_chunks (paper_id, chunk_index, section_head, text, embedding) VALUES (?, ?, ?, ?, ?)",
        [(paper_id, i, ch.get("section_head"), ch["text"], _pack_vector(ch["embedding"]))
         for i, ch in enumerate(chunks)],
    )


def get_corpus_synthesis(c, professor_id: str = "default") -> dict | None:
    row = c.execute(
        "SELECT synthesis_text, paper_count, updated_at FROM corpus_synthesis WHERE professor_id = ?",
        (professor_id,),
    ).fetchone()
    if row is None:
        return None
    return {"synthesisText": row[0], "paperCount": row[1], "updatedAt": row[2]}


def upsert_corpus_synthesis(c, professor_id: str, synthesis_text: str, paper_count: int) -> None:
    c.execute(
        """
        INSERT INTO corpus_synthesis (professor_id, synthesis_text, paper_count, updated_at)
        VALUES (?, ?, ?, unixepoch())
        ON CONFLICT (professor_id) DO UPDATE
          SET synthesis_text = excluded.synthesis_text,
              paper_count = excluded.paper_count,
              updated_at = excluded.updated_at
        """,
        (professor_id, synthesis_text, paper_count),
    )


def delete_paper_and_chunks(c, paper_id: int) -> None:
    """Pass 2.3 — removing a paper must remove it from retrieval too, not
    just the papers row (a dangling paper_chunks row would keep surfacing
    in /api/corpus/ask after the paper it belongs to is gone)."""
    c.execute("DELETE FROM paper_chunks WHERE paper_id = ?", (paper_id,))
    c.execute("DELETE FROM papers WHERE id = ?", (paper_id,))


def log_run(c, kind: str, summary: dict):
    c.execute("INSERT INTO agent_runs (kind, summary) VALUES (?, ?)",
              (kind, json.dumps(summary)))


# ------------------------------------------------------ crawl_sources (Sprint 2 Pass 3)

def list_crawl_sources(c, purpose: str | None = None, enabled_only: bool = False) -> list[dict]:
    q = "SELECT id, url, label, purpose, scope, enabled, last_crawled_at, last_status, last_result_count, last_error FROM crawl_sources"
    where, params = [], []
    if purpose:
        where.append("purpose = ?"); params.append(purpose)
    if enabled_only:
        where.append("enabled = 1")
    if where:
        q += " WHERE " + " AND ".join(where)
    q += " ORDER BY purpose, label"
    cur = c.execute(q, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def add_crawl_source(c, url: str, label: str, purpose: str, scope: str | None = None) -> int:
    c.execute(
        "INSERT INTO crawl_sources (url, label, purpose, scope) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(url) DO UPDATE SET label = excluded.label, purpose = excluded.purpose, scope = excluded.scope",
        (url, label, purpose, scope),
    )
    return c.execute("SELECT id FROM crawl_sources WHERE url = ?", (url,)).fetchone()[0]


def set_crawl_source_enabled(c, source_id: int, enabled: bool) -> None:
    c.execute("UPDATE crawl_sources SET enabled = ? WHERE id = ?", (1 if enabled else 0, source_id))


def remove_crawl_source(c, source_id: int) -> None:
    c.execute("DELETE FROM crawl_sources WHERE id = ?", (source_id,))


def record_crawl_result(c, source_id: int, status: str, count: int | None = None, error: str | None = None) -> None:
    c.execute(
        "UPDATE crawl_sources SET last_crawled_at = unixepoch(), last_status = ?, "
        "last_result_count = ?, last_error = ? WHERE id = ?",
        (status, count, error, source_id),
    )
