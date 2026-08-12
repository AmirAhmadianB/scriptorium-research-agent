"""Agent-Reach ingestion sweep: Exa semantic web search + GitHub code/tool
search + subscribed RSS feeds, all driven by a professor's Research Focus
(current_research_focus_keywords()/current_research_focus(), the same
profile run_scan.py and funding/crawl_funding.py already read from) —
layered on as a new source alongside the existing OpenAlex/arXiv/Crossref/
Semantic Scholar/Unpaywall connectors and the funding/literature crawlers,
the same way Sprint 2 Pass 3 added crawl_literature.py alongside run_scan.py
as a sibling script rather than folding it in.

Exa web search and GitHub search results are public-web/public-metadata
discoveries, not a professor's private collection, so — matching
run_scan.py's and crawl_literature.py's OpenAlex/arXiv/web_crawl calls
(never professor-scoped) rather than library/watch_folder.py's Zotero/PDF-
folder calls (always professor-scoped, per CLAUDE.md's "professor
collections: opt-in connectors only, scoped to professor_id") — this
script does NOT pass professor_id to upsert_paper(): results land in the
shared papers pool, deduped by dedupe_key like every other public-metadata
connector.

RSS feed *subscriptions* are per-professor even though the resulting
papers are shared: a crawl_sources row with purpose='agent_reach_rss' and
scope == this professor_id is private to their sweep; a row with no scope
(None/'') is a shared/global feed every professor's sweep also picks up.
See crawl/registry.py for the existing seed-from-YAML pattern this reuses
for registering new feeds (add_crawl_source(c, url, label,
'agent_reach_rss', professor_id) — no UI yet, see the report for why).

Prints a JSON summary as its last stdout line (CLAUDE.md's hard "every
worker prints a JSON summary as its last line" convention).

Run: python -m scriptorium_ingest.agent_reach_scan [--professor-id ID]
"""
from __future__ import annotations
import argparse
import json
from datetime import datetime, timezone

from .connectors import agent_reach_web, agent_reach_github, agent_reach_rss
from .db import (
    conn, upsert_paper, log_run, current_research_focus,
    list_crawl_sources, record_crawl_result,
)


def _rss_targets(c, professor_id: str) -> list[dict]:
    rows = list_crawl_sources(c, purpose="agent_reach_rss", enabled_only=True)
    return [r for r in rows if not r.get("scope") or r["scope"] == professor_id]


def run(professor_id: str = "default", max_per_query: int = 5, max_queries: int | None = None) -> dict:
    summary: dict = {
        "started": datetime.now(timezone.utc).isoformat(),
        "professorId": professor_id,
        "sources": {},
        "new_total": 0,
    }

    with conn() as c:
        profile = current_research_focus(c, professor_id)
        keywords = profile["keywords"]
        web_queries = list(keywords)
        if profile.get("focus_synthesis"):
            web_queries.append(profile["focus_synthesis"])
        if max_queries is not None:
            web_queries = web_queries[:max_queries]
            keywords = keywords[:max_queries]

        # --- Exa semantic web search: keywords + the free-text synthesis ---
        agg = summary["sources"].setdefault("agent_reach_web", {"found": 0, "new": 0})
        for q in web_queries:
            try:
                hits = agent_reach_web.search(q, max_records=max_per_query)
                new = sum(upsert_paper(c, p) for p in hits)
                agg["found"] += len(hits)
                agg["new"] += new
            except Exception as e:
                agg.setdefault("errors", []).append(f"{q!r}: {type(e).__name__}: {e}")

        # --- GitHub code/tool search: bare keywords read better than prose ---
        agg = summary["sources"].setdefault("agent_reach_github", {"found": 0, "new": 0})
        for q in keywords:
            try:
                hits = agent_reach_github.search(q, max_records=max_per_query)
                new = sum(upsert_paper(c, p) for p in hits)
                agg["found"] += len(hits)
                agg["new"] += new
            except Exception as e:
                agg.setdefault("errors", []).append(f"{q!r}: {type(e).__name__}: {e}")

        # --- Subscribed RSS feeds (journal TOCs / lab blogs) ---
        agg = summary["sources"].setdefault("agent_reach_rss", {"found": 0, "new": 0})
        for src in _rss_targets(c, professor_id):
            try:
                hits = agent_reach_rss.rss_fetch(src["url"], max_items=20)
                new = sum(upsert_paper(c, p) for p in hits)
                agg["found"] += len(hits)
                agg["new"] += new
                record_crawl_result(c, src["id"], "ok", count=len(hits))
            except Exception as e:
                agg.setdefault("errors", []).append(f"{src['label']}: {type(e).__name__}: {e}")
                record_crawl_result(c, src["id"], "error", error=f"{type(e).__name__}: {e}")

        summary["new_total"] = sum(v.get("new", 0) for v in summary["sources"].values())
        log_run(c, "agent_reach_scan", summary)

    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--professor-id", default="default")
    ap.add_argument("--max-per-query", type=int, default=5,
                     help="max results per Exa/GitHub query")
    ap.add_argument("--max-queries", type=int, default=None,
                     help="cap how many Research Focus keywords drive the sweep (smoke-test/debug use)")
    args = ap.parse_args()

    summary = run(args.professor_id, args.max_per_query, args.max_queries)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
