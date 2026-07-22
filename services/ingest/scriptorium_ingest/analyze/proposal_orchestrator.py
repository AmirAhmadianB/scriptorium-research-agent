"""Pass 3.2/3.3 — the Proposal tab's orchestrator (Change 3). Operates on a
proposal_sessions row created by Pass 3.1's POST /api/proposal/sessions
(apps/api/src/routes/proposal.ts), which already correlated literature +
corpus + funding + Research Focus context. This module adds the LLM turns
on top of that context — brainstorming gaps (Pass 3.2) and, later,
step-by-step drafting (Pass 3.3) — routed through claude_cli.complete()
like every other LLM call in this project (no separate billed API key).

Human-in-the-loop by construction: brainstorm_gaps() only PROPOSES and
never runs unless explicitly called (by the researcher clicking "Brainstorm
gaps" in the dashboard); confirm_gaps() only records what the researcher
answered, no LLM call, no side effects beyond persisting the answer.

Run: python -m scriptorium_ingest.analyze.proposal_orchestrator --session-id N --brainstorm-gaps
"""
from __future__ import annotations

import argparse
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..llm.dispatch import complete
from ..config import CONFIG_DIR, task_model
from ..db import conn, log_run
from ..connectors import openalex
from ..knowledge.store import load_graph
from ..llm.backend import ClaudeCliBackend
from ..llm.cost import LoopCostTracker
from ..llm.json_parser import JSONParser

PERSONA_PATH = CONFIG_DIR.parent / ".claude" / "agents" / "proposal-writer.md"

# Pass 3.3: a generic proposal skeleton — structural roles, not domain
# content, so it never hardcodes a discipline (Global Constraint). Order
# matters: each section is drafted only after the ones before it, so later
# sections can reference earlier ones (e.g. "approach" answers "aims").
SECTION_ORDER = ["aims", "background", "gap", "approach", "broader_impact"]
SECTION_LABELS = {
    "aims": "Specific Aims",
    "background": "Background and Significance",
    "gap": "The Gap This Proposal Addresses",
    "approach": "Approach",
    "broader_impact": "Broader Impact / Outcomes",
}

GAPS_PROMPT = """You help a researcher brainstorm literature gaps worth building a grant \
proposal around, for a specific funding opportunity. Ground every gap in the \
evidence below — do not propose a generic gap unconnected to what's actually \
been provided. Do not invent a research domain; infer it entirely from the \
context below.

A candidate gap is NEVER a bare paper title presented as an option — it is a \
short synthesized statement of what's missing, why it matters, and which \
specific articles evidence the gap.

Research group's focus: {focus_synthesis_or_keywords}

Funding opportunity: {program} ({sponsor})
Eligibility / call text: {eligibility}

Corpus synthesis (the group's own prior work, if any):
{corpus_synthesis}

Corpus evidence passages (grounded, cite these by title when relevant):
{corpus_passages}

Recent literature already tracked on the radar:
{literature_titles}

Broader literature survey (fresh open-scholarly-search results for this \
field, may include work not yet in the radar or corpus):
{broader_survey_titles}

Structural gap hints (Sprint 3 — from the entity graph, NOT the language \
model: concepts that sit BETWEEN two well-studied topic clusters in this \
corpus with no direct connection between the clusters themselves — a \
Swanson-style undiscovered linkage. Treat these as a strong signal worth \
investigating, not a requirement to use):
{structural_gap_hints}

Propose 3-5 candidate research gaps this group could credibly address for \
this funding opportunity, drawing on ALL the evidence sections above — not \
just the radar, and not only your own free association. Where a structural \
gap hint above genuinely fits the funding opportunity, prefer it — it is \
grounded in the corpus's actual connectivity, not guessed. For each gap, \
you MUST cite at least one specific source from the evidence above BY ITS \
EXACT TITLE (from the corpus passages, literature radar, or broader \
survey) — never a vague "prior work shows..." with no title. If the \
evidence above is too thin to ground any real gap, say so honestly (return \
fewer gaps, or an empty list) rather than inventing citations.

Return ONLY a JSON array (no prose, no markdown fences), each element:
{{"gap": string, "citedSources": [string, ...], "rationale": string}}
"citedSources" entries must be exact titles copied from the evidence above."""


def _load_session(c, session_id: int) -> dict:
    row = c.execute(
        "SELECT id, professor_id, funding_opportunity_id, status, context, state FROM proposal_sessions WHERE id = ?",
        (session_id,),
    ).fetchone()
    if row is None:
        raise ValueError(f"No proposal session with id {session_id}")
    return {
        "id": row[0], "professorId": row[1], "fundingOpportunityId": row[2],
        "status": row[3], "context": json.loads(row[4]), "state": json.loads(row[5]),
    }


def _save_session(c, session_id: int, status: str, state: dict) -> None:
    c.execute(
        "UPDATE proposal_sessions SET status = ?, state = ?, updated_at = unixepoch() WHERE id = ?",
        (status, json.dumps(state), session_id),
    )


def _broader_survey(ctx: dict) -> list[dict]:
    """Sprint 2 Pass 5 (comment 10): 'surveys the main research articles
    available online for the focus area ... via open scholarly search' —
    distinct from ctx['literature']['recentPapers'], which only reflects
    what the literature radar already crawled into this DB. Reuses the
    SAME OpenAlex connector run_scan.py already uses (no second search
    client), just called live/synchronously here instead of via the
    crawl-and-store pipeline. Best-effort: an unreachable API degrades to
    an empty survey rather than blocking gap brainstorming."""
    focus = ctx["researchFocus"]
    query = " ".join(focus.get("keywords", [])[:6]) or ctx["funding"]["opportunity"].get("program", "")
    if not query.strip():
        return []
    try:
        from datetime import date
        return openalex.search(query, since_year=date.today().year - 4, per_page=25, max_records=25)
    except Exception:
        return []


def _structural_gap_hints(ctx: dict, professor_id: str, steps: int = 2, max_seeds: int = 6) -> str:
    """Sprint 3 Pass 4 — 'using graph get_nodes_intersection plus n-hop to
    surface structural gaps (clusters with no direct edge), not only LLM
    free-association.' Seeds are the titles already in this session's
    literature radar (ctx, not a fresh DB read) — the graph itself was
    populated by knowledge/ingest.py (Pass 2) from the full corpus.
    Best-effort: an empty/unpopulated graph degrades to no hints, never an
    error (a fresh install with an empty graph should still be able to
    brainstorm gaps from the LLM-only evidence)."""
    try:
        graph = load_graph(professor_id)
    except Exception:
        return "(entity graph not yet populated for this professor — run knowledge/ingest.py)"
    if graph.size() < 3:
        return "(entity graph has too few nodes yet — structural gap-finding needs a populated corpus)"

    seed_titles = [p["title"] for p in ctx["literature"]["recentPapers"][:max_seeds] if p.get("title")]
    seed_nodes = []
    for title in seed_titles:
        hits = graph.semantic_search(title, topk_k=1, similarity_threshold=0.3)
        if hits:
            seed_nodes.append(hits[0])

    hints = []
    seen_pairs: set[tuple[str, str]] = set()
    for i, a in enumerate(seed_nodes):
        for b in seed_nodes[i + 1:]:
            if a.id == b.id:
                continue
            pair_key = tuple(sorted([a.id, b.id]))
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)
            # Already directly linked (e.g. same paper) — not a structural
            # gap, it's a known connection.
            if b in a.neighbors:
                continue
            bridge = graph.get_nodes_intersection([a, b], steps=steps)
            bridge_concepts = [n.content for n in bridge if n.label == "concept"][:5]
            if bridge_concepts:
                hints.append(f"- Between \"{a.content}\" and \"{b.content}\": {', '.join(bridge_concepts)}")
            if len(hints) >= 8:
                break
        if len(hints) >= 8:
            break

    return "\n".join(hints) if hints else "(no structural bridges found between the current radar's topics)"


def _citation_key(title: str) -> str:
    return re.sub(r"\s+", " ", title or "").strip().lower()


def _build_citation_pool(ctx: dict, broader_survey: list[dict]) -> dict[str, dict]:
    """One dedupe key (lowercased title) -> IEEE-fielded source record, built
    from every evidence source draft_section()/brainstorm_gaps() can cite
    from. Persisted on the session (state.citablePool) so numbering stays
    resolvable against the SAME pool across an entire drafting session."""
    pool: dict[str, dict] = {}

    def add(title, authors=None, venue=None, year=None, doi=None, url=None):
        title = (title or "").strip()
        if not title:
            return
        key = _citation_key(title)
        if key not in pool:
            pool[key] = {"title": title, "authors": authors or [], "venue": venue,
                         "year": year, "doi": doi, "url": url}

    for p in ctx["literature"]["recentPapers"]:
        add(p.get("title"), p.get("authors"), p.get("venue"), p.get("year"), p.get("doi"), p.get("oaUrl"))
    for c in ctx["corpus"]["relevantChunks"]:
        add(c.get("paperTitle"), c.get("authors"), c.get("venue"), c.get("year"), c.get("doi"), c.get("oaUrl"))
    for w in broader_survey:
        add(w.get("title"), w.get("authors"), w.get("venue"), w.get("year"), w.get("doi"), w.get("oa_url"))
    return pool


def brainstorm_gaps(session_id: int) -> dict:
    with conn() as c:
        session = _load_session(c, session_id)
    ctx = session["context"]
    focus = ctx["researchFocus"]
    focus_desc = focus.get("focusSynthesis") or ("Keywords: " + ", ".join(focus.get("keywords", []))) \
        or "No Research Focus set — infer the field entirely from the evidence below."

    corpus_passages = "\n".join(
        f"- \"{p['paperTitle']}\" ({p.get('sectionHead') or 'excerpt'}): {p['snippet'][:300]}"
        for p in ctx["corpus"]["relevantChunks"]
    ) or "(none — no corpus evidence gathered for this opportunity)"
    literature_titles = "\n".join(
        f"- \"{p['title']}\" ({p.get('year') or 'n.d.'}, {p.get('venue') or 'unknown venue'})"
        for p in ctx["literature"]["recentPapers"]
    ) or "(none)"
    broader = _broader_survey(ctx)
    broader_survey_titles = "\n".join(
        f"- \"{w['title']}\" ({w.get('year') or 'n.d.'}, {w.get('venue') or 'unknown venue'})"
        for w in broader if w.get("title")
    ) or "(open scholarly search returned nothing usable — proceed on the corpus/radar evidence above)"
    structural_gap_hints = _structural_gap_hints(ctx, session["professorId"])

    prompt = GAPS_PROMPT.format(
        focus_synthesis_or_keywords=focus_desc,
        program=ctx["funding"]["opportunity"]["program"],
        sponsor=ctx["funding"]["opportunity"]["sponsor"],
        eligibility=ctx["funding"]["opportunity"].get("eligibility") or "(not specified)",
        corpus_synthesis=ctx["corpus"].get("synthesis") or "(none yet)",
        corpus_passages=corpus_passages,
        literature_titles=literature_titles,
        broader_survey_titles=broader_survey_titles,
        structural_gap_hints=structural_gap_hints,
    )
    cfg = task_model("proposal_drafting")
    text = complete(prompt, model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    gaps_raw = json.loads(text)

    gaps = [{"id": i, "gap": g["gap"], "citedSources": g.get("citedSources", []),
              "rationale": g.get("rationale", ""), "researcherAnswer": None, "source": "agent"}
             for i, g in enumerate(gaps_raw)]

    citable_pool = _build_citation_pool(ctx, broader)

    with conn() as c:
        session = _load_session(c, session_id)  # re-load in case anything changed
        # Sprint 4 (C3): preserve any researcher-suggested gaps (or any
        # already-answered gap) already on the session rather than wiping
        # them — brainstorming is additive, not a reset. In practice the
        # UI only offers "Brainstorm gaps" before any gaps exist, but a
        # direct API/CLI call should still behave safely either way.
        prior = [g for g in session["state"].get("gaps", [])
                 if g.get("source") == "researcher" or g.get("researcherAnswer") is not None]
        next_id = (max((g["id"] for g in prior), default=-1)) + 1
        for g in gaps:
            g["id"] += next_id
        state = {**session["state"], "gaps": prior + gaps, "citablePool": citable_pool}
        _save_session(c, session_id, "gaps_proposed", state)
    return {"sessionId": session_id, "status": "gaps_proposed", "gaps": prior + gaps}


def confirm_gaps(session_id: int, answers: list[dict]) -> dict:
    """answers: [{"id": int, "suitable": bool, "editedGap": str|None}, ...].
    Pure bookkeeping, no LLM call — Pass 3.3's drafting step is the thing
    gated on this having happened, not this function itself. editedGap
    (Pass 5, comment 10's 'confirm, edit, or reject') lets the researcher
    correct the synthesized statement before it's used to ground drafting;
    citedSources/rationale are left as originally proposed since they
    justify the ORIGINAL statement — an edit is the researcher's revision on
    top of that evidence, not a request for new evidence."""
    answer_by_id = {a["id"]: a for a in answers}
    with conn() as c:
        session = _load_session(c, session_id)
        gaps = session["state"].get("gaps", [])
        for g in gaps:
            a = answer_by_id.get(g["id"])
            if a is None:
                continue
            g["researcherAnswer"] = a["suitable"]
            if a.get("editedGap"):
                g["gap"] = a["editedGap"]
                g["edited"] = True
        any_suitable = any(g["researcherAnswer"] is True for g in gaps)
        status = "gaps_confirmed" if any_suitable else "gaps_rejected"
        # Compute the section plan as soon as drafting becomes possible (not
        # only lazily on the first draft-section call) so the UI can render
        # the funder's real section list — and the isFallback notice — before
        # the researcher has drafted anything.
        plan = session["state"].get("sectionPlan")
        if any_suitable and not plan:
            plan = get_section_plan(session["context"]["funding"]["opportunity"])
        state = {**session["state"], "gaps": gaps, **({"sectionPlan": plan} if plan else {})}
        _save_session(c, session_id, status, state)
    return {"sessionId": session_id, "status": status, "gaps": gaps, "sectionPlan": plan}


GROUNDING_PROMPT = """A researcher has proposed their OWN research gap for a grant \
proposal — do not rewrite, rephrase, or replace their statement; your job is only to \
ground it in evidence and report honestly on what the corpus shows, for the \
researcher's own review before they decide whether to proceed.

Research group's focus: {focus_synthesis_or_keywords}

Funding opportunity: {program} ({sponsor})
Eligibility / call text: {eligibility}

The researcher's proposed gap (verbatim — do not alter this in your response):
{statement}

Reference notes the researcher supplied (may be empty):
{reference_notes}

Supporting evidence found in the corpus (vector search):
{corpus_evidence}

Adjacent/related work found in the entity graph:
{graph_evidence}

Tasks:
1. "citedSources": which of the supporting-evidence titles above genuinely back this \
gap (exact titles only, copy them character-for-character) — an empty list is fine \
and honest if none genuinely support it.
2. "rationale": 2-4 sentences justifying why this gap is worth pursuing GIVEN the \
evidence above, including a brief note on fit with this funding opportunity's \
priorities/eligibility. Ground every claim in the evidence — never invent support \
that is not there.
3. "overlapFlag": true ONLY if the supporting evidence suggests this exact gap is \
ALREADY substantially addressed by existing work (i.e. it may not be as novel as the \
researcher thinks) — be honest even though this is the researcher's own idea; false \
otherwise.
4. "overlapExplanation": if overlapFlag is true, name the specific paper(s) that \
already substantially address this gap and why; empty string if overlapFlag is false.

Return ONLY a JSON object (no prose, no markdown fences):
{{"citedSources": [string, ...], "rationale": string, "overlapFlag": boolean, \
"overlapExplanation": string}}"""


def suggest_gap(session_id: int, statement: str, reference_notes: str | None = None) -> dict:
    """Sprint 4 (C3) — the researcher hands the pipeline a gap instead of
    waiting on brainstorm_gaps(). The agent grounds it (vector-search the
    corpus via the SAME query_corpus() ask_corpus.py uses, query the SAME
    entity graph Sprint 3 built) and reports honestly, but 'the gap is
    theirs; the agent enriches, never overrides' — the statement text
    itself is stored VERBATIM, never LLM-rewritten. Produces the identical
    record shape brainstorm_gaps() does (source='researcher' instead of
    'agent') so every downstream consumer (confirm_gaps, draft_section,
    the critique judge) needs no source-specific branch."""
    if not statement.strip():
        raise ValueError("A gap statement is required.")

    from .corpus_ingest import query_corpus

    with conn() as c:
        session = _load_session(c, session_id)
    ctx = session["context"]
    professor_id = session["professorId"]

    hits = query_corpus(statement, professor_id, k=8)
    supporting = [h for h in hits if h["score"] >= 0.30]
    corpus_evidence = "\n".join(
        f"- \"{h['paperTitle']}\" (score {h['score']:.2f}, {h.get('sectionHead') or 'excerpt'}): {h['snippet'][:300]}"
        for h in supporting
    ) or "(no sufficiently relevant corpus passages found)"

    graph_hits: list = []
    try:
        graph = load_graph(professor_id)
        if graph.size() >= 1:
            graph_hits = graph.query_by_content(statement, topk_k=8, step=1, similarity_threshold=0.25)
    except Exception:
        graph_hits = []
    graph_evidence = "\n".join(f"- ({n.label}) {n.content}" for n in graph_hits) \
        or "(no related nodes found in the entity graph — it may not be populated yet)"

    focus = ctx["researchFocus"]
    focus_desc = focus.get("focusSynthesis") or ("Keywords: " + ", ".join(focus.get("keywords", []))) \
        or "No Research Focus set — infer the field entirely from the evidence below."

    prompt = GROUNDING_PROMPT.format(
        focus_synthesis_or_keywords=focus_desc,
        program=ctx["funding"]["opportunity"]["program"],
        sponsor=ctx["funding"]["opportunity"]["sponsor"],
        eligibility=ctx["funding"]["opportunity"].get("eligibility") or "(not specified)",
        statement=statement, reference_notes=reference_notes or "(none)",
        corpus_evidence=corpus_evidence, graph_evidence=graph_evidence,
    )
    cfg = task_model("knowledge_curation")
    text = complete(prompt, model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    parsed = json.loads(text)

    grounding_report = {
        "supportingPapers": [
            {"title": h["paperTitle"], "score": h["score"], "snippet": h["snippet"][:300]} for h in supporting
        ],
        "adjacentWork": [{"content": n.content, "label": n.label} for n in graph_hits],
        "overlapFlag": bool(parsed.get("overlapFlag", False)),
        "overlapExplanation": parsed.get("overlapExplanation", ""),
    }

    with conn() as c:
        session = _load_session(c, session_id)  # re-load in case anything changed
        existing_gaps = session["state"].get("gaps", [])
        next_id = (max((g["id"] for g in existing_gaps), default=-1)) + 1
        gap_record = {
            "id": next_id, "gap": statement.strip(), "citedSources": parsed.get("citedSources", []),
            "rationale": parsed.get("rationale", ""), "researcherAnswer": None,
            "source": "researcher", "referenceNotes": reference_notes or None,
            "groundingReport": grounding_report,
        }
        gaps = existing_gaps + [gap_record]
        state = {**session["state"], "gaps": gaps}
        # gaps_proposed is the SAME status brainstorm_gaps() sets — the
        # frontend's confirm/edit/reject UI doesn't need to know which
        # pipeline produced the list it's rendering.
        new_status = session["status"] if session["status"] not in ("idle",) else "gaps_proposed"
        _save_session(c, session_id, new_status, state)
    return {"sessionId": session_id, "status": new_status, "gap": gap_record, "groundingReport": grounding_report}


def _persona_body() -> str:
    text = PERSONA_PATH.read_text(encoding="utf-8")
    return re.sub(r"^---.*?---\s*", "", text, flags=re.S).strip()


DRAFT_PROMPT = """Draft ONE section of a grant proposal — {section_label} — and nothing else. \
Do not draft any other section, do not write a full proposal, stop after this \
one section. Ground every claim in the evidence below; if evidence is thin, \
say so plainly rather than inventing results, collaborators, or numbers.

Research group's focus: {focus_synthesis_or_keywords}

Funding opportunity: {program} ({sponsor})
Eligibility / call text: {eligibility}

Confirmed research gap(s) this proposal addresses (the researcher explicitly \
approved these — do not substitute a different gap):
{confirmed_gaps}

Corpus synthesis (the group's own prior work):
{corpus_synthesis}

Corpus evidence passages:
{corpus_passages}

Recent literature:
{literature_titles}

Citable sources for this section — the ONLY sources you may cite (each is a \
title from the evidence above):
{citable_titles}

CITATION RULE (IEEE-style, enforced downstream by exact string matching — \
follow it precisely): every factual claim about prior work MUST be followed \
immediately by the source's EXACT title wrapped in double square brackets, \
e.g. "prior methods struggle with low-photon-count regimes [[Low Photon \
Count Phase Retrieval Using Deep Learning.]]". Copy the title character-for-\
character from the citable-sources list above — do not paraphrase, abbreviate, \
or invent a title. If a claim about prior work has no matching source in that \
list, do not make the claim. These [[...]] markers are mechanically converted \
to numbered "[n]" citations and an IEEE reference list after you respond — do \
not write "[1]" or any bracketed number yourself, and do not write a \
references section yourself. This is separate from your existing \
[[CITATION NEEDED — ...]] / [[CONFIRM: ...]] gap-flagging convention — keep \
using those exactly as before for genuine gaps; only [[Exact Title]] is \
treated as a citation.

{prior_sections_block}
{revision_block}

Write the "{section_label}" section now. Return ONLY the section prose (you \
may use the section heading as a first line), no other commentary."""


def _confirmed_gaps_block(gaps: list[dict]) -> str:
    confirmed = [g for g in gaps if g.get("researcherAnswer") is True]
    if not confirmed:
        return "(none confirmed — do not draft without at least one confirmed gap)"
    return "\n".join(f"- {g['gap']} (cites: {', '.join(g['citedSources'])})" for g in confirmed)


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "section"


def get_section_plan(opportunity: dict) -> dict:
    """Sprint 2 Pass 4 (comment 9): draft against the FUNDER's own proposal
    structure when Pass 4's extraction found one; fall back to the generic
    skeleton — and say so (isFallback) — only when it didn't. Computed once
    per session and persisted in state.sectionPlan so the order/labels stay
    stable across a whole drafting conversation even if the opportunity
    record is later re-crawled."""
    template = opportunity.get("proposalTemplate")
    sections = template.get("sections") if template else None
    if not sections:
        return {"order": SECTION_ORDER, "labels": SECTION_LABELS, "isFallback": True,
                "evaluationCriteria": []}
    order, labels = [], {}
    for sec in sections:
        key = _slugify(sec["name"])
        order.append(key)
        labels[key] = sec["name"]
    return {"order": order, "labels": labels, "isFallback": False,
            "evaluationCriteria": template.get("evaluation_criteria", [])}


_CITE_MARKER = re.compile(r"\[\[([^\[\]]{1,300})\]\]")


def _ieee_entry(src: dict) -> dict:
    authors = src.get("authors") or []
    author_str = None
    if isinstance(authors, list) and authors:
        names = [a.get("name") if isinstance(a, dict) else a for a in authors[:6]]
        names = [n for n in names if n]
        if names:
            author_str = ", ".join(names) + (" et al." if len(authors) > 6 else "")
    bits = []
    if author_str:
        bits.append(f"{author_str},")
    bits.append(f"\"{src['title']},\"")
    if src.get("venue"):
        bits.append(f"{src['venue']},")
    if src.get("year"):
        bits.append(f"{src['year']}.")
    if src.get("doi"):
        bits.append(f"doi: {src['doi']}.")
    elif src.get("url"):
        bits.append(f"[Online]. Available: {src['url']}")
    return {"n": src["n"], "title": src["title"], "ieee": f"[{src['n']}] " + " ".join(bits)}


def _render_citations(plan: dict, draft_sections: list[dict], pool: dict[str, dict]) -> dict:
    """Sprint 2 Pass 5 (comment 11): recomputed FRESH from the raw [[Title]]
    markers every time draft_section() runs — never a persisted number
    registry — so 'renumbering stays consistent after an edit' holds by
    construction: numbers are assigned by first appearance walking drafted
    sections in the session's fixed plan order (sections are always drafted
    forward through that order; a revision replaces a section's text in
    place, so re-walking the same order after a revision naturally reflows
    numbering with no special-case logic). Unresolved markers (a title the
    model wrote that doesn't exactly match the citable pool) are left
    visible as [[Title]] rather than silently dropped or fabricated a
    number — a caller can surface unresolvedCitations as a defect to fix."""
    order = plan["order"]
    by_key = {s["sectionKey"]: s for s in draft_sections}
    numbers: dict[str, int] = {}
    references: list[dict] = []
    unresolved: set[str] = set()

    def substitute(match: re.Match) -> str:
        title = match.group(1).strip()
        # The proposal-writer persona (a pre-existing, shared seam — see
        # .claude/agents/proposal-writer.md) has its OWN double-bracket
        # convention for honest gap-flagging: [[CITATION NEEDED — ...]] and
        # [[CONFIRM: ...]]. Those are not citation attempts and must not be
        # treated as unresolved citations (which would misreport a deliberate,
        # correct "I won't fabricate this" as a defect) — leave them verbatim.
        if re.match(r"^(CITATION NEEDED|CONFIRM)\b", title, re.I):
            return match.group(0)
        key = _citation_key(title)
        src = pool.get(key)
        if not src:
            unresolved.add(title)
            return f"[[{title}]]"
        if key not in numbers:
            numbers[key] = len(references) + 1
            references.append({"n": numbers[key], **src})
        return f"[{numbers[key]}]"

    rendered_sections = []
    for key in order:
        sec = by_key.get(key)
        if not sec:
            continue
        rendered_sections.append({
            "sectionKey": key, "label": sec["label"], "revisionCount": sec["revisionCount"],
            "text": _CITE_MARKER.sub(substitute, sec["text"]),
        })

    return {
        "sections": rendered_sections,
        "references": [_ieee_entry(r) for r in references],
        "unresolvedCitations": sorted(unresolved),
    }


def draft_section(session_id: int, section_key: str, feedback: str | None = None) -> dict:
    with conn() as c:
        session = _load_session(c, session_id)
    if session["status"] not in ("gaps_confirmed", "drafting"):
        # The actual enforcement point for "never generates a full proposal
        # unprompted" / "not until confirmed": no code path reaches the LLM
        # call below unless a researcher already confirmed at least one gap.
        raise ValueError(
            f"Session {session_id} is '{session['status']}', not 'gaps_confirmed'/'drafting' — "
            "draft a section only after the researcher has confirmed at least one gap as suitable."
        )

    ctx = session["context"]
    state = session["state"]
    gaps = state.get("gaps", [])
    if not any(g.get("researcherAnswer") is True for g in gaps):
        raise ValueError("No confirmed (suitable=true) gap on this session — cannot draft.")

    plan = state.get("sectionPlan") or get_section_plan(ctx["funding"]["opportunity"])
    if section_key not in plan["order"]:
        raise ValueError(f"Unknown section {section_key!r}; must be one of {plan['order']}")
    section_labels = plan["labels"]

    existing = {sec["sectionKey"]: sec for sec in state.get("draftSections", [])}
    prior_sections_block = ""
    if existing:
        prior_sections_block = "Already-drafted sections (for continuity, do not repeat them):\n" + "\n".join(
            f"--- {section_labels.get(k, k)} ---\n{v['text'][:1500]}" for k, v in existing.items() if k != section_key
        )
    revision_block = ""
    if feedback and section_key in existing:
        revision_block = (
            f"You previously drafted this section as:\n---\n{existing[section_key]['text']}\n---\n"
            f"The researcher's feedback to incorporate: {feedback}\n"
            "Revise the section accordingly — this REPLACES the previous draft, it is not an addendum."
        )

    focus = ctx["researchFocus"]
    focus_desc = focus.get("focusSynthesis") or ("Keywords: " + ", ".join(focus.get("keywords", []))) \
        or "No Research Focus set — infer the field entirely from the evidence below."
    corpus_passages = "\n".join(
        f"- \"{p['paperTitle']}\" ({p.get('sectionHead') or 'excerpt'}): {p['snippet'][:300]}"
        for p in ctx["corpus"]["relevantChunks"]
    ) or "(none)"
    literature_titles = "\n".join(f"- \"{p['title']}\"" for p in ctx["literature"]["recentPapers"]) or "(none)"

    # Sprint 2 Pass 5 (comment 11): the SAME pool brainstorm_gaps() built (so
    # numbering stays resolvable against it all session), rebuilt fresh only
    # if this session predates Pass 5 / skipped brainstorming's pool build.
    pool = state.get("citablePool") or _build_citation_pool(ctx, [])
    citable_titles = "\n".join(f"- {src['title']}" for src in pool.values()) or "(none — do not cite anything)"

    prompt = _persona_body() + "\n\n" + DRAFT_PROMPT.format(
        section_label=section_labels[section_key],
        focus_synthesis_or_keywords=focus_desc,
        program=ctx["funding"]["opportunity"]["program"],
        sponsor=ctx["funding"]["opportunity"]["sponsor"],
        eligibility=ctx["funding"]["opportunity"].get("eligibility") or "(not specified)",
        confirmed_gaps=_confirmed_gaps_block(gaps),
        corpus_synthesis=ctx["corpus"].get("synthesis") or "(none yet)",
        corpus_passages=corpus_passages,
        literature_titles=literature_titles,
        citable_titles=citable_titles,
        prior_sections_block=prior_sections_block,
        revision_block=revision_block,
    )
    cfg = task_model("proposal_drafting")
    text = complete(prompt, model=cfg["model"]).strip()

    with conn() as c:
        session = _load_session(c, session_id)  # re-load in case of concurrent edits
        sections = [sec for sec in session["state"].get("draftSections", []) if sec["sectionKey"] != section_key]
        revision_count = existing[section_key]["revisionCount"] + 1 if section_key in existing else 0
        # text still carries raw [[Title]] markers here — resolved to [n] +
        # a reference list only at render time (below), never baked in, so a
        # later revision of an EARLIER section can't leave this section's
        # numbers stale.
        sections.append({"sectionKey": section_key, "label": section_labels[section_key],
                          "text": text, "revisionCount": revision_count})
        rendered = _render_citations(plan, sections, pool)
        # Persist the plan itself (not just draftSections) — computed once,
        # from here on every read/draft call for this session uses the SAME
        # order/labels even if the opportunity's proposalTemplate changes
        # underneath it (e.g. a re-crawl).
        state = {**session["state"], "draftSections": sections, "sectionPlan": plan,
                  "citablePool": pool, "rendered": rendered}
        _save_session(c, session_id, "drafting", state)
    return {"sessionId": session_id, "status": "drafting", "sectionKey": section_key, "text": text,
            "sectionPlan": plan, "rendered": rendered,
            "nextSection": next((k for k in plan["order"] if k not in {s["sectionKey"] for s in sections}), None)}


CRITIQUE_PROMPT = """You are a skeptical grant-review judge, not the author. Score this \
draft section against three rubrics, each 0-10 (10 = excellent):

1. Novelty against corpus: does the section identify something genuinely not already \
established in the group's own corpus synthesis / cited work, or does it restate known \
results as if new?
2. Funder-scope fit: does the section align with what this funder's own stated \
priorities and eligibility criteria (below) actually reward?
3. Testable aims: are the claims/aims stated concretely enough to be evaluated as met \
or not met by the end of the project — not vague aspirations?

Funding opportunity: {program} ({sponsor})
Funder priorities: {priorities}
Eligibility / call text: {eligibility}

Corpus synthesis (the group's own prior work):
{corpus_synthesis}

The confirmed gap this section addresses:
{gap_text}

Section drafted ("{section_label}"):
---
{section_text}
---

Return ONLY a JSON object (no prose, no markdown fences):
{{"novelty": int, "funderScopeFit": int, "testableAims": int, "rationale": string, \
"revisionSuggestions": string}}
"rationale" explains the three scores in 2-4 sentences. "revisionSuggestions" is \
concrete, actionable feedback the drafting agent could apply directly — phrase it as \
an instruction ("State the expected effect size for...") not a complaint ("the aims \
are vague")."""


def critique_draft(ctx: dict, gap_text: str, section_label: str, section_text: str,
                    backend: "ClaudeCliBackend") -> dict:
    """Sprint 3 Pass 4 — the loop's manufactured feedback signal (the brief's
    'feedback problem': proposal writing has no objective ground truth the
    way code-that-runs does, so an LLM-judge against explicit rubrics plus
    the researcher's own review is the substitute). Uses config/models.yaml's
    existing eval_judge task — 'kept distinct so /test-models can vary it' —
    rather than a new model-routing entry."""
    opportunity = ctx["funding"]["opportunity"]
    prompt = CRITIQUE_PROMPT.format(
        program=opportunity["program"], sponsor=opportunity["sponsor"],
        priorities=opportunity.get("priorities") or "(not specified)",
        eligibility=opportunity.get("eligibility") or "(not specified)",
        corpus_synthesis=ctx["corpus"].get("synthesis") or "(none yet)",
        gap_text=gap_text, section_label=section_label, section_text=section_text,
    )
    result = backend.complete_for_task(prompt, task="eval_judge")
    parsed = JSONParser().parse_obj(result.content)
    scores = {"novelty": int(parsed["novelty"]), "funderScopeFit": int(parsed["funderScopeFit"]),
              "testableAims": int(parsed["testableAims"])}
    return {
        "scores": scores, "overallScore": round(sum(scores.values()) / 3, 2),
        "rationale": parsed.get("rationale", ""),
        "revisionSuggestions": parsed.get("revisionSuggestions", ""),
    }


def run_proposal_loop(session_id: int, section_key: str, max_iterations: int = 3,
                       convergence_threshold: float = 8.0, feedback: str | None = None) -> dict:
    """Sprint 3 Pass 4 — propose already ran as brainstorm_gaps() (R, graph-
    informed via _structural_gap_hints). This is D (draft_section(), reused
    verbatim — no second drafting path) plus critique, capped by whichever
    of max_iterations/convergence_threshold comes first, with per-loop cost
    logged. The interactor ('present, collect edits, rewrite') is the
    EXISTING feedback-revision flow already exposed by /draft-section: this
    loop's final draft is returned through that same shape, and the
    researcher can still submit further feedback against it after the loop
    stops. This automates the first few refinement rounds; it never
    replaces the human review step."""
    from ..llm.backend import estimate_tokens, LLMCallResult
    import time

    with conn() as c:
        session = _load_session(c, session_id)
    gaps = session["state"].get("gaps", [])
    confirmed_gap = next((g for g in gaps if g.get("researcherAnswer") is True), None)
    if confirmed_gap is None:
        raise ValueError("No confirmed (suitable=true) gap on this session — cannot run the loop.")
    gap_text = confirmed_gap["gap"]

    tracker = LoopCostTracker()
    backend = ClaudeCliBackend(cost_tracker=tracker)

    iterations: list[dict] = []
    current_feedback = feedback
    draft_result: dict | None = None
    termination_reason = "cap_reached"

    for i in range(max_iterations):
        start = time.monotonic()
        draft_result = draft_section(session_id, section_key, feedback=current_feedback)
        duration = time.monotonic() - start
        prompt_estimate = gap_text + (current_feedback or "")
        tracker.record(LLMCallResult(
            content=draft_result["text"], model=task_model("proposal_drafting")["model"],
            fallback_used=False, estimated_input_tokens=estimate_tokens(prompt_estimate),
            estimated_output_tokens=estimate_tokens(draft_result["text"]), duration_seconds=duration,
        ))

        with conn() as c:
            ctx = _load_session(c, session_id)["context"]
        section_label = draft_result["sectionPlan"]["labels"].get(section_key, section_key)
        critique = critique_draft(ctx, gap_text, section_label, draft_result["text"], backend)
        iterations.append({"iteration": i, **critique})

        if critique["overallScore"] >= convergence_threshold:
            termination_reason = "converged"
            break
        current_feedback = critique["revisionSuggestions"]

    cost_summary = tracker.summary()
    with conn() as c:
        session = _load_session(c, session_id)
        loop_history = session["state"].get("proposalLoops", [])
        loop_history.append({
            "sectionKey": section_key, "iterations": iterations,
            "terminationReason": termination_reason, "costSummary": cost_summary,
        })
        state = {**session["state"], "proposalLoops": loop_history}
        _save_session(c, session_id, session["status"], state)
        log_run(c, "proposal_loop", {
            "sessionId": session_id, "sectionKey": section_key,
            "terminationReason": termination_reason, "iterationCount": len(iterations),
            **cost_summary,
        })

    return {
        "sessionId": session_id, "sectionKey": section_key, "iterations": iterations,
        "terminationReason": termination_reason, "costSummary": cost_summary,
        "finalDraft": draft_result,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", type=int, required=True)
    ap.add_argument("--brainstorm-gaps", action="store_true")
    ap.add_argument("--confirm-gaps", default=None, help="JSON list of {id, suitable}")
    ap.add_argument("--draft-section", default=None, help="section key, e.g. aims")
    ap.add_argument("--feedback", default=None, help="researcher feedback for a section revision")
    ap.add_argument("--auto-critique-loop", default=None, help="section key to run the propose/draft/critique loop on")
    ap.add_argument("--max-iterations", type=int, default=3)
    ap.add_argument("--convergence-threshold", type=float, default=8.0)
    ap.add_argument("--suggest-gap", default=None, help="researcher's own gap statement (Sprint 4, C3)")
    ap.add_argument("--reference-notes", default=None, help="optional reference notes accompanying --suggest-gap")
    args = ap.parse_args()

    if args.brainstorm_gaps:
        print(json.dumps(brainstorm_gaps(args.session_id), indent=2))
    elif args.confirm_gaps is not None:
        print(json.dumps(confirm_gaps(args.session_id, json.loads(args.confirm_gaps)), indent=2))
    elif args.auto_critique_loop:
        print(json.dumps(run_proposal_loop(
            args.session_id, args.auto_critique_loop, args.max_iterations,
            args.convergence_threshold, args.feedback,
        ), indent=2))
    elif args.suggest_gap:
        print(json.dumps(suggest_gap(args.session_id, args.suggest_gap, args.reference_notes), indent=2))
    elif args.draft_section:
        print(json.dumps(draft_section(args.session_id, args.draft_section, args.feedback), indent=2))
    else:
        raise SystemExit("Specify --brainstorm-gaps, --confirm-gaps, --draft-section, --auto-critique-loop, or --suggest-gap")


if __name__ == "__main__":
    main()
