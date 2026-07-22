"""PDF text extraction — PyMuPDF, in-process, no external service.
Returns {title, abstract, sections, captions, references}: sections is now
REAL per-heading splits (Pass 2.2), not one "Full text" blob — but every
existing caller (library/watch_folder.py, analyze/paper_analyst.py,
analyze/focus_extractor.py via document_reader.py) already only reads
`sections[i]["head"]`/`["text"]` generically, so this is purely additive,
same keys, same shapes, no caller changes needed. captions/references are
new keys callers can ignore. Tradeoff accepted knowingly: this is a
heading-regex heuristic, not GROBID's structured extraction — good enough
for the LLM deep-read (paper-analyst) to work from real section boundaries
instead of one undifferentiated blob, without standing up GROBID again
(Docker was removed on purpose, see project memory).

OCR fallback (Pass 1.3, dashboard-revision-brief.docx): when a PDF's text
layer is empty or near-empty (a scanned/image-only PDF), pages are rendered
to images and OCR'd via pytesseract. This is THE shared document reader —
Change 2's corpus ingestion (Pass 2.2) extends this module rather than
add a second PDF parser. Needs the Tesseract binary installed separately
(pytesseract only calls it, doesn't bundle it) — `winget install
UB-Mannheim.TesseractOCR` on Windows. If the binary truly isn't found, OCR
is skipped and whatever thin text-layer text exists is returned rather
than crashing the caller.

Sprint 3 Pass 2 (RD-Agent extraction brief): an OPTIONAL Azure Document
Intelligence path for scanned/multi-column PDFs where Tesseract's plain
OCR does worse (e.g. multi-column academic layouts, tables). Same opt-in
shape as analyze/embed.py's Voyage fallback — activates ONLY if both
AZURE_DOC_INTEL_KEY and AZURE_DOC_INTEL_ENDPOINT are set, so this
project's "no paid keys provisioned on the operator's behalf" rule holds:
nothing paid runs unless the operator supplies their own key. Enhances the
ONE existing OCR path rather than standing up RD-Agent's separate
langchain-PDF/Azure document_reader.py as a second reader (see
docs/RD-AGENT-EXTRACTION-PASS0.md) — needs `pip install
azure-ai-formrecognizer` only if actually used, so it is not a hard
dependency of this file."""
from __future__ import annotations
import io
import os
import re
import shutil
from pathlib import Path

import fitz  # PyMuPDF

_ABSTRACT_RE = re.compile(
    r"\babstract\b[:\s]*\n?(.*?)(?:\n\s*\n|\b(?:1\.?\s*)?introduction\b)",
    re.I | re.S,
)

_MIN_CHARS_PER_PAGE = 40  # below this average, treat the PDF as scanned/image-only

# Common section headings across STEM/social-science/humanities papers alike
# (Pass 2.2's Global Constraint: no discipline hardcoded) — generic
# structural words, not domain terms. Numbered ("1. Introduction") or bare.
_HEADING_RE = re.compile(
    r"^\s*(?:\d+\.?\d*\.?\s+)?"
    r"(Abstract|Introduction|Background|Related Work|Literature Review|"
    r"Methods?|Methodology|Materials and Methods|Experimental(?: Setup)?|"
    r"Results?|Findings|Discussion|Analysis|Conclusions?|Summary|"
    r"Limitations|Future Work|Acknowledge?ments?|References|Bibliography|"
    r"Appendix\w*)\s*$",
    re.I | re.M,
)
_CAPTION_RE = re.compile(r"^\s*(Fig(?:ure)?\.?|Table)\s+\d+[:.]\s*.+$", re.I | re.M)
_REFERENCES_HEAD_RE = re.compile(r"^\s*(References|Bibliography)\s*$", re.I | re.M)


def _split_sections(full_text: str) -> list[dict]:
    """Split on recognized headings; text before the first heading (title/
    author block, or abstract on some layouts) becomes a "Front matter"
    section rather than being dropped."""
    matches = list(_HEADING_RE.finditer(full_text))
    if not matches:
        return [{"head": "Full text", "text": full_text[:200000]}]
    sections = []
    if matches[0].start() > 0:
        front = full_text[:matches[0].start()].strip()
        if front:
            sections.append({"head": "Front matter", "text": front[:200000]})
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(full_text)
        sections.append({"head": m.group(1).strip().title(), "text": full_text[start:end].strip()[:200000]})
    return sections


def _extract_captions(full_text: str) -> list[str]:
    return [re.sub(r"\s+", " ", m.group(0)).strip()[:500] for m in _CAPTION_RE.finditer(full_text)][:100]


def _extract_references(full_text: str) -> str:
    m = _REFERENCES_HEAD_RE.search(full_text)
    if not m:
        return ""
    return full_text[m.end():].strip()[:50000]


def parse_pdf(pdf_path: str, ocr_max_pages: int | None = None) -> dict:
    """ocr_max_pages caps how many pages get OCR'd if the text layer is
    too thin (None = no cap, OCR every page — the default for thorough
    corpus ingestion). A capped caller (e.g. a quick focus-synthesis pass
    over a few uploaded documents) can pass a small number for speed."""
    doc = fitz.open(pdf_path)
    try:
        title = ((doc.metadata or {}).get("title") or "").strip()
        full_text = "\n".join(page.get_text() for page in doc)
        if len(full_text) < _MIN_CHARS_PER_PAGE * max(doc.page_count, 1):
            ocr_text = _ocr_via_azure(pdf_path, doc.page_count) or _ocr_pages(doc, ocr_max_pages)
            if ocr_text:
                full_text = ocr_text
    finally:
        doc.close()
    if not title:
        title = _first_line(full_text)
    abstract = _extract_abstract(full_text)
    return {
        "title": title,
        "abstract": abstract,
        "sections": _split_sections(full_text),
        "captions": _extract_captions(full_text),
        "references": _extract_references(full_text),
    }


def _ocr_via_azure(pdf_path: str, page_count: int) -> str:
    """Optional (see module docstring) — tried BEFORE the free Tesseract
    fallback only when the operator has set both env vars; returns "" on
    any error or when unconfigured, so the caller falls through to
    Tesseract exactly as before this pass."""
    key = os.environ.get("AZURE_DOC_INTEL_KEY")
    endpoint = os.environ.get("AZURE_DOC_INTEL_ENDPOINT")
    if not key or not endpoint:
        return ""
    try:
        from azure.ai.formrecognizer import DocumentAnalysisClient
        from azure.core.credentials import AzureKeyCredential
        client = DocumentAnalysisClient(endpoint=endpoint, credential=AzureKeyCredential(key))
        with open(pdf_path, "rb") as f:
            result = client.begin_analyze_document(
                "prebuilt-document", f, pages=f"1-{max(page_count, 1)}",
            ).result()
        return result.content or ""
    except Exception:
        return ""


def _locate_tesseract() -> str | None:
    """A fresh Tesseract install may not be on THIS process's inherited
    PATH yet (Windows doesn't retroactively update already-open shells),
    so check the standard install locations explicitly before giving up."""
    found = shutil.which("tesseract")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    ):
        if Path(candidate).exists():
            return candidate
    return None


def _ocr_pages(doc, max_pages: int | None) -> str:
    tesseract_cmd = _locate_tesseract()
    if not tesseract_cmd:
        return ""
    import pytesseract
    from PIL import Image

    pytesseract.pytesseract.tesseract_cmd = tesseract_cmd
    pages = list(doc)[:max_pages] if max_pages else list(doc)
    pages_text = []
    for page in pages:
        pix = page.get_pixmap(dpi=200)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        pages_text.append(pytesseract.image_to_string(img))
    return "\n".join(pages_text)


def _first_line(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:300]
    return ""


def _extract_abstract(text: str) -> str:
    m = _ABSTRACT_RE.search(text[:6000])  # abstract is always near the start
    if not m:
        return ""
    return re.sub(r"\s+", " ", m.group(1)).strip()[:3000]
