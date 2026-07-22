"""Trend signals from the corpus: keyword velocity, new authors, venue shifts.
Emits JSON for the trend-analyst subagent — counts, never vibes."""
from __future__ import annotations
import argparse
import json
from collections import Counter, defaultdict
from ..config import focus
from ..db import conn, current_research_focus_keywords


def compute(window_years: int) -> dict:
    velocity: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    authors_by_year: dict[int, Counter] = defaultdict(Counter)
    venues_by_year: dict[int, Counter] = defaultdict(Counter)

    with conn() as c:
        # Pass 1.5e: keyword velocity tracks the CURRENT Research Focus
        # profile (Change 1), not the legacy config/focus.yaml keyword list,
        # so a trend brief is grounded in whatever domain the researcher has
        # actually set, in any field, without a code change.
        kw = [k.lower() for k in current_research_focus_keywords(c)]
        rows = c.execute(
            """SELECT title, abstract, year, venue, authors FROM papers
               WHERE year >= CAST(strftime('%Y', 'now') AS INTEGER) - ?""",
            (window_years,)).fetchall()

    for title, abstract, year, venue, authors_json in rows:
        text = f"{title} {abstract or ''}".lower()
        for k in kw:
            if k.split(" /")[0].lower() in text:
                velocity[k][year] += 1
        if venue:
            venues_by_year[year][venue] += 1
        authors = json.loads(authors_json) if authors_json else []
        for a in authors:
            authors_by_year[year][a.get("name", "?")] += 1

    years = sorted({y for d in velocity.values() for y in d})
    def slope(series: dict[int, int]) -> float:
        if len(years) < 2:
            return 0.0
        first, last = years[0], years[-1]
        return (series.get(last, 0) - series.get(first, 0)) / max(1, last - first)

    latest = years[-1] if years else None
    prior_names = {n for y in years[:-1] for n in authors_by_year[y]}
    new_authors = ([n for n, cnt in authors_by_year[latest].most_common(50)
                    if n not in prior_names and cnt >= 2] if latest else [])

    return {
        "window_years": window_years,
        "paper_count": len(rows),
        "keyword_velocity": {k: {"by_year": dict(v), "slope_per_year": round(slope(v), 2)}
                             for k, v in velocity.items()},
        "new_authors_latest_year": new_authors[:15],
        "top_venues_latest_year": (venues_by_year[latest].most_common(10) if latest else []),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", nargs="*", default=[])
    args = ap.parse_args()
    win = int(args.window[0]) if args.window and str(args.window[0]).isdigit() \
        else focus().get("horizon_years", 4)
    print(json.dumps(compute(win), indent=2, default=str))
