"""Unpaywall — legal open-access PDF locations by DOI."""
from __future__ import annotations
import httpx
from ..config import env


def oa_pdf(doi: str) -> str | None:
    email = env("UNPAYWALL_EMAIL") or "research@example.edu"
    r = httpx.get(f"https://api.unpaywall.org/v2/{doi}", params={"email": email}, timeout=30)
    if r.status_code != 200:
        return None
    loc = r.json().get("best_oa_location") or {}
    return loc.get("url_for_pdf") or loc.get("url")
