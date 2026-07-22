"""Funding radar: crawl4ai → markdown → Claude (Haiku) → structured records.

Design choice worth knowing: crawl4ai's own extraction-strategy API has
moved fast between releases, so we deliberately use it only for what is
stable — fetching a rendered page as clean markdown — and do structured
extraction with a pinned Claude prompt. That keeps this file working
across crawl4ai versions and makes the extraction model swappable in
config/models.yaml (task: crawl_extraction) for /test-models sweeps.

The extraction call itself goes through claude_cli.complete(), which shells
out to the local Claude Code CLI in headless print mode rather than the
`anthropic` SDK — this worker rides the operator's existing Claude
subscription instead of needing its own billed ANTHROPIC_API_KEY.

Run:  python -m scriptorium_ingest.funding.crawl_funding [--filter closing-soon]
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
from datetime import date

from crawl4ai import AsyncWebCrawler

from ..llm.dispatch import complete
from ..config import funding, task_model
from ..db import conn, upsert_funding, log_run, current_research_focus_keywords, list_crawl_sources, record_crawl_result
from ..crawl.politeness import allowed_by_robots, wait_for_rate_limit

EXTRACTION_PROMPT = """You extract funding opportunities from a research sponsor's web page.

Return ONLY a JSON array (no prose, no markdown fences). Each element:
{{
  "program": string,            // official program name
  "sponsor": string,            // granting organization
  "deadline": string|null,      // ISO date YYYY-MM-DD, or "rolling", or null if absent
  "deadline_uncertain": bool,   // true if you inferred any part of the date (e.g. missing year)
  "amount": string|null,        // as printed, e.g. "$20,000–$1M over 5 years"
  "duration": string|null,
  "eligibility": string|null,   // one sentence: who can apply, partner requirements
  "keywords": [string],         // up to 8 topical keywords from the call text
  "priorities": string|null,    // the funder's OWN stated focus/priorities for this call, in their words
  "requirements": string|null,  // application requirements beyond plain eligibility (partner letters, budget forms, etc.)
  "proposal_structure": {{      // the funder's specified proposal structure, or null if the page doesn't say
    "sections": [{{"name": string, "guidance": string|null, "page_limit": string|null}}],
    "evaluation_criteria": [string]
  }} | null,
  "submission_format": string|null  // HOW to submit — e.g. "single PDF via online portal",
                                     // "email to program officer", "two-stage: LOI then full proposal"
}}

Rules: never invent a year for a partial date — set deadline to the partial
string and deadline_uncertain to true. Every field is MISSING (null, or []
for list fields) if the page doesn't state it — never infer or guess a
plausible-sounding value for priorities, requirements, proposal_structure, or
submission_format; an absent proposal_structure is expected for most funder
pages (few state one explicitly) and is not an error. If the page lists no
concrete opportunities (it's a nav/landing page), return [].

Sponsor: {sponsor}
Page (markdown):
---
{page}
---"""


def _extract(sponsor: str, page_md: str) -> list[dict]:
    cfg = task_model("crawl_extraction")
    text = complete(EXTRACTION_PROMPT.format(sponsor=sponsor, page=page_md[:60000]),
                     model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _match_score(opp: dict, kw_include: list[str]) -> float:
    """Cheap lexical prior; the funding-scout agent refines rationale on top."""
    hay = " ".join([opp.get("program") or "", opp.get("eligibility") or "",
                    " ".join(opp.get("keywords") or [])]).lower()
    field_terms = [k.split(" /")[0].lower() for k in kw_include]
    generic = {"research", "innovation", "science", "partnership", "collaboration"}
    hits = sum(1 for k in field_terms if k in hay)
    breadth = sum(1 for g in generic if g in hay)
    return min(1.0, hits * 0.3 + breadth * 0.05)


async def crawl_all(only_scope: str | None = None, only_source_id: int | None = None) -> list[dict]:
    """Sprint 2 Pass 3: targets now come from the crawl_sources registry
    (single source of truth — comments 7/8), not config/funding.yaml
    directly; the YAML was only ever read once, at registry seed time."""
    with conn() as c:
        targets = list_crawl_sources(c, purpose="funding", enabled_only=True)
    if only_scope:
        targets = [t for t in targets if t.get("scope") == only_scope]
    if only_source_id:
        targets = [t for t in targets if t["id"] == only_source_id]
    results: list[dict] = []

    async with AsyncWebCrawler() as crawler:
        for t in targets:
            name = t["label"]
            # Politeness (comment 8): a disallowed/blocked source degrades
            # to a logged error and the batch continues — never raises.
            if not allowed_by_robots(t["url"]):
                results.append({"_error": f"{name}: disallowed by robots.txt", "_source_id": t["id"]})
                with conn() as c:
                    record_crawl_result(c, t["id"], "error", error="disallowed by robots.txt")
                continue
            try:
                wait_for_rate_limit(t["url"])
                page = await crawler.arun(url=t["url"])
                md = getattr(page, "markdown", "") or ""
                if not md.strip():
                    results.append({"_error": f"empty page: {name}", "_source_id": t["id"]})
                    with conn() as c:
                        record_crawl_result(c, t["id"], "error", count=0, error="empty page")
                    continue
                found = 0
                for opp in _extract(name, md):
                    opp["sponsor"] = opp.get("sponsor") or name
                    opp["url"] = t["url"]
                    opp["scope"] = t.get("scope") or "national"
                    opp["content_hash"] = hashlib.sha1(
                        json.dumps(opp, sort_keys=True).encode()).hexdigest()
                    results.append(opp)
                    found += 1
                with conn() as c:
                    record_crawl_result(c, t["id"], "ok", count=found)
            except Exception as exc:  # keep the radar sweeping past one bad site
                results.append({"_error": f"{name}: {type(exc).__name__}: {exc}", "_source_id": t["id"]})
                with conn() as c:
                    record_crawl_result(c, t["id"], "error", error=f"{type(exc).__name__}: {exc}")
    return results


def extract_from_text(sponsor: str, text: str) -> dict:
    """Sprint 2 Pass 4 (comment 6) — the manual-add path: 'if the researcher
    pastes or links the funder's guidelines' yields a template just like a
    crawled opportunity. Reuses _extract (the SAME prompt/parsing the crawl
    path uses) instead of a second extraction implementation; returns the
    first extracted element (a manual add is one specific opportunity, not
    a page listing several)."""
    results = _extract(sponsor, text)
    return results[0] if results else {}


def extract_from_file(file_path: str, sponsor: str = "") -> dict:
    """Sprint 4 (C2) — the upload path: reuses parse.document_reader
    (the SAME shared reader every other ingestion path uses — PDF via
    PyMuPDF/OCR/optional Azure, DOCX via python-docx, already built) to get
    text out of the uploaded call document, then feeds it through the
    SAME extraction call extract_from_text() already uses. No second
    parser, no second extraction prompt."""
    from ..parse.document_reader import read_document
    parsed = read_document(file_path)
    full_text = "\n\n".join(
        [parsed.get("title") or "", parsed.get("abstract") or ""]
        + [sec.get("text", "") for sec in parsed.get("sections", [])]
    )
    result = extract_from_text(sponsor or "(identify the sponsor from the document text)", full_text)
    if not result.get("program") and parsed.get("title"):
        result["program"] = parsed["title"]
    return result


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--filter", default="", help="national|provincial|international|closing-soon")
    ap.add_argument("--source-id", type=int, default=None, help="Sprint 2 Pass 3: crawl just this one registry source")
    ap.add_argument("--extract-text", action="store_true",
                     help="Sprint 2 Pass 4: read {sponsor, text} JSON from stdin, print extracted fields")
    ap.add_argument("--extract-file", default=None,
                     help="Sprint 4 (C2): path to an uploaded .pdf/.docx call document to parse + extract")
    ap.add_argument("--sponsor-hint", default="", help="optional sponsor hint for --extract-file")
    args = ap.parse_args()

    if args.extract_text:
        import sys
        payload = json.loads(sys.stdin.read())
        print(json.dumps(extract_from_text(payload["sponsor"], payload["text"])))
        return

    if args.extract_file:
        print(json.dumps(extract_from_file(args.extract_file, args.sponsor_hint)))
        return

    scope = args.filter if args.filter in {"national", "provincial", "international"} else None

    opps = asyncio.run(crawl_all(scope, args.source_id))
    errors = [o["_error"] for o in opps if "_error" in o]
    opps = [o for o in opps if "_error" not in o]

    threshold = funding().get("match_threshold", 0.5)
    summary = {"found": len(opps), "new": 0, "changed": 0,
               "matched": 0, "closing_30d": [], "errors": errors}

    with conn() as c:
        kw = current_research_focus_keywords(c)
        for o in opps:
            o["match_score"] = _match_score(o, kw)
            status = upsert_funding(c, {
                "sponsor": o["sponsor"], "program": o["program"], "url": o["url"],
                "deadline": o.get("deadline") if _iso(o.get("deadline")) else None,
                "deadline_uncertain": bool(o.get("deadline_uncertain")),
                "amount": o.get("amount"), "duration": o.get("duration"),
                "eligibility": o.get("eligibility"), "keywords": o.get("keywords", []),
                "scope": o["scope"], "content_hash": o["content_hash"],
                "source": "crawl",
                "priorities": o.get("priorities"), "requirements": o.get("requirements"),
                "proposal_template": o.get("proposal_structure"),
                "submission_format": o.get("submission_format"),
            })
            if status in ("new", "changed"):
                summary[status] += 1
            if o["match_score"] >= threshold:
                summary["matched"] += 1
            d = o.get("deadline")
            if _iso(d) and 0 <= (date.fromisoformat(d) - date.today()).days <= 30:
                summary["closing_30d"].append(f"{o['program']} — {d}")
        log_run(c, "funding_scan", summary)

    print(json.dumps(summary, indent=2))


def _iso(d) -> bool:
    return bool(d) and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d)))


if __name__ == "__main__":
    main()
