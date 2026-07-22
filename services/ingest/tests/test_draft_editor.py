"""Sprint 5 Pass 6 (comment 13) gate (fast slice): span resolution, comment
status validation, and the working-copy/version-checkpoint distinction —
all against the real (throwaway, per-test) SQLite schema so the actual SQL
is exercised, not a mock of it. The live end-to-end path (real TipTap
editor, real LLM feedback call, real docx/PDF export) was run manually
against the dev server AND via a Playwright browser check; see
docs/DASHBOARD-CORRECTIONS-SPRINT5-PASS0.md."""
from __future__ import annotations
import json

import pytest
from scriptorium_ingest.analyze.draft_editor import (
    _resolve_span, _sanitize_text, get_draft, save_working_copy, set_comment_status,
)


class TestSanitizeText:
    """Live Playwright testing found this crashing autosave with
    UnicodeEncodeError: a lone/unpaired UTF-16 surrogate can arrive in
    edited text via the browser's JSON round-trip (valid JS, invalid
    Unicode) and SQLite's driver refuses to store it."""

    def test_leaves_normal_text_untouched(self):
        assert _sanitize_text("normal proposal text — with an em dash") == "normal proposal text — with an em dash"

    def test_replaces_a_lone_surrogate_instead_of_raising(self):
        bad = "before \udc9d after"
        result = _sanitize_text(bad)
        assert "\udc9d" not in result
        assert result.encode("utf-8")  # must not raise

    def test_none_passes_through(self):
        assert _sanitize_text(None) is None


class TestResolveSpan:
    def test_finds_exact_substring(self):
        assert _resolve_span("the quick brown fox", "quick brown") == (4, 15)

    def test_returns_none_when_not_found(self):
        assert _resolve_span("the quick brown fox", "slow turtle") is None

    def test_finds_first_occurrence_only(self):
        assert _resolve_span("cat cat cat", "cat") == (0, 3)


def _seed_session(db_conn, session_id: int = 1) -> None:
    db_conn.execute("INSERT INTO professors (id, name, department) VALUES ('default', 'D', '')")
    context = {
        "funding": {"opportunity": {"program": "P", "sponsor": "S", "eligibility": None, "priorities": None}},
        "corpus": {"synthesis": None, "relevantChunks": []},
        "literature": {"recentPapers": []},
        "researchFocus": {"keywords": [], "focusSynthesis": None},
    }
    state = {
        # A non-empty pool: `{} or _build_citation_pool(...)` in
        # get_draft() would otherwise fall through and make a REAL
        # OpenAlex network call — an empty-but-present pool is different
        # from no pool at all, and this test seeds the former.
        "gaps": [], "citablePool": {"placeholder": {"title": "Placeholder", "authors": [], "venue": None, "year": None}},
        "sectionPlan": {"order": ["aims"], "labels": {"aims": "Specific Aims"},
                        "isFallback": True, "evaluationCriteria": []},
        "draftSections": [{"sectionKey": "aims", "label": "Specific Aims",
                            "text": "## Specific Aims\n\nOriginal agent text.", "revisionCount": 0}],
    }
    db_conn.execute(
        "INSERT INTO proposal_sessions (id, professor_id, funding_opportunity_id, status, context, state) "
        "VALUES (?, 'default', 1, 'gaps_confirmed', ?, ?)",
        (session_id, json.dumps(context), json.dumps(state)),
    )


class TestDraftLifecycle:
    def test_get_draft_seeds_version_1_from_agent_text(self, db_conn):
        _seed_session(db_conn)
        result = get_draft(1, "aims")
        assert result["draft"]["currentVersionNumber"] == 1
        assert "Original agent text" in result["draft"]["currentPlainText"]
        assert len(result["versions"]) == 1
        assert result["versions"][0]["authorType"] == "agent"

    def test_get_draft_is_idempotent_does_not_reseed(self, db_conn):
        _seed_session(db_conn)
        first = get_draft(1, "aims")
        save_working_copy(1, "aims", {"type": "doc"}, "edited text")
        second = get_draft(1, "aims")
        assert first["draft"]["id"] == second["draft"]["id"]
        assert second["draft"]["currentPlainText"] == "edited text"

    def test_autosave_with_a_lone_surrogate_does_not_crash(self, db_conn):
        """End-to-end reproduction of the live-found bug: a real DB write,
        not just the sanitizer in isolation."""
        _seed_session(db_conn)
        get_draft(1, "aims")
        result = save_working_copy(1, "aims", {"type": "doc"}, "text with \udc9d a bad surrogate")
        assert result["saved"] is True
        reloaded = get_draft(1, "aims")
        assert "\udc9d" not in reloaded["draft"]["currentPlainText"]

    def test_autosave_never_bumps_version_number(self, db_conn):
        """comment 13: autosave updates the WORKING COPY only — a version
        is a checkpoint (initial agent draft, or a feedback-request
        snapshot), never every keystroke."""
        _seed_session(db_conn)
        get_draft(1, "aims")  # creates version 1
        save_working_copy(1, "aims", {"type": "doc"}, "edit one")
        save_working_copy(1, "aims", {"type": "doc"}, "edit two")
        result = get_draft(1, "aims")
        assert result["draft"]["currentVersionNumber"] == 1
        assert len(result["versions"]) == 1
        assert result["draft"]["currentPlainText"] == "edit two"


class TestCommentStatus:
    def _seed_feedback(self, db_conn) -> int:
        _seed_session(db_conn)
        get_draft(1, "aims")
        draft_id = db_conn.execute("SELECT id FROM drafts WHERE proposal_session_id = 1").fetchone()[0]
        version_id = db_conn.execute("SELECT id FROM draft_versions WHERE draft_id = ?", (draft_id,)).fetchone()[0]
        comments = [{"id": 0, "quotedText": "x", "spanStart": 0, "spanEnd": 1, "unresolved": False,
                     "comment": "c", "category": "clarity", "suggestedText": None, "status": "pending"}]
        db_conn.execute("INSERT INTO draft_feedback (draft_id, version_id, comments) VALUES (?, ?, ?)",
                         (draft_id, version_id, json.dumps(comments)))
        return db_conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def test_updates_only_the_targeted_comment(self, db_conn):
        feedback_id = self._seed_feedback(db_conn)
        result = set_comment_status(feedback_id, 0, "accepted")
        assert result["status"] == "accepted"
        row = db_conn.execute("SELECT comments FROM draft_feedback WHERE id = ?", (feedback_id,)).fetchone()
        assert json.loads(row[0])[0]["status"] == "accepted"

    def test_rejects_invalid_status(self, db_conn):
        feedback_id = self._seed_feedback(db_conn)
        with pytest.raises(ValueError):
            set_comment_status(feedback_id, 0, "definitely-not-a-real-status")

    def test_rejects_unknown_comment_id(self, db_conn):
        feedback_id = self._seed_feedback(db_conn)
        with pytest.raises(ValueError):
            set_comment_status(feedback_id, 999, "accepted")
