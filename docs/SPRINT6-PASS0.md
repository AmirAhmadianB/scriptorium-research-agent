# Sprint 6 Packaging Brief — Pass 0: Recon

Scope per the brief: inventory every dev-tree assumption before any packaging
code is written. No code changes in this pass.

## 1. Absolute-path / cwd assumptions

**Node (`apps/api/src`)** — 14 files independently compute a path relative to
`process.cwd()`, assuming the process is launched with cwd = `apps/api/`
(true only under `pnpm dev`):
- `INGEST_DIR = path.resolve(process.cwd(), "../../services/ingest")` —
  `server.ts`, `scheduler.ts`, `embed-client.ts`, and 10 files under
  `routes/` (`trends`, `funding-upload`, `scan`, `radar`, `crawl-sources`,
  `corpus-analysis`, `corpus-library`, `research-profile`, `proposal`,
  `draft-editor`).
- `REPO_ROOT = path.resolve(process.cwd(), "../..")` — `config.ts`,
  `scheduler.ts`, `routes/focus.ts` (as `FOCUS_PATH =
  path.resolve(process.cwd(), "../../config/focus.yaml")`).
- `db/client.ts` is the one exception, already resolved relative to its own
  module location (`fileURLToPath(import.meta.url)`) rather than cwd, and
  already honors `process.env.SCRIPTORIUM_DB_PATH` as an override. This is
  the pattern the run-mode seam should generalize to every other file.

**Python (`services/ingest/scriptorium_ingest`)** — `config.py`'s `REPO_ROOT
= Path(__file__).resolve().parents[3]` is the sole source of truth for
`config/*.yaml` location on the Python side; every other file that touches a
repo-relative path imports through it or `db.py`.

**Net finding**: none of this is exotic — it's one pattern (cwd- or
file-relative resolution to a source-tree layout) copy-pasted 14+ times on
the Node side and centralized once on the Python side. Pass 1's run-mode
seam needs to replace the Node-side duplication with a single resolver
module every route imports, and extend `config.py`'s `env()` to read a
`SCRIPTORIUM_DATA_DIR` override the same way `db/client.ts` already does for
the DB path.

## 2. Dev ports / dev-server dependency

- Vite dev server: `localhost:5173`, proxies `/api` → `localhost:8787`
  (`apps/dashboard/vite.config.ts`) — **dev only**.
- Fastify API: `app.listen({ port: 8787, host: "0.0.0.0" })` (`server.ts:247`),
  hardcoded, no env override today.
- **Good news**: a repo-wide search of `apps/dashboard/src` found zero
  hardcoded `localhost`/`http://` URLs or `import.meta.env.VITE_*` base-URL
  reads — every dashboard fetch call uses a bare relative path (`/api/...`).
  This means the production dashboard build (`vite build` → static
  `dist/`) can be served by the Fastify API itself on the same origin with
  **no frontend code changes** — the dev-only Vite proxy is the only thing
  standing in for that today.

## 3. Environment variables read

- `SCRIPTORIUM_DB_PATH` (`db/client.ts`) — already optional, already
  overridable. Model for everything else.
- `VOYAGE_API_KEY` (`analyze/embed.py`) — optional, switches embeddings from
  free local `fastembed` to Voyage AI when set.
- **No `ANTHROPIC_API_KEY` is read anywhere in the codebase.** All LLM calls
  go through `claude_cli.complete()`, which shells out to a locally
  installed `claude` CLI riding the user's Claude subscription. This
  confirms today's app has zero billed-API-key path — the multi-provider
  layer (Part B) is a wholly new capability, not a refactor of an existing
  one.
- `config.py`'s generic `env(key, required=False)` helper is unused by
  anything else in the repo today but is the natural place to add
  `SCRIPTORIUM_DATA_DIR`.

## 4. Config file read/write locations

`config/{focus,sources,funding,models}.yaml` at the repo root are a genuine
shared control plane, read **and written** by both runtimes independently:
- Python: `config.py`'s `load()`/`focus()`/`sources()`/`funding()`/`models()`.
- Node: `config.ts` (reads `funding.yaml`), `scheduler.ts` (reads
  `sources.yaml`), `routes/focus.ts` (reads **and writes** `focus.yaml`,
  the dashboard's Research Focus editor persists here).

Both sides compute the same `config/` directory via two independently
hardcoded relative-path formulas. In packaged mode there must be exactly one
answer to "where is the data dir," and both the Node process and the Python
sidecar it spawns must agree on it — the natural mechanism is the Node
process resolving it once (via the run-mode seam) and passing it to the
Python sidecar as an env var (`SCRIPTORIUM_DATA_DIR`) on every spawn, which
`config.py`'s existing `env()` helper can then read.

## 5. Shell-outs

- **`claude` CLI** (`claude_cli.py`'s `_claude_command()`): resolved via
  `shutil.which("claude")` — i.e. **requires Node/npm and the Claude Code
  CLI to be globally installed and already authenticated on the end user's
  machine**, entirely outside this app's control. This is the single
  biggest real distribution blocker in the current architecture, and is
  exactly what Part B's provider layer (Anthropic SDK default, generic
  OpenAI-compatible provider, key stored in the OS credential store) exists
  to remove for packaged installs — the CLI-subscription path should remain
  available as a "bring your own Claude Code" option for developers/power
  users, not be deleted.
- **13 duplicated Node→Python spawns**, each independently computing
  `PYTHON = path.join(INGEST_DIR, ".venv/Scripts/python.exe" |
  ".venv/bin/python")` and calling `spawn`/`execFile`/`execFileSync` with
  `python -m scriptorium_ingest.<module>` and `cwd: INGEST_DIR`. None of
  this works once `services/ingest` isn't a sibling source folder with a
  `.venv` inside it — every call site needs to route through the same
  run-mode seam and resolve to either a dev venv path or the packaged
  PyInstaller sidecar executable.
- **`pytesseract`** (OCR fallback for scanned PDFs) needs the **Tesseract
  OCR binary** on PATH — an external, non-pip-installable native
  dependency. Not bundled by PyInstaller automatically; needs either a
  bundled Tesseract binary per platform or an explicit "OCR fallback
  unavailable" degraded mode in the packaged build.
- **`crawl4ai`** (literature + funding crawling, `crawl_literature.py`,
  `crawl_funding.py`) depends on **Playwright**, which in turn needs a
  downloaded Chromium browser (`playwright install chromium`, ~300MB,
  platform-specific binary) — not a pip package, not something PyInstaller
  bundles for free. This is the single largest and most delicate packaging
  item on the Python side and needs explicit sizing/UX treatment (bundle
  Chromium in the installer vs. download-on-first-run with a progress UI).

## 6. Runtime / native-module surface

- **Node**: `package.json` declares no `engines` field today (worth pinning
  for the SEA build). `@libsql/client` already ships prebuilt native
  binaries per-platform (called out in `db/client.ts`'s own comment as the
  reason it was chosen over `better-sqlite3` — no node-gyp/Visual Studio
  toolchain needed). This is the only native Node dependency and it's
  already packaging-friendly.
- **Python** (`requirements.txt`): `pymupdf` (prebuilt wheels, fine),
  `fastembed` (bundles ONNX Runtime — the single largest pure-pip
  dependency, expect ~150–300MB in a PyInstaller build), `pandas`/`scipy`
  (prebuilt wheels, fine, added Sprint 3 for the entity-graph node store —
  not the main corpus store), `dill`, `python-docx`, `reportlab` (all pure
  Python), `crawl4ai` + Playwright/Chromium and `pytesseract` + Tesseract
  as called out above (both external-binary dependencies, not solved by
  PyInstaller alone).

## 7. Frontend runtime when served from the API instead of Vite dev

Confirmed clean (see §2): zero base-URL assumptions in `apps/dashboard/src`.
Packaged mode = `vite build` once at release time, output `dist/` bundled
into the installer, Fastify adds one static-file-serving route
(`@fastify/static` or equivalent) for it. No dashboard code changes needed.

## 8. Proposed port strategy

- **Packaged**: single port serving both the API and the static dashboard
  build (default 8787, or the brief's own preferred default if Part A
  specifies one) — the dev-only Vite/API split collapses to one process,
  one port.
- **Dev**: unchanged — keep 5173 (Vite, hot reload) proxying to 8787 (API).
  No reason to disturb the inner-loop dev experience.

## 9. Proposed user-data-directory layout

Windows: `%APPDATA%\Scriptorium\` (macOS/Linux equivalents via Tauri's
path APIs, deferred per Part A's platform-priority decision):
```
data/scriptorium.db          (already env-overridable — SCRIPTORIUM_DB_PATH)
config/{focus,sources,funding,models}.yaml   (seeded from packaged defaults on first run, then user-owned)
extensions/{agents,prompts,sources}/          (additive to packaged defaults, per brief)
uploads/funding/                              (routes/funding-upload.ts's saved source files)
knowledge/                                    (entity-graph pickles, knowledge/store.py)
library-inbox/<professorId>/                  (corpus-library.ts's manual-add inbox)
logs/
```
All of these already exist as concepts in the current codebase at
hardcoded repo-relative locations (`data/`, `config/`,
`services/ingest/library-inbox/`) — the migration is redirecting each one
through the run-mode seam's single data-dir resolver, not inventing new
storage.

## Net assessment

Nothing found here is architecturally surprising — it's the expected shape
for a dev-only app (cwd-relative paths, a venv-relative Python spawn, a
dev-proxy split) that was never asked to run standalone before. The two
genuinely hard, non-refactor items are both external native dependencies on
the Python side: **Playwright/Chromium** (crawl4ai) and **Tesseract**
(OCR fallback) — both need an explicit bundling or graceful-degradation
decision, not just a path fix. Everything else in this list is exactly what
Part C, Pass 1 ("run-mode seam") is scoped to fix.

No code written in this pass.
