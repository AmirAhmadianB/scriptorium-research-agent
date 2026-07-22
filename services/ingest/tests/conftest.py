"""First Python test fixture in this service (Sprint 2 Pass 1) — mirrors
apps/api/test/setup.ts's pattern: point SCRIPTORIUM_DB_PATH at a throwaway
temp file BEFORE scriptorium_ingest.db is ever imported (its DB_PATH is
resolved at module-import time), so tests never touch data/scriptorium.db.
DDL here is a hand-maintained subset of apps/api/src/db/schema.ts covering
only the tables trends.py touches — keep in sync if that schema changes
(same caveat as the TS test setup, and the same gotcha bit Pass 1.6)."""
import os
import sqlite3
import tempfile

import pytest

_dir = tempfile.mkdtemp(prefix="scriptorium-pytest-")
_db_path = os.path.join(_dir, "test.db")
os.environ["SCRIPTORIUM_DB_PATH"] = _db_path
# Sprint 6 Pass 2: config.py's DATA_DIR (providers.json, etc.) is resolved
# at import time from this env var, same as SCRIPTORIUM_DB_PATH above —
# without it, any test touching provider_config.py would read/write the
# real data/providers.json.
os.environ["SCRIPTORIUM_DATA_DIR"] = _dir

_DDL = [
    """CREATE TABLE professors (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL,
        orcid TEXT, focus_override TEXT
    )""",
    """CREATE TABLE research_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        professor_id TEXT NOT NULL REFERENCES professors(id),
        focus_synthesis TEXT, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
    )""",
    "CREATE UNIQUE INDEX research_profiles_professor_idx ON research_profiles(professor_id)",
    """CREATE TABLE research_profile_keywords (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES research_profiles(id),
        value TEXT NOT NULL, provenance TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
    )""",
    "CREATE UNIQUE INDEX research_profile_keywords_unique ON research_profile_keywords(profile_id, value)",
    """CREATE TABLE papers (
        id INTEGER PRIMARY KEY AUTOINCREMENT, doi TEXT, external_id TEXT,
        source TEXT NOT NULL, title TEXT, abstract TEXT, year INTEGER, venue TEXT,
        authors TEXT, cited_by_count INTEGER DEFAULT 0, oa_url TEXT, concepts TEXT,
        professor_id TEXT, is_private INTEGER DEFAULT 0, structured_summary TEXT,
        embedding BLOB, dedupe_key TEXT, created_at INTEGER
    )""",
    # Sprint 5 Pass 6 — draft_editor.py's tables (additive; test_trends.py
    # never touches these, so this is safe to share via the same fixture).
    """CREATE TABLE proposal_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, professor_id TEXT NOT NULL,
        funding_opportunity_id INTEGER, status TEXT NOT NULL DEFAULT 'idle',
        context TEXT, state TEXT, created_at INTEGER, updated_at INTEGER
    )""",
    """CREATE TABLE drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, title TEXT NOT NULL,
        professor_id TEXT, path TEXT NOT NULL, funder_program TEXT, status TEXT DEFAULT 'draft',
        updated_at INTEGER, proposal_session_id INTEGER, section_key TEXT,
        current_content_json TEXT, current_plain_text TEXT, current_version_number INTEGER DEFAULT 0
    )""",
    """CREATE TABLE draft_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id INTEGER NOT NULL,
        version_number INTEGER NOT NULL, author_type TEXT NOT NULL,
        content_json TEXT, plain_text TEXT NOT NULL, created_at INTEGER
    )""",
    """CREATE TABLE draft_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id INTEGER NOT NULL,
        version_id INTEGER NOT NULL, comments TEXT NOT NULL, created_at INTEGER
    )""",
]


@pytest.fixture()
def db_conn():
    conn = sqlite3.connect(_db_path, isolation_level=None)
    for stmt in _DDL:
        try:
            conn.execute(stmt)
        except sqlite3.OperationalError as e:
            if "already exists" not in str(e):
                raise
    yield conn
    # Clean slate between tests — delete rows, keep schema (cheaper than
    # recreating tables, and this file/connection is thrown away process-wide
    # at the end of the pytest run regardless).
    for table in ("research_profile_keywords", "research_profiles", "papers", "professors",
                  "draft_feedback", "draft_versions", "drafts", "proposal_sessions"):
        conn.execute(f"DELETE FROM {table}")
    conn.close()


def commit_profile(conn, professor_id: str, keywords: list[str]) -> None:
    conn.execute(
        "INSERT INTO professors (id, name, department) VALUES (?, ?, '') "
        "ON CONFLICT(id) DO NOTHING",
        (professor_id, professor_id),
    )
    conn.execute(
        "INSERT INTO research_profiles (professor_id, version) VALUES (?, 1) "
        "ON CONFLICT(professor_id) DO UPDATE SET version = version + 1",
        (professor_id,),
    )
    profile_id = conn.execute(
        "SELECT id FROM research_profiles WHERE professor_id = ?", (professor_id,)
    ).fetchone()[0]
    conn.execute("DELETE FROM research_profile_keywords WHERE profile_id = ?", (profile_id,))
    conn.executemany(
        "INSERT INTO research_profile_keywords (profile_id, value, provenance, position) VALUES (?, ?, 'manual', ?)",
        [(profile_id, kw, i) for i, kw in enumerate(keywords)],
    )
