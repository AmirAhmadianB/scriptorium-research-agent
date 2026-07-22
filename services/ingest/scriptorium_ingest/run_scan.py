"""One full literature scan: focus.yaml → every enabled connector → SQLite.
Prints a JSON summary the /scan skill reads back to the user.

Sprint 4 (C1): every run stamps the Research Focus version it read
(current_research_focus_version) into its own agent_runs summary — the
Literature Radar tab compares this to the profile's live version to decide
whether the tab is showing stale results. No new schema column: the
version is already there (profile/store.ts), this just records which one
a given run used."""
from __future__ import annotations
import argparse
import json
from datetime import datetime, timezone
from .config import focus, sources
from .connectors import openalex, arxiv, semantic_scholar
from .library.watch_folder import scan_pdf_folder
from .db import conn, upsert_paper, log_run, current_research_focus_keywords, current_research_focus_version


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--professor-id", default="default")
    args = ap.parse_args()

    f, s = focus(), sources()
    # horizon_years is a generic numeric setting (not a discipline literal),
    # so it stays in config/focus.yaml for now — no profile field for it yet
    # per Pass 1.1's schema. The actual search terms below are Pass 1.5c's
    # concern: they now come from the field-adaptive Research Focus profile
    # (Change 1), not this file's old hardcoded keywords.include.
    since = datetime.now().year - f.get("horizon_years", 4)
    summary: dict = {"started": datetime.now(timezone.utc).isoformat(), "sources": {}, "new_total": 0}

    with conn() as c:
        summary["focusVersion"] = current_research_focus_version(c, args.professor_id)
        summary["professorId"] = args.professor_id
        # A DRAFT profile (below the five-keyword minimum, or empty) still
        # runs — it just finds nothing until the researcher sets a focus,
        # per Pass 1.5's shared Gate ("the feature still runs in the DRAFT
        # default").
        queries = current_research_focus_keywords(c, args.professor_id)
        for q in queries:
            if s["apis"]["openalex"]["enabled"]:
                try:
                    hits = openalex.search(q, since_year=since, max_records=100)
                    new = sum(upsert_paper(c, p) for p in hits)
                    agg = summary["sources"].setdefault("openalex", {"found": 0, "new": 0})
                    agg["found"] += len(hits); agg["new"] += new
                except Exception as e:
                    summary["sources"].setdefault("openalex", {"found": 0, "new": 0})["error"] = str(e)
            if s["apis"]["semantic_scholar"]["enabled"]:
                try:
                    hits = semantic_scholar.search(q, max_records=50)
                    new = sum(upsert_paper(c, p) for p in hits)
                    agg = summary["sources"].setdefault("semantic_scholar", {"found": 0, "new": 0})
                    agg["found"] += len(hits); agg["new"] += new
                except Exception as e:
                    summary["sources"].setdefault("semantic_scholar", {"found": 0, "new": 0})["error"] = str(e)
        if s["apis"]["arxiv"]["enabled"] and queries:
            try:
                hits = arxiv.search(" OR ".join(f'"{q}"' for q in queries[:5]),
                                    categories=s["apis"]["arxiv"].get("categories"),
                                    max_records=200)
                new = sum(upsert_paper(c, p) for p in hits)
                summary["sources"]["arxiv"] = {"found": len(hits), "new": new}
            except Exception as e:
                summary["sources"]["arxiv"] = {"found": 0, "new": 0, "error": str(e)}

        summary["sources"]["pdf_folder"] = scan_pdf_folder()
        summary["new_total"] = sum(v.get("new", 0) for v in summary["sources"].values()
                                   if isinstance(v, dict))
        log_run(c, "literature_scan", summary)

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
