"""Sprint 2 Pass 3 (comments 7/8) — crawls purpose='literature' sources in
the registry. config/sources.yaml's `crawl.targets` (arXiv listing pages,
lab/agency news pages) were configured but never actually crawled by
anything before this pass — run_scan.py only ever used the structured
connectors (OpenAlex/arXiv API/Semantic Scholar), never these open-web
pages. Same crawl4ai-markdown + Claude-extraction shape as
funding/crawl_funding.py (reused pattern, not reinvented), extracting
paper-like entries instead of funding opportunities.

Run: python -m scriptorium_ingest.crawl.crawl_literature [--source-id N]
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re

from crawl4ai import AsyncWebCrawler

from ..llm.dispatch import complete
from ..config import task_model
from ..db import conn, upsert_paper, log_run, list_crawl_sources, record_crawl_result
from .politeness import allowed_by_robots, wait_for_rate_limit

EXTRACTION_PROMPT = """You extract research paper / preprint listings from a web page \
(an arXiv listing, a lab or agency news page, etc). Return ONLY a JSON array \
(no prose, no markdown fences). Each element:
{{
  "title": string,
  "authors": [string],   // best-effort; [] if not shown
  "url": string,          // link to the paper/article itself
  "abstract": string|null
}}
If the page lists no individual papers/articles (it's pure navigation), return [].

Source: {label}
Page (markdown):
---
{page}
---"""


def _extract(label: str, page_md: str) -> list[dict]:
    cfg = task_model("crawl_extraction")
    text = complete(EXTRACTION_PROMPT.format(label=label, page=page_md[:60000]), model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


async def crawl_all(only_source_id: int | None = None) -> dict:
    with conn() as c:
        targets = list_crawl_sources(c, purpose="literature", enabled_only=True)
    if only_source_id:
        targets = [t for t in targets if t["id"] == only_source_id]

    summary = {"found": 0, "new": 0, "errors": []}
    async with AsyncWebCrawler() as crawler:
        for t in targets:
            name = t["label"]
            if not allowed_by_robots(t["url"]):
                summary["errors"].append(f"{name}: disallowed by robots.txt")
                with conn() as c:
                    record_crawl_result(c, t["id"], "error", error="disallowed by robots.txt")
                continue
            try:
                wait_for_rate_limit(t["url"])
                page = await crawler.arun(url=t["url"])
                md = getattr(page, "markdown", "") or ""
                if not md.strip():
                    summary["errors"].append(f"{name}: empty page")
                    with conn() as c:
                        record_crawl_result(c, t["id"], "error", count=0, error="empty page")
                    continue
                entries = _extract(name, md)
                new_count = 0
                with conn() as c:
                    for e in entries:
                        if not e.get("title") or not e.get("url"):
                            continue
                        digest = hashlib.sha1(e["url"].encode()).hexdigest()
                        is_new = upsert_paper(c, {
                            "source": "web_crawl", "external_id": digest, "doi": None,
                            "title": e["title"], "abstract": e.get("abstract") or "",
                            "year": None, "venue": name,
                            "authors": [{"name": a, "orcid": None} for a in (e.get("authors") or [])],
                            "cited_by_count": 0, "oa_url": e["url"], "concepts": [],
                        })
                        if is_new:
                            new_count += 1
                    record_crawl_result(c, t["id"], "ok", count=len(entries))
                summary["found"] += len(entries)
                summary["new"] += new_count
            except Exception as exc:  # one bad source must not stop the sweep
                summary["errors"].append(f"{name}: {type(exc).__name__}: {exc}")
                with conn() as c:
                    record_crawl_result(c, t["id"], "error", error=f"{type(exc).__name__}: {exc}")
    return summary


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-id", type=int, default=None)
    args = ap.parse_args()
    summary = asyncio.run(crawl_all(args.source_id))
    with conn() as c:
        log_run(c, "literature_web_crawl", summary)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
