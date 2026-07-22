"""Deep-reading cache: for every paper with an oa_url and no cached analysis,
fetch the PDF, parse it via PyMuPDF, and deep-read it with the paper-analyst
persona (frontier model — config/models.yaml task: deep_paper_analysis),
writing the result into papers.structured_summary.

Reuses .claude/agents/paper-analyst.md as the single source of truth for the
analytical approach (claim ledger, method, limitations, relation to focus,
reusable artifacts) so the batch pipeline and the interactive /paper-analyst
skill never drift apart — only the output framing (JSON here, prose there)
differs.

Run:  python -m scriptorium_ingest.analyze.paper_analyst [--limit N]
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urljoin

import httpx

# Paper titles/text routinely carry non-ASCII (ligatures, accents, math
# symbols); stdout defaults to the Windows console code page (cp1252) when
# redirected to a file/pipe, which crashes on the first such character.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..llm.dispatch import complete
from ..config import CONFIG_DIR, task_model
from ..db import (
    conn, papers_needing_analysis_or_chunking, paper_has_chunks, replace_paper_chunks,
    set_paper_embedding, set_structured_summary, log_run, describe_current_research_focus,
)
from ..parse.pdf_parser import parse_pdf
from .chunking import chunk_parsed, embed_chunks
from .embed import embed_batch

PERSONA_PATH = CONFIG_DIR.parent / ".claude" / "agents" / "paper-analyst.md"

JSON_INSTRUCTIONS = """
Return ONLY a JSON object (no prose, no markdown fences) with this shape:
{{
  "problem": string,
  "claim_ledger": [{{"claim": string, "evidence": string, "confidence": "supported"|"partially"|"asserted-only"}}],
  "method": string,
  "findings": string,
  "limitations_admitted": string,
  "limitations_not_admitted": string,
  "gaps": [string],
  "relation_to_focus": string,
  "reusable_artifacts": [string]
}}
"problem" is the specific question/gap in prior work this paper sets out to
address, in the authors' own framing. "findings" is what was actually
shown (distinct from "method" — how; and from "claim_ledger" — the
per-claim evidence ledger). "gaps" are limitations or unanswered questions
THIS paper itself surfaces that could seed future work (Pass 2.2/Change 3
consume this for grounded gap-brainstorming) — not a restatement of
limitations_not_admitted, but forward-looking openings.
If the parsed text is too garbled to analyze responsibly, still return this
shape with each field explaining what's unusable rather than inventing content.

Research group's focus (Research Focus profile): {goal}

Paper title: {title}
Parsed sections (may be imperfect OCR/TEI extraction):
---
{body}
---"""


def _persona_body() -> str:
    text = PERSONA_PATH.read_text(encoding="utf-8")
    return re.sub(r"^---.*?---\s*", "", text, flags=re.S).strip()


_CITATION_PDF_RE = re.compile(
    r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']', re.I)
_HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Scriptorium research agent)"}


def _get(url: str, timeout: float = 90) -> httpx.Response:
    r = httpx.get(url, timeout=timeout, follow_redirects=True, headers=_HTTP_HEADERS)
    r.raise_for_status()
    return r


def _fetch_pdf(url: str, dest: Path) -> None:
    if not re.match(r"^https?://", url or "", re.I):
        raise ValueError(f"not a fetchable URL: {url!r}")
    r = _get(url)
    ctype = r.headers.get("content-type", "")
    if "pdf" not in ctype and not url.lower().endswith(".pdf"):
        # Landing page, not a direct PDF link — try the standard
        # citation_pdf_url meta tag (the same convention Google Scholar
        # relies on) before giving up on this source.
        m = _CITATION_PDF_RE.search(r.text)
        if not m:
            raise ValueError(f"landing page with no citation_pdf_url meta tag "
                              f"({ctype or 'unknown content-type'})")
        r = _get(urljoin(str(r.url), m.group(1)))
        ctype = r.headers.get("content-type", "")
        if "pdf" not in ctype:
            raise ValueError(f"citation_pdf_url did not resolve to a PDF ({ctype or 'unknown content-type'})")
    dest.write_bytes(r.content)


def analyze_parsed(parsed: dict, title: str, persona: str, model: str, goal: str,
                    fallback_abstract: str = "") -> dict:
    """The reusable core: given ALREADY-PARSED document content (from
    parse.pdf_parser.parse_pdf via any source — HTTP fetch here, or a local
    library-inbox file in analyze/corpus_ingest.py, Pass 2.2), build the
    prompt and run the LLM deep-read. Kept separate from `_analyze_one` so
    corpus_ingest.py doesn't duplicate this prompt-building/LLM-call logic
    for locally-uploaded PDFs, which have no oa_url to fetch from. """
    body = "\n\n".join(f"## {s['head']}\n{s['text']}" for s in parsed["sections"])[:80000]
    if not body.strip():
        body = parsed.get("abstract", "") or fallback_abstract or ""
    prompt = persona + JSON_INSTRUCTIONS.format(
        goal=goal, title=title or parsed.get("title", ""), body=body)
    text = complete(prompt, model=model)
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    return json.loads(text)


def _fetch_and_parse(paper: dict, tmpdir: Path) -> dict:
    pdf_path = tmpdir / f"{paper['id']}.pdf"
    _fetch_pdf(paper["oa_url"], pdf_path)
    return parse_pdf(str(pdf_path))


def _chunk_and_embed_one(paper: dict, parsed: dict) -> None:
    """Sprint 2 Pass 2 (comment 12): the full-corpus backfill — every
    oa_url-fetchable paper gets the SAME chunk+embed treatment Pass 2.2 gave
    only to locally-uploaded PDFs (analyze/chunking.py, shared with
    corpus_ingest.py, not a second implementation)."""
    with conn() as c:
        chunks = chunk_parsed(parsed)
        embedded = embed_chunks(chunks) if chunks else []
        replace_paper_chunks(c, paper["id"], embedded)
        doc_summary = f"{paper['title'] or ''}\n{paper.get('abstract') or ''}".strip()
        if doc_summary:
            [doc_vec] = embed_batch([doc_summary])
            set_paper_embedding(c, paper["id"], doc_vec)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    cfg = task_model("deep_paper_analysis")
    persona = _persona_body()
    summary = {"analyzed": 0, "chunked": 0, "skipped_already_done": 0, "errors": []}

    with conn() as c, tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        goal = describe_current_research_focus(c)
        targets = papers_needing_analysis_or_chunking(c, limit=args.limit)
        total = len(targets)
        for i, p in enumerate(targets, 1):
            needs_analysis = p["structured_summary"] is None
            with conn() as c2:
                needs_chunking = not paper_has_chunks(c2, p["id"])
            if not needs_analysis and not needs_chunking:
                summary["skipped_already_done"] += 1
                print(f"[{i}/{total}] skip (already complete): {p['title'] or p['id']}", flush=True)
                continue
            try:
                parsed = _fetch_and_parse(p, tmpdir)
                if needs_analysis:
                    result = analyze_parsed(parsed, p["title"], persona, cfg["model"], goal, p.get("abstract") or "")
                    with conn() as c3:
                        set_structured_summary(c3, p["id"], result)
                    summary["analyzed"] += 1
                if needs_chunking:
                    _chunk_and_embed_one(p, parsed)
                    summary["chunked"] += 1
                print(f"[{i}/{total}] ok: {p['title'] or p['id']}", flush=True)
            except Exception as e:
                msg = f"paper {p['id']} ({p['title'] or 'untitled'}): {type(e).__name__}: {e}"
                summary["errors"].append(msg)
                print(f"[{i}/{total}] ERROR: {msg}", flush=True)
        summary["attempted"] = len(targets)
        log_run(c, "paper_analysis", summary)

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
