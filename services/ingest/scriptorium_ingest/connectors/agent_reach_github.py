"""Agent-Reach GitHub search connector — research code/tools relevant to a
professor's field, via agent_reach_cli.github_search() (`gh search repos
--json ...`, already structured — no text parsing needed). Normalized to
the same flat dict shape every other connector returns; a repo isn't a
paper, but storing it alongside papers (source='agent_reach_github') is
the same "extend the papers table to a related-but-not-bibliographic
record" move run_scan.py's pdf_folder and crawl_literature.py's web_crawl
sources already make.
"""
from __future__ import annotations
import hashlib

from .. import agent_reach_cli


def _external_id(full_name: str) -> str:
    return hashlib.sha1(full_name.encode()).hexdigest()


def normalize(repo: dict) -> dict:
    full_name = repo.get("fullName") or ""
    url = repo.get("url") or (f"https://github.com/{full_name}" if full_name else None)
    updated = repo.get("updatedAt")
    year = int(updated[:4]) if updated and updated[:4].isdigit() else None
    return {
        "source": "agent_reach_github",
        "external_id": _external_id(full_name or url or ""),
        "doi": None,
        "title": full_name or url,
        "abstract": repo.get("description") or "",
        "year": year,
        "published_date": updated[:10] if updated else None,
        "venue": "GitHub",
        "authors": [],
        "cited_by_count": repo.get("stargazersCount", 0),
        "oa_url": url,
        "concepts": [],
    }


def search(query: str, max_records: int = 10) -> list[dict]:
    hits = agent_reach_cli.github_search(query, max_results=max_records)
    return [normalize(r) for r in hits if r.get("fullName")]
