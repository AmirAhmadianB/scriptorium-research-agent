# Sprint 6 Packaging Brief — Pass 3: Sidecar Binaries

## Built

**Ingest sidecar** (`services/ingest/sidecar_main.py` + PyInstaller `--onedir`
build, `release/pyinstaller-dist/scriptorium-ingest/`): a multi-call
dispatcher entrypoint (`runpy.run_module(argv[1], run_name="__main__")` —
literally what `python -m` does internally) since this service has 14
distinct worker entrypoints, not one script. `pythonRunner.ts`'s
already-built packaged-mode branch (Pass 1) calls it with the exact same
`(module, *args)` shape it already used for `python -m` in dev.
`--collect-all` for fastembed/crawl4ai/pymupdf/tiktoken/anthropic/keyring/
httpx to catch the dynamic-import-heavy dependencies PyInstaller's static
analysis alone would miss. **436 MB** — bigger than Part B's own "150-300
MB installer total" estimate for the *whole* app, driven by crawl4ai's
Playwright dependency and fastembed's ONNX runtime; worth knowing now
rather than at release time.

**API sidecar** (Node's `--experimental-sea-config` + `postject`,
`release/sea-build/scriptorium-api.exe`): esbuild bundles `server.ts` to a
single CJS file (SEA requires a CJS-compatible entry — confirmed live: an
ESM-format bundle fails at the SEA loader with "Cannot use import
statement outside a module" regardless of file extension), the blob is
injected into a copied `node.exe`. 90 MB (mostly the base Node runtime).

## Three real bugs found by testing, not review

Pass 3's own gate ("verify native modules load correctly") only means
something if you actually try to break it. Three did:

1. **Frozen-build path resolution** (`config.py`): `REPO_ROOT =
   Path(__file__).resolve().parents[3]` stops meaning anything once frozen
   — `__file__` resolves inside PyInstaller's internal bundle path, not the
   real source tree. Caught by literally running the built exe without
   `SCRIPTORIUM_CONFIG_DIR` set: it silently computed a nonsense path and
   failed three calls deep with a confusing `FileNotFoundError`. Fixed:
   frozen builds now require `SCRIPTORIUM_CONFIG_DIR`/`SCRIPTORIUM_DATA_DIR`
   explicitly and fail immediately with a clear message if either is
   missing, rather than guessing. The real Node caller always sets both on
   every spawn (Pass 1), so this never fires against the real app — it's a
   defensive fix for exactly the kind of direct/malformed invocation that
   found it.

2. **`@libsql/client`'s CJS build doesn't resolve in this project's exact
   pnpm layout** (`db/client.ts`, `driver.cjs` inside `drizzle-orm/libsql`)
   — verified in a completely normal, non-SEA Node process, not just under
   packaging: a plain `require("@libsql/client")` fails with `Cannot find
   module '@libsql/core/config'`, while the equivalent `import()` resolves
   it correctly every time. A real pnpm/Node CJS-resolver interaction, not
   specific to this pass. Since the SEA blob always executes as CJS
   (confirmed via the ESM-bundle test above), a `require()` was never going
   to work here regardless of packaging — a dynamic `import()` is the one
   path proven to work from CJS-executed code either way. `db/client.ts`
   now constructs its libSQL client via an async `init()` (mirrors the
   `dbReady` pattern from Pass 1), and drizzle-orm's own internal
   `require("@libsql/client")` (third-party code, not ours to fix) is
   redirected via an esbuild `--alias` to a harmless stub — verified it's
   genuinely dead code for this project's usage (`drizzle(client)` is
   always called with an already-constructed client, never the raw
   connection-string overload that stub would need to actually work).

3. **A real startup-ordering race, caught only by literally booting the
   built binary** (`profile/consumers/index.ts`): fixing bug #2 made `db`
   asynchronously initialized instead of synchronously available at import
   time. `consumersPrimed`'s own async chain starts running the instant
   the module is imported — independently of whether `server.ts`'s `main()`
   has awaited `dbReady` yet — and it used to work by accident (the OLD
   synchronous `db` was already valid by the time ANY async code ran).
   First real boot after the fix crashed instantly: `TypeError: Cannot
   read properties of undefined (reading 'select')`. Fixed by having
   `primeAll()` await `dbReady` directly instead of assuming ordering.

## Gate — what's actually proven, live

- **Ingest**: ran real modules through the frozen 436 MB exe with zero
  Python installed system-wide — `analyze.trends` (real keyword-velocity
  data from the live dev DB), `llm.provider_config list` (keyring backend
  resolves correctly frozen), `analyze.embed` (fastembed/ONNX Runtime, the
  heaviest and riskiest dependency — a real 384-dim vector came back).
  `analyze.paper_analyst` got far enough into a real run (real PDF
  fetches, real LLM calls — confirmed via live outbound HTTPS connections)
  to prove PyMuPDF and the full analysis import chain work frozen, before
  I killed it — an unintended side effect of `--limit 0` being falsy in
  Python and silently meaning "no limit" rather than "process nothing"
  (a real API-cost mistake on my part, not a product bug; no lasting harm,
  just some unplanned real analysis calls before I caught it).
- **API**: booted the SEA exe standalone with `SCRIPTORIUM_MODE=packaged`
  and an isolated `SCRIPTORIUM_DATA_DIR`, confirmed `/api/health` and
  `/api/overview` both respond correctly against a *freshly auto-bootstrapped*
  database (proves the schema-bootstrap write path AND a real `SELECT`
  both work through the native libSQL driver from inside the frozen exe —
  not just that the import succeeded).
- **Isolation**: confirmed via Pass 1's same method (temp data dir,
  `SCRIPTORIUM_MODE=packaged`) that nothing leaked into the real repo tree
  during any of this.

## Known gap, flagged not fixed

The API sidecar test used a Windows directory **junction** from
`release/sea-build/node_modules` to the real `apps/api/node_modules`, not
a real standalone deployable copy — `pnpm deploy --legacy` and a plain
`cp -r` of the deployed output both produced an incomplete/subtly-broken
tree specifically for `@libsql/core`'s resolution (the exact same package
that needed the `import()` fix above), and chasing pnpm's exact virtual-
store semantics by hand wasn't worth the time this pass, once the junction
proved the *sidecar mechanism itself* works correctly. **This means Pass 3
proves native-module loading works; it does not yet prove the API sidecar
is deployable as a truly standalone folder with no dependency on the dev
workspace's own `node_modules` still existing on disk.** That's real,
necessary work for Pass 5's actual installer build — flagging it now
rather than letting the junction quietly stand in as "solved."

## Net

Both sidecars run real work with zero installed runtimes (no system Python,
no system Node/npm needed to invoke them) — the core Pass 3 promise. Three
non-obvious bugs were found and fixed by actually executing the built
artifacts rather than reviewing the code, consistent with how every prior
pass in this sprint has been verified. Ready for Pass 4 (Tauri shell),
though Pass 5's node_modules-deployment gap should be resolved before that
work is considered load-bearing rather than a proof of concept.
