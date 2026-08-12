"""Agent-Reach RSS ingestion — journal TOCs / lab blogs a professor wants
tracked. Pure network+parse, no subprocess: feedparser talks to the feed
URL directly (mirrors connectors/arxiv.py's httpx-fetch + feedparser-parse
combo, the closest existing precedent for feedparser use in this codebase,
rather than letting feedparser do its own fetch — that way we control
timeout/User-Agent the same way every other connector does).

Feed subscriptions live in the crawl_sources registry with
purpose='agent_reach_rss' (see agent_reach_scan.py for how a professor's
feeds are selected via the scope column); this module only fetches one
feed URL and normalizes its entries — it doesn't touch the registry.
"""
from __future__ import annotations
import hashlib
import logging

import feedparser
import httpx

logger = logging.getLogger("scriptorium_ingest.connectors.agent_reach_rss")


def _external_id(entry_id: str) -> str:
    return hashlib.sha1(entry_id.encode()).hexdigest()


def _struct_time_to_iso(parsed) -> str | None:
    if not parsed:
        return None
    return f"{parsed.tm_year:04d}-{parsed.tm_mon:02d}-{parsed.tm_mday:02d}"


def rss_fetch(feed_url: str, max_items: int = 20) -> list[dict]:
    """Fetch + parse a feed and normalize entries straight to the papers
    table shape (source='agent_reach_rss') — this connector has no
    separate normalize() step because feedparser's entry objects already
    map cleanly 1:1, same as arxiv.py. Errors (network, malformed feed)
    degrade to [] with a logged warning — a bad/unreachable feed must not
    stop the sweep across a professor's other subscribed sources. Never
    prints raw feed text (Windows stdout-encoding convention); only the
    caller's JSON summary is ever printed."""
    try:
        r = httpx.get(feed_url, timeout=30, follow_redirects=True,
                       headers={"User-Agent": "scriptorium/0.1"})
        r.raise_for_status()
    except Exception as e:
        logger.warning(f"rss_fetch: fetch failed for {feed_url!r}: {e}")
        return []

    try:
        feed = feedparser.parse(r.content)
    except Exception as e:
        logger.warning(f"rss_fetch: parse failed for {feed_url!r}: {e}")
        return []

    feed_title = None
    if getattr(feed, "feed", None):
        feed_title = feed.feed.get("title")

    out: list[dict] = []
    for e in feed.entries[:max_items]:
        entry_id = e.get("id") or e.get("link") or e.get("title") or ""
        if not entry_id:
            continue
        parsed_date = e.get("published_parsed") or e.get("updated_parsed")
        published_date = _struct_time_to_iso(parsed_date)
        out.append({
            "source": "agent_reach_rss",
            "external_id": _external_id(entry_id),
            "doi": None,
            "title": " ".join((e.get("title") or "").split()) or None,
            "abstract": " ".join((e.get("summary") or "").split()),
            "year": parsed_date.tm_year if parsed_date else None,
            "published_date": published_date,
            "venue": feed_title,
            "authors": [{"name": e.get("author"), "orcid": None}] if e.get("author") else [],
            "cited_by_count": 0,
            "oa_url": e.get("link"),
            "concepts": [t["term"] for t in e.get("tags", [])][:6] if e.get("tags") else [],
        })
    return out
