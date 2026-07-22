"""arXiv connector via the public Atom API (fully open, crawl-friendly)."""
from __future__ import annotations
import feedparser
import httpx

BASE = "https://export.arxiv.org/api/query"


def search(query: str, categories: list[str] | None = None, max_records: int = 100) -> list[dict]:
    cat = " OR ".join(f"cat:{c}" for c in (categories or []))
    q = f"({query})" + (f" AND ({cat})" if cat else "")
    params = {"search_query": q, "start": 0, "max_results": max_records,
              "sortBy": "submittedDate", "sortOrder": "descending"}
    r = httpx.get(BASE, params=params, timeout=30)
    r.raise_for_status()
    feed = feedparser.parse(r.text)
    out = []
    for e in feed.entries:
        out.append({
            "source": "arxiv",
            "external_id": e.id,
            "doi": getattr(e, "arxiv_doi", None),
            "title": " ".join(e.title.split()),
            "abstract": " ".join(e.summary.split()),
            "year": int(e.published[:4]),
            "published_date": e.published[:10],
            "venue": "arXiv " + (e.tags[0]["term"] if e.tags else ""),
            "authors": [{"name": a.name, "orcid": None} for a in e.authors],
            "cited_by_count": 0,
            "oa_url": next((l.href for l in e.links if l.type == "application/pdf"), None),
            "concepts": [t["term"] for t in e.tags][:6],
        })
    return out
