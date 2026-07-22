"""Load the YAML control plane (focus / sources / funding / models).

Dev mode: everything user-editable lives in config/*.yaml at the repo root
so the /focus and /sources skills, the dashboard, and these workers all read
the same truth. Sprint 6 Pass 1 (A0): SCRIPTORIUM_CONFIG_DIR overrides this
— the Node API sets it on every worker spawn (pythonRunner.ts), pointing
here at the packaged per-user data dir's seeded config copy in packaged
mode, or the repo's own config/ in dev (same default as before this pass
when the env var isn't set at all, e.g. a worker run directly from a
terminal during development).

Sprint 6 Pass 3: `Path(__file__).resolve().parents[3]` stops meaning
anything once this module runs inside a PyInstaller-frozen executable —
`__file__` there resolves inside the bundle's internal extraction path, not
the real source tree, and parents[3] silently computed a nonsensical
directory (caught live: a frozen build launched without
SCRIPTORIUM_CONFIG_DIR set tried to read config from inside the PyInstaller
output folder itself and failed with a confusing FileNotFoundError three
calls deep). The real Node caller always sets SCRIPTORIUM_CONFIG_DIR/
SCRIPTORIUM_DATA_DIR on every packaged-mode spawn (pythonRunner.ts), so
this never fires against the real app — but a frozen build with either
missing now fails immediately with a clear message instead of guessing."""
from __future__ import annotations
import os
import sys
from pathlib import Path
import yaml

FROZEN = getattr(sys, "frozen", False)


def _require_env_when_frozen(key: str) -> str | None:
    val = os.environ.get(key)
    if FROZEN and not val:
        raise RuntimeError(
            f"{key} must be set when running the packaged sidecar — there is no "
            "source tree to fall back to inside a frozen build. This should always "
            "be set by the Node API that spawns this process (pythonRunner.ts); "
            "seeing this means the sidecar was launched some other way."
        )
    return val


# Meaningless once frozen (see module docstring) — only ever consulted
# below when NOT frozen, so it's never allowed to silently produce a wrong
# path; still computed unconditionally because it's cheap and other
# not-yet-audited call sites may reference it directly.
REPO_ROOT = Path(__file__).resolve().parents[3]

_config_env = _require_env_when_frozen("SCRIPTORIUM_CONFIG_DIR")
CONFIG_DIR = Path(_config_env) if _config_env else REPO_ROOT / "config"

# The one DATA_DIR every other data/ consumer (db.py, knowledge/store.py)
# should import from, rather than each recomputing REPO_ROOT/"data" or
# SCRIPTORIUM_DATA_DIR independently — same seam apps/api/src/dataDir.ts is
# on the Node side.
_data_env = _require_env_when_frozen("SCRIPTORIUM_DATA_DIR")
DATA_DIR = Path(_data_env) if _data_env else REPO_ROOT / "data"

# Mirrors apps/api/src/runtime.ts's mode — the Node API always sets
# SCRIPTORIUM_MODE when it spawns a worker (pythonRunner.ts), so this is
# reliable whenever a worker runs under the API; a worker run standalone
# from a terminal in dev (no Node parent) correctly defaults to "dev".
MODE = os.environ.get("SCRIPTORIUM_MODE", "dev")
INGEST_SOURCE_DIR = REPO_ROOT / "services" / "ingest"


def resolve_data_relative_path(configured: str) -> Path:
    """Resolves a relative path from config/sources.yaml the same way
    apps/api/src/dataDir.ts resolves paths.libraryInbox: dev mode preserves
    exactly where a relative path has always landed (relative to
    services/ingest, every worker's cwd in dev — see pythonRunner.ts), since
    real researcher files already sit there; packaged mode consolidates
    under the per-user data dir instead, where there's no pre-existing
    location to conflict with. An absolute path is never touched."""
    p = Path(configured)
    if p.is_absolute():
        return p
    return (INGEST_SOURCE_DIR / p) if MODE == "dev" else (DATA_DIR / p.name)


def load(name: str) -> dict:
    with open(CONFIG_DIR / f"{name}.yaml", "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def focus() -> dict:      return load("focus")
def sources() -> dict:    return load("sources")
def funding() -> dict:    return load("funding")
def models() -> dict:     return load("models")


def task_model(task: str) -> dict:
    m = models()
    return m["tasks"].get(task, {"model": m["default"], "max_tokens": 2000, "temperature": 0})


def env(key: str, required: bool = False) -> str | None:
    val = os.environ.get(key)
    if required and not val:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return val
