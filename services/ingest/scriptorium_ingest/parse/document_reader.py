"""Unified document reader — THE shared module for reading uploaded/ingested
documents (dashboard-revision-brief.docx: Pass 1.3 builds it, Pass 2.2's
corpus ingestion must extend it rather than add a second reader). Dispatches
by file extension, always returning pdf_parser's established
{title, abstract, sections} shape regardless of source format."""
from __future__ import annotations
from pathlib import Path

from .pdf_parser import parse_pdf

_MAX_TEXT_CHARS = 200000


def read_document(file_path: str, ocr_max_pages: int | None = None) -> dict:
    ext = Path(file_path).suffix.lower()
    if ext == ".pdf":
        return parse_pdf(file_path, ocr_max_pages=ocr_max_pages)
    if ext == ".docx":
        return _read_docx(file_path)
    if ext in (".txt", ".md"):
        return _read_text(file_path)
    raise ValueError(f"Unsupported document type: {ext or '(no extension)'}")


def _read_docx(file_path: str) -> dict:
    import docx  # python-docx
    d = docx.Document(file_path)
    paragraphs = [p.text for p in d.paragraphs if p.text.strip()]
    full_text = "\n".join(paragraphs)
    title = paragraphs[0][:300] if paragraphs else Path(file_path).stem
    return {
        "title": title,
        "abstract": " ".join(paragraphs[1:4])[:3000] if len(paragraphs) > 1 else "",
        "sections": [{"head": "Full text", "text": full_text[:_MAX_TEXT_CHARS]}],
    }


def _read_text(file_path: str) -> dict:
    text = Path(file_path).read_text(encoding="utf-8", errors="replace")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    title = lines[0][:300] if lines else Path(file_path).stem
    return {
        "title": title,
        "abstract": " ".join(lines[1:4])[:3000] if len(lines) > 1 else "",
        "sections": [{"head": "Full text", "text": text[:_MAX_TEXT_CHARS]}],
    }
