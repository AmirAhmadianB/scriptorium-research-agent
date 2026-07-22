"""OpenAlex connector — the workhorse of open scholarly metadata.

Free, no key, covers ~250M works with abstracts (as inverted indexes),
citations, concepts, and OA links. Set OPENALEX_EMAIL to join the
polite pool (faster, stabler). Docs: https://docs.openalex.org
"""
from __future__ import annotations
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential
from ..config import sources, env

BASE = "https://api.openalex.org"


def _uninvert(inv: dict | None) -> str:
    """OpenAlex stores abstracts as {word: [positions]}; rebuild the text."""
    if not inv:
        return ""
    slots: dict[int, str] = {}
    for word, positions in inv.items():
        for p in positions:
            slots[p] = word
    return " ".join(slots[i] for i in sorted(slots))


def normalize(w: dict) -> dict:
    return {
        "source": "openalex",
        "external_id": w.get("id"),
        "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
        "title": w.get("display_name"),
        "abstract": _uninvert(w.get("abstract_inverted_index")),
        "year": w.get("publication_year"),
        "published_date": w.get("publication_date"),
        "venue": ((w.get("primary_location") or {}).get("source") or {}).get("display_name"),
        "authors": [
            {"name": a["author"]["display_name"], "orcid": a["author"].get("orcid")}
            for a in w.get("authorships", [])
        ],
        "cited_by_count": w.get("cited_by_count", 0),
        "oa_url": (w.get("best_oa_location") or {}).get("pdf_url"),
        "concepts": [c["display_name"] for c in w.get("concepts", [])[:6]],
    }


@retry(stop=stop_after_attempt(4), wait=wait_exponential(min=1, max=20))
def _get(client: httpx.Client, url: str, params: dict) -> dict:
    r = client.get(url, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def search(query: str, since_year: int | None = None, per_page: int = 50,
           max_records: int = 500) -> list[dict]:
    """Cursor-paged keyword search, newest first."""
    params: dict = {
        "search": query,
        "per-page": per_page,
        "cursor": "*",
        "sort": "publication_date:desc",
    }
    filters = []
    if since_year:
        filters.append(f"from_publication_date:{since_year}-01-01")
    if filters:
        params["filter"] = ",".join(filters)
    if (mail := env(sources()["apis"]["openalex"].get("polite_email_env", ""))):
        params["mailto"] = mail

    out: list[dict] = []
    with httpx.Client(headers={"User-Agent": "scriptorium/0.1"}) as client:
        while len(out) < max_records:
            data = _get(client, f"{BASE}/works", params)
            results = data.get("results", [])
            if not results:
                break
            out.extend(normalize(w) for w in results)
            cursor = data.get("meta", {}).get("next_cursor")
            if not cursor:
                break
            params["cursor"] = cursor
    return out[:max_records]


def works_by_author(orcid: str, max_records: int = 200) -> list[dict]:
    """All works for a seed author — used to bootstrap a professor's corpus."""
    params = {"filter": f"authorships.author.orcid:{orcid}",
              "per-page": 50, "cursor": "*"}
    out: list[dict] = []
    with httpx.Client() as client:
        while len(out) < max_records:
            data = _get(client, f"{BASE}/works", params)
            results = data.get("results", [])
            if not results:
                break
            out.extend(normalize(w) for w in results)
            cursor = data.get("meta", {}).get("next_cursor")
            if not cursor:
                break
            params["cursor"] = cursor
    return out[:max_records]
