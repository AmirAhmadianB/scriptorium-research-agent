"""First-page PDF screenshot (Sprint 3 Pass 2) — genuinely new capability,
no existing analog (see docs/RD-AGENT-EXTRACTION-PASS0.md). Adapted from
extract_first_page_screenshot_from_pdf() in microsoft/RD-Agent's
components/document_reader/document_reader.py (MIT — see ../NOTICE).
Reuses PyMuPDF (`fitz`), already a hard dependency via parse/pdf_parser.py —
no new package required."""
from __future__ import annotations
import io
from pathlib import Path

import fitz  # PyMuPDF
import httpx
from PIL import Image


def extract_first_page_screenshot(pdf_path_or_url: str) -> Image.Image:
    if Path(pdf_path_or_url).exists():
        doc = fitz.open(pdf_path_or_url)
    else:
        resp = httpx.get(pdf_path_or_url, timeout=30)
        resp.raise_for_status()
        doc = fitz.open(stream=io.BytesIO(resp.content), filetype="pdf")
    try:
        pix = doc.load_page(0).get_pixmap()
        return Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
    finally:
        doc.close()
