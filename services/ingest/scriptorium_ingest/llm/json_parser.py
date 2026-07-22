"""Multi-strategy JSON-from-LLM-text extraction (Sprint 3 Pass 3). Ported
near-verbatim from JSONParser in microsoft/RD-Agent's oai/backend/base.py
(MIT — see ../knowledge/NOTICE) — this class had zero rdagent.* coupling
in the original, so nothing needed stripping.

Replaces the same `re.sub(r"^```(json)?|```$", "", text.strip())` one-liner
duplicated in crawl_funding.py, proposal_orchestrator.py, ask_corpus.py, and
knowledge/ingest.py — those call sites are NOT migrated in this pass (out of
scope for "port the LLM layer"; migrating call sites is incremental cleanup,
not new capability), but any NEW LLM-JSON call site (Pass 4's propose/
critique loop) uses this instead of adding a fifth copy of the same regex."""
from __future__ import annotations
import io
import json
import re
import tokenize
from typing import Callable


class JSONParser:
    """Tries several strategies in order; returns the first that parses.
    parse() returns the cleaned-up JSON *string* — caller still does
    json.loads() on the result, same as RD-Agent's original contract."""

    def __init__(self) -> None:
        self.strategies: list[Callable[[str], str]] = [
            self._direct_parse,
            self._extract_from_code_block,
            self._fix_python_syntax,
            self._extract_with_fix_combined,
        ]

    def parse(self, content: str) -> str:
        original_content = content
        for strategy in self.strategies:
            try:
                return strategy(original_content)
            except json.JSONDecodeError:
                continue
        raise json.JSONDecodeError(
            "Failed to parse JSON after all strategies — check the prompt asks for JSON explicitly",
            original_content, 0,
        )

    def parse_obj(self, content: str):
        """Convenience: parse() + json.loads() in one call."""
        return json.loads(self.parse(content))

    def _direct_parse(self, content: str) -> str:
        try:
            json.loads(content)
            return content
        except json.JSONDecodeError as e:
            if "Extra data" in str(e):
                return self._extract_first_json(content)
            raise

    def _extract_from_code_block(self, content: str) -> str:
        match = re.search(r"```json\s*(.*?)\s*```", content, re.DOTALL)
        if not match:
            raise json.JSONDecodeError("No JSON code block found", content, 0)
        return self._direct_parse(match.group(1).strip())

    def _fix_python_syntax(self, content: str) -> str:
        return self._direct_parse(self._fix_python_booleans(content))

    def _extract_with_fix_combined(self, content: str) -> str:
        fixed = self._fix_python_booleans(content)
        match = re.search(r"```json\s*(.*?)\s*```", fixed, re.DOTALL)
        if match:
            fixed = match.group(1).strip()
        return self._direct_parse(fixed)

    @staticmethod
    def _fix_python_booleans(json_str: str) -> str:
        replacements = {"True": "true", "False": "false", "None": "null"}
        try:
            out = []
            tokens = tokenize.generate_tokens(io.StringIO(json_str).readline)
            for toknum, tokval, *_ in tokens:
                out.append(replacements.get(tokval, tokval) if toknum == tokenize.NAME else tokval)
            return "".join(out)
        except (tokenize.TokenError, json.JSONDecodeError):
            for python_val, json_val in replacements.items():
                json_str = re.sub(rf"\b{python_val}\b", json_val, json_str)
            return json_str

    @staticmethod
    def _extract_first_json(response: str) -> str:
        decoder = json.JSONDecoder()
        obj, _ = decoder.raw_decode(response)
        return json.dumps(obj)
