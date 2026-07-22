"""Sprint 5 Pass 6 (comment 13) — the in-app editable draft surface's
backend. Deliberately thin on citation logic: this module never re-derives
numbering or reference formatting itself, it calls straight into
proposal_orchestrator.py's _build_citation_pool/_render_citations — the
SAME functions Sprint 2 Pass 5 built — so the editor's live view and the
session's own /draft-section response can never disagree about what
citation N means. This module only owns what's genuinely new: the
drafts/draft_versions/draft_feedback tables, autosave, diff-based
feedback, and export.

Run: python -m scriptorium_ingest.analyze.draft_editor --session-id N --section-key aims --get
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..llm.dispatch import complete
from ..config import task_model
from ..db import conn
from .proposal_orchestrator import (
    _load_session, _build_citation_pool, _render_citations, _broader_survey, get_section_plan,
)


def _sanitize_text(s: str) -> str:
    """Some corpus text (an old PDF's mangled encoding, surfaced as
    mojibake like 'Î»'/'â€”') round-trips through the browser's UTF-16
    strings as a LONE surrogate — valid JS, invalid Unicode: SQLite's
    driver raises UnicodeEncodeError trying to store it, at which point
    the whole autosave/version/feedback write fails. Replacing anything
    that can't survive a real UTF-8 round-trip degrades that one
    character rather than losing the researcher's entire edit."""
    if s is None:
        return s
    return s.encode("utf-8", errors="replace").decode("utf-8")

FEEDBACK_PROMPT = """You are reviewing a researcher's EDITED grant proposal section — not \
drafting, reviewing. Give specific, actionable feedback anchored to what they actually \
changed and to the section as a whole, never a rewrite.

Funding opportunity: {program} ({sponsor})
Funder's stated priorities: {priorities}
Funder's evaluation criteria: {evaluation_criteria}

Section: "{section_label}"

What changed since the last review (unified diff, '+' added, '-' removed):
{diff}

Full current text of the section:
---
{current_text}
---

For each issue worth raising, quote the EXACT text span it concerns (copy it \
character-for-character from the current text above — this is how your comment gets \
anchored in the editor) and classify it. Focus especially on spans the diff shows as \
changed, but you may also flag a pre-existing issue in unchanged text if it's material. \
Do not comment on [[Title]] or [[CITATION NEEDED...]]/[[CONFIRM...]] markers themselves \
(those are handled separately) — comment on the prose around them.

Categories: "clarity" (hard to follow, ambiguous), "rigor" (unsupported/overclaimed), \
"funder_alignment" (drifts from the funder's stated priorities/evaluation criteria \
above), "citation_support" (a factual claim about prior work with no [[Title]] citation \
nearby, or citing something that doesn't actually support the claim).

Return ONLY a JSON array (no prose, no markdown fences), each element:
{{"quotedText": string, "comment": string, "category": string, "suggestedText": string|null}}
"quotedText" must be an exact substring of the current text (10-200 characters — long \
enough to locate unambiguously, short enough to be a real span, not the whole \
paragraph). "suggestedText" is optional concrete replacement prose for that exact span \
— null if you're only raising a concern, not proposing a fix. Return an empty array if \
the section is genuinely solid with nothing worth flagging — do not invent issues to \
fill a quota."""


def _draft_row(c, draft_id: int) -> dict:
    row = c.execute(
        "SELECT id, proposal_session_id, section_key, current_content_json, current_plain_text, "
        "current_version_number, title FROM drafts WHERE id = ?", (draft_id,),
    ).fetchone()
    cols = ["id", "proposalSessionId", "sectionKey", "currentContentJson", "currentPlainText",
            "currentVersionNumber", "title"]
    d = dict(zip(cols, row))
    if d["currentContentJson"]:
        d["currentContentJson"] = json.loads(d["currentContentJson"])
    return d


def _get_or_create_draft(c, session_id: int, section_key: str) -> dict:
    """The initial agent-generated text (proposal_sessions.state.draftSections)
    becomes version 1 the FIRST time this section is opened in the editor —
    after that, drafts/draft_versions is the source of truth, not state
    (avoids two places disagreeing about 'the current text')."""
    row = c.execute(
        "SELECT id FROM drafts WHERE proposal_session_id = ? AND section_key = ?",
        (session_id, section_key),
    ).fetchone()
    if row:
        return _draft_row(c, row[0])

    session = _load_session(c, session_id)
    state = session["state"]
    plan = state.get("sectionPlan") or get_section_plan(session["context"]["funding"]["opportunity"])
    label = plan["labels"].get(section_key, section_key)
    existing = next((s for s in state.get("draftSections", []) if s["sectionKey"] == section_key), None)
    seed_text = _sanitize_text(existing["text"]) if existing else ""

    c.execute(
        "INSERT INTO drafts (kind, title, professor_id, path, funder_program, status, "
        "proposal_session_id, section_key, current_content_json, current_plain_text, current_version_number) "
        "VALUES ('proposal', ?, ?, '', ?, 'draft', ?, ?, NULL, ?, 1)",
        (label, session["professorId"], session["context"]["funding"]["opportunity"]["program"],
         session_id, section_key, seed_text),
    )
    draft_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
    c.execute(
        "INSERT INTO draft_versions (draft_id, version_number, author_type, content_json, plain_text) "
        "VALUES (?, 1, 'agent', NULL, ?)",
        (draft_id, seed_text),
    )
    return _draft_row(c, draft_id)


def get_draft(session_id: int, section_key: str) -> dict:
    with conn() as c:
        draft = _get_or_create_draft(c, session_id, section_key)
        versions = [
            {"versionNumber": r[0], "authorType": r[1], "createdAt": r[2]}
            for r in c.execute(
                "SELECT version_number, author_type, created_at FROM draft_versions "
                "WHERE draft_id = ? ORDER BY version_number", (draft["id"],),
            ).fetchall()
        ]
        feedback_rounds = [
            {"id": r[0], "versionId": r[1], "comments": json.loads(r[2]), "createdAt": r[3]}
            for r in c.execute(
                "SELECT id, version_id, comments, created_at FROM draft_feedback "
                "WHERE draft_id = ? ORDER BY id", (draft["id"],),
            ).fetchall()
        ]
        session = _load_session(c, session_id)
    ctx = session["context"]
    pool = session["state"].get("citablePool") or _build_citation_pool(ctx, _broader_survey(ctx))
    return {"draft": draft, "versions": versions, "feedbackRounds": feedback_rounds, "citablePool": pool}


def save_working_copy(session_id: int, section_key: str, content_json: dict, plain_text: str) -> dict:
    """Autosave — updates the live working copy only, never creates a
    version row (comment 13: 'autosave the working copy... keep the last
    agent-generated version distinct'; continuous autosave is not a
    'version', a checkpoint is)."""
    with conn() as c:
        draft = _get_or_create_draft(c, session_id, section_key)
        c.execute(
            "UPDATE drafts SET current_content_json = ?, current_plain_text = ?, updated_at = unixepoch() "
            "WHERE id = ?",
            (_sanitize_text(json.dumps(content_json)), _sanitize_text(plain_text), draft["id"]),
        )
    return {"saved": True, "sectionKey": section_key}


def _resolve_span(text: str, quoted: str) -> tuple[int, int] | None:
    idx = text.find(quoted)
    if idx == -1:
        return None
    return idx, idx + len(quoted)


def request_feedback(session_id: int, section_key: str) -> dict:
    """The researcher-initiated feedback loop (comment 13). Diffs the
    current edited text against the LAST checkpoint (the previous
    feedback round's snapshot, or the original agent draft if this is the
    first request), asks the reviewer_critique model for span-anchored
    comments, snapshots the current text as a NEW checkpoint, and stores
    the comments against it. Never rewrites anything itself."""
    with conn() as c:
        draft = _get_or_create_draft(c, session_id, section_key)
        prior_row = c.execute(
            "SELECT plain_text FROM draft_versions WHERE draft_id = ? ORDER BY version_number DESC LIMIT 1",
            (draft["id"],),
        ).fetchone()
        prior_text = prior_row[0] if prior_row else ""
        current_text = draft["currentPlainText"] or prior_text

        session = _load_session(c, session_id)
    opportunity = session["context"]["funding"]["opportunity"]
    plan = session["state"].get("sectionPlan") or get_section_plan(opportunity)
    section_label = plan["labels"].get(section_key, section_key)
    eval_criteria = ", ".join(plan.get("evaluationCriteria", [])) or "(not specified by the funder)"

    diff = "\n".join(difflib.unified_diff(
        prior_text.splitlines(), current_text.splitlines(),
        fromfile="prior checkpoint", tofile="current edit", lineterm="",
    )) or "(no changes since the last checkpoint)"

    prompt = FEEDBACK_PROMPT.format(
        program=opportunity["program"], sponsor=opportunity["sponsor"],
        priorities=opportunity.get("priorities") or "(not specified)",
        evaluation_criteria=eval_criteria, section_label=section_label,
        diff=diff, current_text=current_text,
    )
    cfg = task_model("reviewer_critique")
    text = complete(prompt, model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        raw_comments = json.loads(text)
    except json.JSONDecodeError:
        raw_comments = []

    comments = []
    for i, rc in enumerate(raw_comments):
        quoted = rc.get("quotedText", "")
        span = _resolve_span(current_text, quoted)
        comments.append({
            "id": i, "quotedText": quoted,
            "spanStart": span[0] if span else None, "spanEnd": span[1] if span else None,
            "unresolved": span is None,  # honest: never silently drop a comment we couldn't anchor
            "comment": rc.get("comment", ""), "category": rc.get("category", "clarity"),
            "suggestedText": rc.get("suggestedText"), "status": "pending",
        })

    with conn() as c:
        next_version = draft["currentVersionNumber"] + 1
        c.execute(
            "INSERT INTO draft_versions (draft_id, version_number, author_type, content_json, plain_text) "
            "VALUES (?, ?, 'researcher', ?, ?)",
            (draft["id"], next_version, _sanitize_text(json.dumps(draft["currentContentJson"])),
             _sanitize_text(current_text)),
        )
        version_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        c.execute(
            "INSERT INTO draft_feedback (draft_id, version_id, comments) VALUES (?, ?, ?)",
            (draft["id"], version_id, _sanitize_text(json.dumps(comments))),
        )
        feedback_id = c.execute("SELECT last_insert_rowid()").fetchone()[0]
        c.execute("UPDATE drafts SET current_version_number = ? WHERE id = ?", (next_version, draft["id"]))

    return {"feedbackId": feedback_id, "versionId": version_id, "versionNumber": next_version,
            "comments": comments, "diff": diff}


def set_comment_status(feedback_id: int, comment_id: int, status: str) -> dict:
    if status not in ("accepted", "rejected", "ignored", "pending"):
        raise ValueError(f"Invalid status {status!r}")
    with conn() as c:
        row = c.execute("SELECT comments FROM draft_feedback WHERE id = ?", (feedback_id,)).fetchone()
        if row is None:
            raise ValueError(f"No feedback round with id {feedback_id}")
        comments = json.loads(row[0])
        found = False
        for cm in comments:
            if cm["id"] == comment_id:
                cm["status"] = status
                found = True
                break
        if not found:
            raise ValueError(f"No comment id {comment_id} in feedback round {feedback_id}")
        c.execute("UPDATE draft_feedback SET comments = ? WHERE id = ?", (json.dumps(comments), feedback_id))
    return {"feedbackId": feedback_id, "commentId": comment_id, "status": status}


def compile_document(session_id: int) -> dict:
    """One shared 'what does the final document look like' function —
    both export_docx.py and any future export format call this, so they
    can never drift from each other or from what the editor showed."""
    with conn() as c:
        session = _load_session(c, session_id)
        ctx = session["context"]
        state = session["state"]
        plan = state.get("sectionPlan") or get_section_plan(ctx["funding"]["opportunity"])
        pool = state.get("citablePool") or _build_citation_pool(ctx, [])

        draft_sections = []
        for key in plan["order"]:
            row = c.execute(
                "SELECT current_plain_text FROM drafts WHERE proposal_session_id = ? AND section_key = ?",
                (session_id, key),
            ).fetchone()
            if row and row[0]:
                text = row[0]
            else:
                existing = next((s for s in state.get("draftSections", []) if s["sectionKey"] == key), None)
                text = existing["text"] if existing else None
            if text is not None:
                draft_sections.append({"sectionKey": key, "label": plan["labels"].get(key, key),
                                        "text": text, "revisionCount": 0})

    rendered = _render_citations(plan, draft_sections, pool)
    opportunity = ctx["funding"]["opportunity"]
    return {
        "title": f"{opportunity['program']} — {opportunity['sponsor']}",
        "sections": rendered["sections"], "references": rendered["references"],
        "unresolvedCitations": rendered["unresolvedCitations"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", type=int, required=True)
    ap.add_argument("--section-key", default=None)
    ap.add_argument("--get", action="store_true")
    ap.add_argument("--save", action="store_true", help="read {contentJson, plainText} JSON from stdin")
    ap.add_argument("--request-feedback", action="store_true")
    ap.add_argument("--set-comment-status", action="store_true",
                     help="read {feedbackId, commentId, status} JSON from stdin")
    ap.add_argument("--compile", action="store_true")
    args = ap.parse_args()

    if args.get:
        print(json.dumps(get_draft(args.session_id, args.section_key), indent=2))
    elif args.save:
        # stdin, not a CLI arg: editor content can be long enough to hit
        # Windows' command-line length limit.
        payload = json.loads(sys.stdin.read())
        print(json.dumps(save_working_copy(args.session_id, args.section_key,
                                            payload["contentJson"], payload["plainText"]), indent=2))
    elif args.request_feedback:
        print(json.dumps(request_feedback(args.session_id, args.section_key), indent=2))
    elif args.set_comment_status:
        payload = json.loads(sys.stdin.read())
        print(json.dumps(set_comment_status(payload["feedbackId"], payload["commentId"], payload["status"]), indent=2))
    elif args.compile:
        print(json.dumps(compile_document(args.session_id), indent=2))
    else:
        raise SystemExit("Specify --get, --save, --request-feedback, --set-comment-status, or --compile")


if __name__ == "__main__":
    main()
