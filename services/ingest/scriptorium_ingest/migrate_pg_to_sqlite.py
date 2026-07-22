"""One-time data migration: Postgres (old scriptorium DB) -> SQLite (new).
Already run successfully on 2026-07-09 (934 papers, 17 funding rows, 5
agent_runs, 137 structured_summary migrated) -- kept only as a historical
record / reference for future similar migrations, not part of normal
operation. Not idempotent against an already-populated target (re-running
raises on the unique dedupe_key / (url,program) constraints).

Needs `pip install psycopg[binary]` (deliberately dropped from
requirements.txt after the migration ran -- nothing else here talks to
Postgres) to run again against a live Postgres source.

Usage: python -m scriptorium_ingest.migrate_pg_to_sqlite
Env:   DATABASE_URL (source Postgres), SCRIPTORIUM_DB_PATH (target SQLite --
       same default as db.py / apps/api/src/db/client.ts).
"""
from __future__ import annotations
import json
import os
import sys

import psycopg

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from .db import conn as sqlite_conn, DB_PATH

PG_DSN = os.environ["DATABASE_URL"]

AUTOINCREMENT_TABLES = ["papers", "funding_opportunities", "agent_runs", "drafts"]


def _pg_conn():
    return psycopg.connect(PG_DSN, autocommit=True)


def _ts(dt) -> int | None:
    return int(dt.timestamp()) if dt is not None else None


def _j(v) -> str | None:
    return json.dumps(v) if v is not None else None


def migrate_professors(pg, sq) -> int:
    rows = pg.execute("SELECT id, name, department, orcid, focus_override FROM professors").fetchall()
    for id_, name, department, orcid, focus_override in rows:
        sq.execute(
            "INSERT INTO professors (id, name, department, orcid, focus_override) VALUES (?, ?, ?, ?, ?)",
            (id_, name, department, orcid, _j(focus_override)),
        )
    return len(rows)


def migrate_papers(pg, sq) -> int:
    rows = pg.execute(
        """SELECT id, doi, external_id, source, title, abstract, year, venue, authors,
                  cited_by_count, oa_url, concepts, professor_id, is_private,
                  structured_summary, created_at
           FROM papers"""
    ).fetchall()
    for (id_, doi, external_id, source, title, abstract, year, venue, authors,
         cited_by_count, oa_url, concepts, professor_id, is_private,
         structured_summary, created_at) in rows:
        sq.execute(
            """INSERT INTO papers (id, doi, external_id, source, title, abstract, year, venue,
                                   authors, cited_by_count, oa_url, concepts, professor_id,
                                   is_private, structured_summary, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id_, doi, external_id, source, title, abstract, year, venue,
             _j(authors), cited_by_count, oa_url, _j(concepts), professor_id,
             is_private, _j(structured_summary), _ts(created_at)),
        )
    return len(rows)


def migrate_funding(pg, sq) -> int:
    rows = pg.execute(
        """SELECT id, sponsor, program, url, deadline, deadline_uncertain, amount, duration,
                  eligibility, keywords, scope, match_score_pct, content_hash, status, updated_at
           FROM funding_opportunities"""
    ).fetchall()
    for (id_, sponsor, program, url, deadline, deadline_uncertain, amount, duration,
         eligibility, keywords, scope, match_score_pct, content_hash, status, updated_at) in rows:
        sq.execute(
            """INSERT INTO funding_opportunities
                  (id, sponsor, program, url, deadline, deadline_uncertain, amount, duration,
                   eligibility, keywords, scope, match_score_pct, content_hash, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (id_, sponsor, program, url, deadline.isoformat() if deadline else None,
             deadline_uncertain, amount, duration, eligibility, _j(keywords),
             scope, match_score_pct, content_hash, status, _ts(updated_at)),
        )
    return len(rows)


def migrate_runs(pg, sq) -> int:
    rows = pg.execute("SELECT id, kind, model, summary, started_at FROM agent_runs").fetchall()
    for id_, kind, model, summary, started_at in rows:
        sq.execute(
            "INSERT INTO agent_runs (id, kind, model, summary, started_at) VALUES (?, ?, ?, ?, ?)",
            (id_, kind, model, _j(summary), _ts(started_at)),
        )
    return len(rows)


def migrate_drafts(pg, sq) -> int:
    rows = pg.execute(
        "SELECT id, kind, title, professor_id, path, funder_program, status, updated_at FROM drafts"
    ).fetchall()
    for id_, kind, title, professor_id, path, funder_program, status, updated_at in rows:
        sq.execute(
            """INSERT INTO drafts (id, kind, title, professor_id, path, funder_program, status, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (id_, kind, title, professor_id, path, funder_program, status, _ts(updated_at)),
        )
    return len(rows)


def _reset_autoincrement(sq, table: str) -> None:
    """We insert explicit ids above; bump sqlite_sequence so the next
    id-less INSERT (from the running app) doesn't reuse/collide."""
    max_id = sq.execute(f"SELECT COALESCE(MAX(id), 0) FROM {table}").fetchone()[0]
    sq.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))
    sq.execute("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", (table, max_id))


def main() -> None:
    with _pg_conn() as pg, sqlite_conn() as sq:
        counts = {
            "professors": migrate_professors(pg, sq),
            "papers": migrate_papers(pg, sq),
            "funding_opportunities": migrate_funding(pg, sq),
            "agent_runs": migrate_runs(pg, sq),
            "drafts": migrate_drafts(pg, sq),
        }
        for table in AUTOINCREMENT_TABLES:
            _reset_autoincrement(sq, table)

        summaries = sq.execute(
            "SELECT COUNT(*) FROM papers WHERE structured_summary IS NOT NULL"
        ).fetchone()[0]

    print(f"Migrated Postgres -> {DB_PATH}:")
    for table, n in counts.items():
        print(f"  {table}: {n}")
    print(f"  papers.structured_summary populated: {summaries}")


if __name__ == "__main__":
    main()
