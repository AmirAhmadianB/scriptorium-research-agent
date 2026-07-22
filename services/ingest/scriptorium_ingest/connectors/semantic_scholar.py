"""Semantic Scholar Graph API — great for citation context, TLDRs, and
recommendations. Free tier works; S2_API_KEY raises rate limits."""
from __future__ import annotations
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception
from ..config import env

BASE = "https://api.semanticscholar.org/graph/v1"
FIELDS = "title,abstract,year,publicationDate,venue,authors,externalIds,citationCount,openAccessPdf,tldr"


def _headers() -> dict:
    key = env("S2_API_KEY")
    return {"x-api-key": key} if key else {}


def _retryable(exc: BaseException) -> bool:
    """Retry on rate limits (429) and server errors, not on permanent 4xx."""
    return isinstance(exc, httpx.HTTPStatusError) and (
        exc.response.status_code == 429 or exc.response.status_code >= 500)


@retry(stop=stop_after_attempt(5), wait=wait_exponential(min=2, max=60),
       retry=retry_if_exception(_retryable))
def _get(client: httpx.Client, offset: int, limit: int, query: str) -> dict:
    r = client.get(f"{BASE}/paper/search",
                   params={"query": query, "fields": FIELDS, "offset": offset, "limit": limit},
                   timeout=30)
    r.raise_for_status()
    return r.json()


def search(query: str, max_records: int = 100) -> list[dict]:
    out, offset = [], 0
    with httpx.Client(headers=_headers()) as client:
        while len(out) < max_records:
            data = _get(client, offset, min(100, max_records - len(out)), query).get("data", [])
            if not data:
                break
            for p in data:
                out.append({
                    "source": "semantic_scholar",
                    "external_id": p.get("paperId"),
                    "doi": (p.get("externalIds") or {}).get("DOI"),
                    "title": p.get("title"),
                    "abstract": p.get("abstract") or (p.get("tldr") or {}).get("text", ""),
                    "year": p.get("year"),
                    "published_date": p.get("publicationDate"),
                    "venue": p.get("venue"),
                    "authors": [{"name": a["name"], "orcid": None} for a in p.get("authors", [])],
                    "cited_by_count": p.get("citationCount", 0),
                    "oa_url": (p.get("openAccessPdf") or {}).get("url"),
                    "concepts": [],
                })
            offset += len(data)
    return out
