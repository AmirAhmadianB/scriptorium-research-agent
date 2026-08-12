"""Shells out to the Agent-Reach toolchain (github.com/Panniantong/Agent-Reach)
installed on this machine — `mcporter` (Exa semantic web search via MCP) and
`gh` (GitHub search) — mirroring claude_cli.py's subprocess-shim/retry shape
exactly: resolve the executable via shutil.which(), route a Windows .cmd/.bat
shim through cmd.exe instead of shell=True, subprocess.run with
capture_output/text/encoding/timeout, CREATE_NO_WINDOW on win32, and a
tenacity retry for transient failures.

Unlike claude_cli.complete() (which raises on failure and lets the caller
decide), exa_search()/github_search() are ingestion-source connectors that
must never take down a scan over one flaky call — they catch everything and
degrade to [] with a logged warning, the same "one bad source must not stop
the sweep" convention crawl_literature.py/crawl_funding.py already use for
network failures.

Output formats (live-verified against the installed CLIs, not guessed):
  - `mcporter call exa.web_search_exa query=... numResults=N` prints plain
    text, one result per block, blocks separated by a line of "---":
        Title: <title>
        URL: <url>
        Published: <ISO datetime>|N/A
        Author: <name>|N/A
        Highlights:
        <markdown, possibly many lines/paragraphs>
  - `gh search repos <query> --limit N --json fullName,description,url,
    stargazersCount,updatedAt` prints a JSON array directly — no parsing
    needed beyond json.loads().
"""
from __future__ import annotations
import json
import logging
import re
import shutil
import subprocess
import sys

from tenacity import retry, stop_after_attempt, wait_exponential

logger = logging.getLogger("scriptorium_ingest.agent_reach_cli")

GH_JSON_FIELDS = "fullName,description,url,stargazersCount,updatedAt"


class AgentReachCliError(RuntimeError):
    pass


def _windows_shim_command(exe: str) -> list[str]:
    """Same shim-routing rule as claude_cli._claude_command(): npm installs
    its CLIs as .cmd shims on Windows, which subprocess (no shell=True)
    can't exec directly, so route those through cmd.exe explicitly."""
    if sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe]
    return [exe]


def _mcporter_command() -> list[str]:
    exe = shutil.which("mcporter")
    if exe is None:
        raise AgentReachCliError("`mcporter` CLI not found on PATH")
    return _windows_shim_command(exe)


def _gh_command() -> list[str]:
    exe = shutil.which("gh")
    if exe is None:
        raise AgentReachCliError("`gh` CLI not found on PATH")
    return _windows_shim_command(exe)


@retry(stop=stop_after_attempt(4), wait=wait_exponential(min=3, max=30), reraise=True)
def _run(command: list[str], args: list[str], timeout: int) -> str:
    proc = subprocess.run(
        command + args, capture_output=True, text=True, encoding="utf-8", errors="replace",
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if proc.returncode != 0:
        raise AgentReachCliError(
            f"{command[-1]} exited {proc.returncode}: stderr={proc.stderr[:500]!r} "
            f"stdout={proc.stdout[:500]!r}"
        )
    return proc.stdout


def _parse_exa_output(stdout: str) -> list[dict]:
    """Parse mcporter's plain-text exa.web_search_exa output into
    {title, url, published, snippet} dicts. Blocks are separated by a
    standalone "---" line; each block's Highlights section (everything
    after "Highlights:") becomes the snippet, with "..." paragraph
    separators dropped and the result capped to keep the connector's
    abstract field reasonably sized."""
    results: list[dict] = []
    blocks = re.split(r"\n-{3,}\n", stdout.strip())
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        m_title = re.search(r"^Title:\s*(.*)$", block, re.M)
        m_url = re.search(r"^URL:\s*(.*)$", block, re.M)
        m_pub = re.search(r"^Published:\s*(.*)$", block, re.M)

        url = (m_url.group(1).strip() if m_url else "") or None
        if not url:
            continue  # a result with no URL is useless as an ingestion record
        title = (m_title.group(1).strip() if m_title else "") or None

        published = (m_pub.group(1).strip() if m_pub else "")
        if published in ("", "N/A"):
            published = None

        snippet = ""
        head, sep, tail = block.partition("Highlights:")
        if sep:
            lines = [ln.strip() for ln in tail.splitlines() if ln.strip() and ln.strip() != "..."]
            snippet = " ".join(lines).strip()[:800]

        results.append({"title": title, "url": url, "published": published, "snippet": snippet})
    return results


def exa_search(query: str, num_results: int = 5) -> list[dict]:
    """Exa semantic web search via mcporter's MCP bridge. Returns
    [] (never raises) on any failure — missing binary, timeout, malformed
    output — so one keyword's failed search doesn't abort a scan."""
    try:
        stdout = _run(_mcporter_command(),
                      ["call", "exa.web_search_exa", f"query={query}", f"numResults={num_results}"],
                      timeout=60)
    except Exception as e:
        logger.warning(f"exa_search failed for query={query!r}: {e}")
        return []
    try:
        return _parse_exa_output(stdout)
    except Exception as e:
        logger.warning(f"exa_search: failed to parse mcporter output for query={query!r}: {e}")
        return []


def github_search(query: str, max_results: int = 5) -> list[dict]:
    """GitHub repo search via `gh search repos --json ...` — gh already
    emits clean JSON, so this is pure fetch + json.loads(), no text
    parsing. Returns [] (never raises) on any failure."""
    try:
        stdout = _run(_gh_command(),
                      ["search", "repos", query, "--limit", str(max_results), "--json", GH_JSON_FIELDS],
                      timeout=30)
    except Exception as e:
        logger.warning(f"github_search failed for query={query!r}: {e}")
        return []
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as e:
        logger.warning(f"github_search: bad JSON from gh for query={query!r}: {e}")
        return []
    return data if isinstance(data, list) else []
