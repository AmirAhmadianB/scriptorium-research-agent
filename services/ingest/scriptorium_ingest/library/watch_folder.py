"""Professor library connectors — three adapters, one contract.

Consent model (see docs/COMPLIANCE.md): a professor's collection is
ingested only after they enable a connector themselves; items are
scoped to their professor_id; anything not published is `private`.

1. pdf_folder — simplest: each professor gets ./library-inbox/<prof_id>/;
   drop PDFs (e.g. an exported Mendeley folder), we parse via PyMuPDF.
2. zotero    — official web API (api.zotero.org), read-only key.
3. mendeley  — official Elsevier API only if the institution has app
   credentials; folder-scraping Mendeley's local database is brittle
   and against ToS, so it is deliberately not implemented.
"""
from __future__ import annotations
import hashlib
from pathlib import Path
import httpx
from ..config import resolve_data_relative_path, sources
from ..db import conn, upsert_paper
from ..parse.pdf_parser import parse_pdf


def scan_pdf_folder() -> dict:
    cfg = next((c for c in sources()["library_connectors"] if c["kind"] == "pdf_folder"), None)
    if not cfg or not cfg.get("enabled"):
        return {"skipped": True}
    # Sprint 6 Pass 1: previously `Path(cfg["path"])` resolved implicitly
    # against the process's cwd (always services/ingest in dev, since every
    # Node caller spawns workers with that cwd — see pythonRunner.ts) —
    # correct by accident, not by design, and wrong in a packaged sidecar
    # whose cwd is the install directory. resolve_data_relative_path makes
    # the same resolution explicit and mode-aware instead.
    root = resolve_data_relative_path(cfg["path"])
    root.mkdir(parents=True, exist_ok=True)
    new = 0
    with conn() as c:
        for prof_dir in [p for p in root.iterdir() if p.is_dir()]:
            for pdf in prof_dir.glob("*.pdf"):
                digest = hashlib.sha1(pdf.read_bytes()).hexdigest()
                parsed = parse_pdf(str(pdf))
                new += upsert_paper(c, {
                    "source": "pdf_folder", "external_id": digest, "doi": None,
                    "title": parsed["title"] or pdf.stem,
                    "abstract": parsed["abstract"], "year": None, "venue": None,
                    "authors": [], "cited_by_count": 0, "oa_url": None, "concepts": [],
                }, professor_id=prof_dir.name)
    return {"new": new}


def sync_zotero(user_id: str, api_key: str, professor_id: str) -> dict:
    new, start = 0, 0
    with conn() as c, httpx.Client(headers={"Zotero-API-Key": api_key}) as client:
        while True:
            r = client.get(f"https://api.zotero.org/users/{user_id}/items",
                           params={"itemType": "journalArticle", "limit": 100, "start": start},
                           timeout=30)
            r.raise_for_status()
            items = r.json()
            if not items:
                break
            for it in items:
                d = it["data"]
                new += upsert_paper(c, {
                    "source": "zotero", "external_id": it["key"],
                    "doi": d.get("DOI") or None, "title": d.get("title"),
                    "abstract": d.get("abstractNote", ""),
                    "year": int(d["date"][:4]) if d.get("date", "")[:4].isdigit() else None,
                    "published_date": d["date"][:10] if len(d.get("date", "")) >= 10
                        and d["date"][4] == "-" and d["date"][7] == "-" else None,
                    "venue": d.get("publicationTitle"),
                    "authors": [{"name": f"{a.get('firstName','')} {a.get('lastName','')}".strip(),
                                 "orcid": None} for a in d.get("creators", [])],
                    "cited_by_count": 0, "oa_url": None, "concepts": d.get("tags") and
                        [t["tag"] for t in d["tags"]][:6] or [],
                }, professor_id=professor_id)
            start += len(items)
    return {"new": new}


def main() -> None:
    """CLI entrypoint (Pass 2.1): let the API register newly-uploaded PDFs
    into the corpus immediately after saving them, without duplicating
    scan_pdf_folder's logic — same convention as every other worker here,
    one JSON summary as the last stdout line."""
    import json
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(scan_pdf_folder()))


if __name__ == "__main__":
    main()
