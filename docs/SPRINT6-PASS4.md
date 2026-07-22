# Sprint 6 Packaging Brief — Pass 4: Tauri Shell

## Environment blocker (real, not routine)

Tauri 2 requires a Rust toolchain and, on Windows, MSVC Build Tools —
neither was installed. Installing them turned into a multi-hour detour:
Rust installed cleanly via `rustup`, but the C++ workload for MSVC Build
Tools silently failed to materialize across four automated attempts
(winget ×2, direct `setup.exe` ×2) — each one reported success while the
actual compiler never appeared. Root-caused (as far as it could be from the
command line) to `VSInstallerElevationService` failing to start even with
confirmed Administrator rights, with no detail in the Windows event log.
Disk space on C: (as low as 6.5 GB free at one point) was a contributing
suspect — redirecting the package cache to E: didn't fix it either. What
actually worked: the user opened the Visual Studio Installer GUI directly
(it turned out to be minimized, not closed, which is why it looked absent)
and drove the install interactively. Verified after: `cl.exe` present and
runs, and a real `cargo new && cargo build` produced a working binary
before any Tauri-specific work started.

## Built

**`apps/desktop/`** — a new Tauri 2 project (`pnpm tauri init`), wrapping
the existing dashboard (`frontendDist: ../../dashboard/dist`, `devUrl:
http://localhost:5173`) rather than a new frontend.

**`src-tauri/src/lib.rs`** — the shell itself:
- Spawns the `scriptorium-api` sidecar via `tauri-plugin-shell`'s
  `Command::sidecar()` with `SCRIPTORIUM_MODE=packaged`, pipes its
  stdout/stderr through Tauri's own log target (the researcher's only
  window into API-side errors once there's no terminal — verified this
  works by deliberately triggering a real `EADDRINUSE` and watching the
  exact Node error text come through).
- Polls `/api/health` (90s budget — schema bootstrap on a truly fresh
  install can be slow) before showing the main window, which starts
  `visible: false` in `tauri.conf.json` for exactly this reason.
- Tray icon (Open / Quit) whose tooltip polls `/api/radar/status` every 10s
  and shows "crawling…" vs "idle" — a real signal, not decorative.
- `tauri-plugin-single-instance`, registered first per Tauri's own
  requirement.
- Sidecar killed explicitly on both the tray Quit item and
  `WindowEvent::Destroyed` (normal window close) — verified this matters:
  an early version relied on OS process-tree cleanup alone and left an
  orphaned sidecar holding port 8787 after the shell process was gone.

**`apps/api/src/routes/setup.ts` + `FirstRunWizard.tsx`** — a 5-step wizard
(EULA, provider connection reusing the new `ProviderSetupForm.tsx` —
extracted out of `SettingsTab.tsx` so both consumers share one add/
validate/save path instead of two, data-directory confirmation, corpus
folder deferred to the existing Corpus tab rather than duplicated, A8
privacy summary) gated on a one-time marker file
(`GET/POST /api/setup/status|complete`). `App.tsx` shows the wizard instead
of the dashboard until the marker exists.

**`apps/api/src/logging.ts` + `routes/debug-bundle.ts`** — a Pass 1 spec
item that was never actually built until the Tauri shell's log-viewer/
support story needed it: rotating daily log files (plain synchronous
`pino.multistream`, deliberately not pino's `transport` option — that
spins up a worker thread that hit the exact same "no real on-disk anchor"
resolution problem Pass 3 spent a long time on for `@libsql/client`,
confirmed live when it hung the dev server with zero error output) plus a
downloadable debug bundle (recent logs + redacted config, no real .zip
dependency needed for a support text file).

**`apps/api/src/server.ts`** — also finally built the Pass 1 spec item that
was flagged-but-not-built at the time: packaged mode now serves the
dashboard's static Vite build itself via `@fastify/static`, collapsing to
one port. Verified live: `/api/health`, `/`, and a real asset file all
correctly served from one process on one port.

## Gate — what's proven live, not asserted

Built and ran the actual `app.exe` (not just `cargo check`) with the real
Pass 3 sidecar binaries in place:
- Real separate `scriptorium-api.exe` child process spawned, became
  healthy, served both the API and the static dashboard build.
- Real webview window shown only after the health check passed.
- Tray tooltip's `/api/radar/status` poll fired on schedule.
- **Normal quit is clean**: closing the window (simulated via a genuine
  `WM_CLOSE`, not a force-kill) killed the sidecar and freed port 8787 —
  verified by checking the process list and port binding directly, not by
  trusting the log line.
- **Single-instance lock works**: launching a second instance while the
  first was running did not spawn a second sidecar or a second window —
  confirmed exactly one `app` process and exactly one `scriptorium-api`
  process existed throughout.
- **First-run wizard verified live via Playwright**: all 5 steps, the
  skip-provider path, the data-dir display, the privacy text, completion
  persisting across a real page reload (proving the marker file write
  actually works, not just that the UI renders).

## Known gap, flagged not fixed

**Force-kill / crash resilience.** Killing `app.exe` via `Stop-Process
-Force` (simulating Task Manager or a crash, not a normal quit) leaves the
sidecar orphaned — confirmed directly, then cleaned up manually. This is
expected: an externally forced kill gives no process any chance to run
cleanup code, on any platform. The robust fix is a Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` tying the sidecar's lifetime to the
parent at the OS level, which Tauri's `CommandChild` does not appear to set
up automatically. Not fixed this pass — noted as real hardening work,
not asserted as already covered by the "quitting stops sidecars cleanly"
gate (which is true for every *normal* quit path, just not an external
force-kill).

**Ingest sidecar packaging shape.** Tauri's `externalBin` mechanism expects
one file per sidecar; the Pass 3 ingest build is a PyInstaller `--onedir`
output (one exe + a large `_internal/` folder), which doesn't fit that
model directly. For this pass's testing, only the API sidecar (the one
Tauri itself spawns) was verified working end-to-end; the ingest sidecar's
correct placement relative to the API sidecar at packaged runtime (matching
`pythonRunner.ts`'s `appBaseDir/ingest/scriptorium-ingest.exe` expectation)
is real, unverified work for Pass 5's actual installer/bundling script.

**Sidecar dependency deployment**, carried over from Pass 3's own flagged
gap: the API sidecar's `node_modules` was junctioned to the real dev
`node_modules` for this pass's live tests, not a genuinely standalone
deployable copy. Same open item as before, now also blocking a true
`tauri build` (vs. the `cargo build` + manual file placement used here) —
squarely Pass 5 scope.

## Net

The hard, novel-territory part (Rust/Tauri toolchain, real sidecar
lifecycle, real health-gated window, real single-instance lock, real clean
shutdown) is proven live, not just written. What's left is packaging
plumbing (Pass 5's job): assembling the exact directory layout a real
installer needs, which is a different, more mechanical problem than "does
the shell actually work."
