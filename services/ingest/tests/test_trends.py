"""Sprint 2 Pass 1 (comment 3) regression test — the keyword-velocity chart
must rebuild its series for whatever keywords are in the CURRENT Research
Focus, dropping removed keywords and picking up new ones. analyze/trends.py
already sourced its keyword list from the live profile (Pass 1.5e), but had
no automated regression test guarding that; this is the first Python test
in this service (see tests/conftest.py for the fixture)."""
import json

from scriptorium_ingest.analyze.trends import compute
from conftest import commit_profile

MICROSCOPY_PAPER = {
    "title": "Reflection electron holography of buried GaN interfaces",
    "abstract": "4D-STEM phase retrieval applied to semiconductor metrology.",
    "year": 2025, "venue": "Ultramicroscopy",
}
ECON_PAPER = {
    "title": "Nudge theory and default enrollment in retirement plans",
    "abstract": "A field experiment on choice architecture and savings behavior.",
    "year": 2025, "venue": "Journal of Public Economics",
}


def _insert_paper(conn, p: dict) -> None:
    conn.execute(
        "INSERT INTO papers (source, title, abstract, year, venue, authors, dedupe_key) "
        "VALUES ('test', ?, ?, ?, ?, '[]', ?)",
        (p["title"], p["abstract"], p["year"], p["venue"], p["title"]),
    )


def test_velocity_series_follow_the_current_focus_keywords(db_conn):
    _insert_paper(db_conn, MICROSCOPY_PAPER)
    _insert_paper(db_conn, ECON_PAPER)

    commit_profile(db_conn, "default", ["4d-stem", "reflection electron holography"])
    result_a = compute(4)
    assert set(result_a["keyword_velocity"].keys()) == {"4d-stem", "reflection electron holography"}

    # Disjoint domain B — series must be rebuilt, not merged with A's.
    commit_profile(db_conn, "default", ["nudge theory", "choice architecture"])
    result_b = compute(4)
    assert set(result_b["keyword_velocity"].keys()) == {"nudge theory", "choice architecture"}
    assert "4d-stem" not in result_b["keyword_velocity"]
    assert "reflection electron holography" not in result_b["keyword_velocity"]
