"""Agent-Reach Exa semantic web search connector — a professor's Research
Focus keywords (and focus_synthesis, as a free-text semantic query) run
through Exa via agent_reach_cli.exa_search(), normalized to the same flat
dict shape every other connector returns (see connectors/openalex.py's
normalize() for the template this follows).

Exa results are general web pages, not scholarly metadata, so most
bibliographic fields (doi, authors, venue, cited_by_count, concepts) are
genuinely unknown and stay null/empty rather than guessed — same
"field missing, not inferred" convention crawl_funding.py's extraction
prompt uses.
"""
from __future__ import annotations
import hashlib

from .. import agent_reach_cli


def _external_id(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()


def normalize(hit: dict) -> dict:
    url = hit.get("url") or ""
    published = hit.get("published")
    year = int(published[:4]) if published and published[:4].isdigit() else None
    return {
        "source": "agent_reach_web",
        "external_id": _external_id(url),
        "doi": None,
        "title": hit.get("title") or url,
        "abstract": hit.get("snippet") or "",
        "year": year,
        "published_date": published[:10] if published else None,
        "venue": None,
        "authors": [],
        "cited_by_count": 0,
        "oa_url": url,
        "concepts": [],
    }


def search(query: str, max_records: int = 10) -> list[dict]:
    hits = agent_reach_cli.exa_search(query, num_results=max_records)
    return [normalize(h) for h in hits if h.get("url")]
