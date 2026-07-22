"""Crossref — authoritative DOI metadata; used mainly for repair/enrichment."""
from __future__ import annotations
import httpx

BASE = "https://api.crossref.org"


def by_doi(doi: str) -> dict | None:
    r = httpx.get(f"{BASE}/works/{doi}", timeout=30,
                  headers={"User-Agent": "scriptorium/0.1 (mailto:research@example.edu)"})
    if r.status_code != 200:
        return None
    m = r.json()["message"]
    date_parts = (m.get("issued", {}).get("date-parts") or [[None]])[0]
    published_date = None
    if date_parts and date_parts[0]:
        year, month, day = (list(date_parts) + [1, 1])[:3]
        published_date = f"{year:04d}-{month:02d}-{day:02d}"
    return {
        "doi": doi,
        "title": (m.get("title") or [None])[0],
        "venue": (m.get("container-title") or [None])[0],
        "year": date_parts[0],
        "published_date": published_date,
        "authors": [{"name": f"{a.get('given','')} {a.get('family','')}".strip(),
                     "orcid": a.get("ORCID")} for a in m.get("author", [])],
        "cited_by_count": m.get("is-referenced-by-count", 0),
    }
