# Sprint 6 Packaging Brief — Pass 1: Production Hardening

## Built

**The run-mode seam (A0)** — `apps/api/src/runtime.ts`: one auto-detected
`mode: "dev" | "packaged"`, overridable via `SCRIPTORIUM_MODE`. Detection
signature: a sibling `services/ingest/scriptorium_ingest` + `apps/dashboard`
next to this module's own location (never `process.cwd()`) means dev tree;
their absence means packaged. Mirrored on the Python side in `config.py`'s
`MODE`, read from the `SCRIPTORIUM_MODE` env var the Node API now sets on
every worker spawn.

**Data directory module** — `apps/api/src/dataDir.ts`: `dataDir`/`configDir`
resolve to the repo's own `data/`/`config/` in dev (byte-identical to every
prior sprint's paths — `pnpm dev` and live YAML editing are unchanged) and
to the OS per-user app-data directory in packaged mode
(`%APPDATA%\Scriptorium` on Windows). `SCRIPTORIUM_DATA_DIR` /
`SCRIPTORIUM_CONFIG_DIR` / `SCRIPTORIUM_DB_PATH` all override explicitly.
`ensureDataDirs()` creates the extensions folders (`agents/`, `prompts/`,
`sources/`) and seeds a README; `seedConfigIfMissing()` copies bundled
config defaults into a fresh packaged install without ever overwriting a
researcher's own edits. Mirrored on the Python side as `config.py`'s
`DATA_DIR`/`CONFIG_DIR` and a shared `resolve_data_relative_path()` for the
one config-driven relative path (the pdf-folder library inbox) that isn't
already anchored to `data/`.

**Centralized Python invocation** — `apps/api/src/pythonRunner.ts` replaces
14 independently duplicated `PYTHON = path.join(INGEST_DIR, ".venv/...")`
constants and their own ad hoc spawn/execFile wrappers across every route
file (Pass 0's top recon finding). One resolver (`runIngestModule[Sync|Stdin]`)
now decides dev-venv vs. the future Pass 3 sidecar binary; every call site
just passes module args and gets the same shape back regardless of mode.
Two inline `python -c "<source>"` call sites (crawl-source test-fetch,
corpus resync) — which cannot survive into a packaged PyInstaller sidecar,
since there is no interpreter to hand arbitrary source to at runtime — were
converted into proper CLI entrypoints (`politeness.py --test-fetch`,
`corpus_ingest.py --resync`).

**Schema bootstrap** — `apps/api/src/db/bootstrap.sql` (the live schema,
captured once) + `db/client.ts`'s `ensureSchema()`, which applies it only
when the `professors` table is missing. This project's migrations have
always been hand-applied raw SQL with no drizzle-kit migrate step, so a
fresh per-user data directory previously had no path to a working schema at
all — confirmed by the first packaged-mode simulation crashing with
`no such table: professors`. This was outside Pass 0's original checklist
but is squarely "first run creates and migrates the directory" per the
brief's own Pass 1 spec, so it's fixed here rather than deferred.

**Port override** — `SCRIPTORIUM_PORT` (defaults to 8787, unchanged). Not
the real packaged single-port strategy (that's a Pass 4 Tauri-shell
decision per Pass 0's own recon), but a small, safe unblock that also let
this pass's own Gate run two isolated instances side by side.

## Gate

- **Dev mode unchanged**: `pnpm dev`'s live server still resolves the real
  `config/focus.yaml`, the real `data/scriptorium.db`, and the real
  `services/ingest/.venv` exactly as before — verified live (`/api/health`,
  `/api/focus`, `/api/trends` all hit and correct) and via the full test
  suite (28/28 TS, 42/42 Python, no regressions from the refactor).
- **Simulated clean-machine boot**: a second instance launched with
  `SCRIPTORIUM_MODE=packaged`, a throwaway `SCRIPTORIUM_DATA_DIR`, and
  `SCRIPTORIUM_PORT=8788` first failed honestly (`no such table:
  professors`) — proof the mode/data-dir override was real, not a no-op —
  then, after the bootstrap fix, started clean, self-seeded a complete
  isolated directory (`config/`, `extensions/{agents,prompts,sources}/`,
  `logs/`, `knowledge/`, `library-inbox/`, `uploads/`, `scriptorium.db`),
  and served `/api/health`. Confirmed nothing leaked into the real repo's
  `data/` or `config/` during the run.
- **Not yet provable**: the brief's full Pass 1 Gate also asks for "a focus
  edit, a corpus query, and a crawl" from the clean-machine instance, and
  "loads a test persona dropped into the extensions folder." The former
  needs a working provider layer for any LLM-touching path (Pass 2); the
  extensions loader currently only creates the folder + README — actually
  loading a dropped file requires extracting today's inline Python prompt
  constants (`proposal_orchestrator.py`, `corpus_ingest.py`,
  `paper_analyst.py`) into a loadable file format, which doesn't exist yet
  anywhere in this codebase. Flagging this as a real gap between the
  brief's assumption and the current code, same as Sprint 5's document-
  export gap was flagged rather than silently worked around — proposing it
  as an explicit item for Pass 2 or its own follow-up, not assumed done.

## Net

Every one of Pass 0's 14 duplicated path assumptions is gone; the seam is
real (proven by making it fail correctly, then fixing what it found) rather
than asserted. Ready for Pass 2 (multi-LLM provider layer).
