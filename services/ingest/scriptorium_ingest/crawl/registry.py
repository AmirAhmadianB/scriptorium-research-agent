"""Sprint 2 Pass 3 (comments 7/8) — one-time (idempotent) migration of the
crawl targets that were previously only implicit in config YAML into the
persisted crawl_sources registry, which is authoritative from here on.
config/funding.yaml's `sources:` list and config/sources.yaml's
`crawl.targets` are read ONCE at seed time; after that, edits happen
through the registry (DB), not by hand-editing YAML — the whole point of
comment 7 is a UI the researcher can add/disable/remove sources through.

Run: python -m scriptorium_ingest.crawl.registry --seed
"""
from __future__ import annotations

import argparse

from ..config import funding, sources
from ..db import add_crawl_source, conn


def seed_from_config() -> dict:
    added = 0
    with conn() as c:
        for src in funding()["sources"]:
            if not src.get("url"):
                continue
            add_crawl_source(c, src["url"], src["name"], "funding", src.get("scope", "national"))
            added += 1
        for target in sources()["crawl"]["targets"]:
            add_crawl_source(c, target["url"], target["name"], "literature", None)
            added += 1
    return {"seeded": added}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true")
    args = ap.parse_args()
    if args.seed:
        import json
        print(json.dumps(seed_from_config(), indent=2))
    else:
        raise SystemExit("Specify --seed")


if __name__ == "__main__":
    main()
