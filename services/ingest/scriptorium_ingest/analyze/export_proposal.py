"""Sprint 5 Pass 6 (comment 13) — export the current draft to .docx and
PDF. No document-creation stack existed anywhere in this codebase to
reuse (see docs/DASHBOARD-CORRECTIONS-SPRINT5-PASS0.md) — python-docx was
already a dependency (for READING uploads) and is reused here for
WRITING; reportlab is the one new dependency, chosen because it's pure
Python (no LibreOffice/Word/external binary needed, unlike a docx->pdf
conversion, which would make the PDF path only work on a machine that
happens to have Office installed). Both writers consume the SAME
draft_editor.compile_document() output, so the two formats — and the
in-app editor's own reference list — can never drift apart.

Run: python -m scriptorium_ingest.analyze.export_proposal --session-id N --format docx --out path
"""
from __future__ import annotations

import argparse
import re

from .draft_editor import compile_document


def _split_blocks(text: str) -> list[tuple[str, str]]:
    """('heading'|'body', text) pairs from the drafter's own lightweight
    markdown (# / ##) — not a general markdown parser, just enough
    structure for readable section export, matching what
    proposal_orchestrator.py's DRAFT_PROMPT actually asks the model to
    produce (a heading line, then paragraphs)."""
    blocks: list[tuple[str, str]] = []
    for raw_line in text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", line)
        if m:
            blocks.append(("heading", m.group(2).strip()))
        else:
            blocks.append(("body", line))
    # Merge consecutive body lines into paragraphs (the drafter wraps
    # prose across lines within one paragraph, blank-line-separated
    # already stripped above, so consecutive body lines ARE one paragraph
    # unless they were separately blank-line-delimited — safe default:
    # treat each non-empty line as its own paragraph, which reads fine
    # for the drafter's actual output shape).
    return blocks


_INLINE_MD = re.compile(r"(\*\*.+?\*\*|\*.+?\*)")


def _add_runs_with_inline_md(paragraph, text: str) -> None:
    """The drafter writes plain **bold**/*italic* markdown (see
    proposal-writer.md's craft rules) — render it as real run formatting
    instead of literal asterisks, since a Word-like export is the point
    of this pass."""
    for part in _INLINE_MD.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            paragraph.add_run(part[2:-2]).bold = True
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            paragraph.add_run(part[1:-1]).italic = True
        else:
            paragraph.add_run(part)


def build_docx(session_id: int, out_path: str) -> str:
    from docx import Document
    from docx.shared import Pt

    doc = compile_document(session_id)
    d = Document()
    d.add_heading(doc["title"], level=0)

    for sec in doc["sections"]:
        d.add_heading(sec["label"], level=1)
        for kind, content in _split_blocks(sec["text"]):
            if kind == "heading":
                d.add_heading(content, level=2)
            else:
                p = d.add_paragraph()
                _add_runs_with_inline_md(p, content)
                p.paragraph_format.space_after = Pt(6)

    if doc["references"]:
        d.add_heading("References", level=1)
        for ref in doc["references"]:
            d.add_paragraph(ref["ieee"])

    if doc["unresolvedCitations"]:
        d.add_heading("Unresolved citations (needs researcher attention)", level=2)
        for u in doc["unresolvedCitations"]:
            d.add_paragraph(u)

    d.save(out_path)
    return out_path


def build_pdf(session_id: int, out_path: str) -> str:
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from xml.sax.saxutils import escape

    doc = compile_document(session_id)
    styles = getSampleStyleSheet()
    h0 = ParagraphStyle("TitleX", parent=styles["Title"], fontSize=18, spaceAfter=14)
    h1 = ParagraphStyle("H1X", parent=styles["Heading1"], fontSize=14, spaceBefore=14, spaceAfter=8)
    h2 = ParagraphStyle("H2X", parent=styles["Heading2"], fontSize=12, spaceBefore=10, spaceAfter=6)
    body = ParagraphStyle("BodyX", parent=styles["BodyText"], fontSize=10.5, leading=15, spaceAfter=6)

    def rl_text(raw: str) -> str:
        # reportlab's Paragraph accepts a small safe subset of markup
        # (<b>, <i>) — escape first (asterisks aren't XML-unsafe, so this
        # order is safe), then convert the SAME **bold**/*italic* markdown
        # the docx path renders as real formatting.
        escaped = escape(raw)
        escaped = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)
        escaped = re.sub(r"\*(.+?)\*", r"<i>\1</i>", escaped)
        return escaped

    story = [Paragraph(rl_text(doc["title"]), h0)]
    for sec in doc["sections"]:
        story.append(Paragraph(rl_text(sec["label"]), h1))
        for kind, content in _split_blocks(sec["text"]):
            style = h2 if kind == "heading" else body
            story.append(Paragraph(rl_text(content), style))

    if doc["references"]:
        story.append(Paragraph("References", h1))
        for ref in doc["references"]:
            # ref["ieee"] already carries its own "[n] " prefix (built in
            # proposal_orchestrator.py's _ieee_entry) — use as-is.
            story.append(Paragraph(rl_text(ref["ieee"]), body))

    if doc["unresolvedCitations"]:
        story.append(Paragraph("Unresolved citations (needs researcher attention)", h2))
        for u in doc["unresolvedCitations"]:
            story.append(Paragraph(escape(u), body))

    pdf = SimpleDocTemplate(out_path, pagesize=LETTER,
                             leftMargin=1 * inch, rightMargin=1 * inch,
                             topMargin=1 * inch, bottomMargin=1 * inch)
    pdf.build(story)
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", type=int, required=True)
    ap.add_argument("--format", choices=["docx", "pdf"], required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    path = build_docx(args.session_id, args.out) if args.format == "docx" else build_pdf(args.session_id, args.out)
    print(path)


if __name__ == "__main__":
    main()
