"""Sprint 2 Pass 3 (comment 8) — politeness/safety shared by every crawl
path (funding.crawl_funding, crawl.crawl_literature, and the immediate
test-fetch on adding a source): robots.txt, a per-domain minimum interval,
and a hard timeout. A failing/blocked source must degrade to a logged
error, never raise past the caller and stop the rest of a batch — every
function here returns a result/bool, never propagates a crawl-target's own
failure as an exception the batch loop doesn't already expect."""
from __future__ import annotations

import time
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import httpx

_HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Scriptorium research agent; +https://github.com/)"}
FETCH_TIMEOUT = 30.0
MIN_SECONDS_BETWEEN_REQUESTS_PER_DOMAIN = 3.0

_last_request_at: dict[str, float] = {}
_robots_cache: dict[str, RobotFileParser] = {}


def _domain(url: str) -> str:
    return urlparse(url).netloc


def allowed_by_robots(url: str) -> bool:
    domain = _domain(url)
    parser = _robots_cache.get(domain)
    if parser is None:
        parser = RobotFileParser()
        parser.set_url(f"{urlparse(url).scheme}://{domain}/robots.txt")
        try:
            parser.read()
        except Exception:
            # robots.txt unreachable/malformed — fail OPEN (most sites don't
            # have one, or it's a transient issue); this is a courtesy
            # check, not a security boundary.
            _robots_cache[domain] = parser
            return True
        _robots_cache[domain] = parser
    try:
        return parser.can_fetch(_HTTP_HEADERS["User-Agent"], url)
    except Exception:
        return True


def wait_for_rate_limit(url: str) -> None:
    """Blocks (briefly) if this domain was hit too recently. Simple
    in-process throttle — sufficient for a single-operator local deployment,
    not a distributed rate limiter."""
    domain = _domain(url)
    last = _last_request_at.get(domain)
    if last is not None:
        elapsed = time.monotonic() - last
        remaining = MIN_SECONDS_BETWEEN_REQUESTS_PER_DOMAIN - elapsed
        if remaining > 0:
            time.sleep(remaining)
    _last_request_at[domain] = time.monotonic()


def test_fetch(url: str) -> dict:
    """Sprint 2 Pass 3 (comment 7): 'Validate new URLs on add with an
    immediate test fetch.' Never raises — always returns a result the
    caller can show the researcher directly."""
    if not allowed_by_robots(url):
        return {"ok": False, "error": "Disallowed by robots.txt"}
    wait_for_rate_limit(url)
    try:
        r = httpx.get(url, timeout=FETCH_TIMEOUT, follow_redirects=True, headers=_HTTP_HEADERS)
        return {"ok": r.status_code < 400, "statusCode": r.status_code,
                "error": None if r.status_code < 400 else f"HTTP {r.status_code}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def main() -> None:
    """Sprint 6 Pass 1: a proper entrypoint for what routes/crawl-sources.ts
    used to invoke via `python -c "from ... import test_fetch; ..."` — a
    packaged PyInstaller sidecar has no interpreter to run arbitrary source
    passed as a runtime argument, only its own compiled entrypoints."""
    import argparse
    import json

    ap = argparse.ArgumentParser()
    ap.add_argument("--test-fetch", required=True, metavar="URL")
    args = ap.parse_args()
    print(json.dumps(test_fetch(args.test_fetch)))


if __name__ == "__main__":
    main()
