"""Derive candidate Research Focus keywords + a focus synthesis from one or
more uploaded documents (Pass 1.3, dashboard-revision-brief.docx). Reads
each document via the shared parse/document_reader.py (Pass 2.2's corpus
ingestion reuses that same reader — not this module, which is specific to
the "propose a handful of keywords + a synthesis paragraph" task, not
per-paper deep analysis).

Nothing here writes to the profile — this only proposes; the dashboard
presents the result for the researcher to edit/accept/reject, and only a
separate, explicit commit (POST /api/research-profile) applies anything.

Run: python -m scriptorium_ingest.analyze.focus_extractor <file1> [file2 ...]
Prints one JSON object to stdout: {"keywords": [...], "focusSynthesis": "..."}
"""
from __future__ import annotations
import json
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from ..llm.dispatch import complete
from ..config import task_model
from ..parse.document_reader import read_document

# A handful of uploaded documents is meant to be a QUICK focus-setting step,
# not a thorough ingest (that's Pass 2.2) — cap OCR pages and per-document
# text so this stays fast even on long or scanned uploads.
_OCR_MAX_PAGES = 15
_MAX_CHARS_PER_DOC = 20000

PROMPT_TEMPLATE = """You are helping a researcher define the "Research Focus" for an \
academic research-intelligence system, by reading documents they uploaded \
(their own papers, a thesis chapter, a report — anything describing their \
research domain). The system has no idea what field this is; infer it \
entirely from what's below, whatever field that turns out to be.

Read the document excerpts below and propose:
1. 5-12 candidate keywords/phrases capturing the specific domain, methods, \
and subject matter (not generic words like "research" or "study").
2. A short (2-4 sentence) focus synthesis describing the domain, themes, \
and scope these documents suggest.

Return ONLY a JSON object, no prose, no markdown fences:
{{"keywords": [string, ...], "focusSynthesis": string}}

Documents:
---
{documents}
---"""


def derive_focus(file_paths: list[str]) -> dict:
    read_errors = []
    excerpts = []
    for fp in file_paths:
        try:
            doc = read_document(fp, ocr_max_pages=_OCR_MAX_PAGES)
        except Exception as e:
            read_errors.append(f"{fp}: {type(e).__name__}: {e}")
            continue
        body = "\n\n".join(s["text"] for s in doc["sections"])
        header = f"## {doc['title'] or fp}\n"
        if doc["abstract"]:
            header += doc["abstract"] + "\n"
        excerpts.append((header + body)[:_MAX_CHARS_PER_DOC])

    if not excerpts:
        return {"keywords": [], "focusSynthesis": "", "errors": read_errors or ["no readable documents"]}

    cfg = task_model("focus_synthesis")
    prompt = PROMPT_TEMPLATE.format(documents="\n\n".join(excerpts))
    text = complete(prompt, model=cfg["model"])
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.M).strip()
    result = json.loads(text)
    result.setdefault("keywords", [])
    result.setdefault("focusSynthesis", "")
    if read_errors:
        result["errors"] = read_errors
    return result


def main() -> None:
    file_paths = sys.argv[1:]
    if not file_paths:
        print(json.dumps({"keywords": [], "focusSynthesis": "", "errors": ["no files provided"]}))
        return
    print(json.dumps(derive_focus(file_paths)))


if __name__ == "__main__":
    main()
