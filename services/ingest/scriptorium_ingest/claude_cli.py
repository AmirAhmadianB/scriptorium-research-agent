"""Runs extraction/analysis prompts through the locally-installed Claude Code
CLI in headless print mode, so standalone Python workers ride the same
Claude subscription as an interactive session instead of requiring a
separate billed ANTHROPIC_API_KEY. Prompt goes over stdin (not argv) so
long page/paper text isn't limited by the OS command-line length."""
from __future__ import annotations
import json
import shutil
import subprocess
import sys

from tenacity import retry, stop_after_attempt, wait_exponential


class ClaudeCliError(RuntimeError):
    pass


def _claude_command() -> list[str]:
    """Resolve the `claude` executable. On Windows, npm installs it as a
    .cmd shim, which subprocess (no shell) can't exec directly — route it
    through cmd.exe explicitly instead of relying on shell=True."""
    exe = shutil.which("claude")
    if exe is None:
        raise ClaudeCliError("`claude` CLI not found on PATH")
    if sys.platform == "win32" and exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe]
    return [exe]


@retry(stop=stop_after_attempt(4), wait=wait_exponential(min=3, max=30),
       reraise=True)
def complete(prompt: str, model: str, timeout: int = 180) -> str:
    """A meaningful fraction of headless `claude -p` calls exit 1 with no
    stderr when another Claude Code process (e.g. the interactive session
    driving this worker) is active on the same machine at the same moment —
    a transient resource-contention failure, not a deterministic one (the
    identical call reliably succeeds on retry), so retry like any other
    flaky external dependency."""
    proc = subprocess.run(
        _claude_command() + ["--model", model, "-p", "--output-format", "json", "--tools", ""],
        input=prompt, capture_output=True, text=True, encoding="utf-8", timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    if proc.returncode != 0:
        raise ClaudeCliError(f"claude CLI exited {proc.returncode}: "
                             f"stderr={proc.stderr[:500]!r} stdout={proc.stdout[:500]!r}")
    data = json.loads(proc.stdout)
    if data.get("is_error"):
        raise ClaudeCliError(f"claude CLI error: {data.get('result') or data}")
    return data["result"]
