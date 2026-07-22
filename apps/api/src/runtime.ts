/** Sprint 6 Pass 1 (A0) — the one module that answers "dev or packaged?".
 * Every behavior that differs between modes (data directory, config
 * location, how the ingest workers get invoked) resolves through this
 * seam or through ./dataDir.ts and ./pythonRunner.ts, which read it. No
 * other file may branch on mode or recompute a repo-relative path itself —
 * that duplication (14 independent `path.resolve(process.cwd(), ...)`
 * call sites) is exactly what Sprint 6 Pass 0's recon flagged. */
import path from "node:path";
import fs from "node:fs";
import { moduleDir } from "./moduleDir.js";

export type RunMode = "dev" | "packaged";

const THIS_DIR = moduleDir(import.meta.url);
// This file lives at apps/api/src/runtime.ts (dev, tsx) or apps/api/dist/runtime.js
// (built) — either way the repo root is three levels up. Resolved from the
// module's own location, never from process.cwd(), so it's correct
// regardless of the directory the process was launched from.
const REPO_ROOT_CANDIDATE = path.resolve(THIS_DIR, "../../..");

/** Dev-tree signature: a sibling services/ingest source folder next to
 * apps/ only exists in the source repository — a packaged build ships
 * neither that folder nor its .venv, only a sidecar binary. */
function looksLikeRepoTree(root: string): boolean {
  return fs.existsSync(path.join(root, "services", "ingest", "scriptorium_ingest"))
    && fs.existsSync(path.join(root, "apps", "dashboard"));
}

function detectMode(): RunMode {
  const override = process.env.SCRIPTORIUM_MODE;
  if (override === "dev" || override === "packaged") return override;
  if (override) {
    throw new Error(`SCRIPTORIUM_MODE must be "dev" or "packaged", got ${JSON.stringify(override)}`);
  }
  return looksLikeRepoTree(REPO_ROOT_CANDIDATE) ? "dev" : "packaged";
}

export const mode: RunMode = detectMode();
export const isDev = mode === "dev";
export const isPackaged = mode === "packaged";

/** Dev: the repo root (source of truth for config/, services/ingest/, etc).
 * Packaged: the directory the running executable lives in (sidecars sit
 * next to it, per Part B's packaging table) — same variable, because both
 * answer "where do I look for things that ship with the app," just with a
 * different tree shape underneath. */
export const appBaseDir = isDev ? REPO_ROOT_CANDIDATE : path.dirname(process.execPath);

/** Packaged mode only: the dashboard's static Vite production build,
 * shipped as a sibling folder next to the API sidecar — same
 * next-to-the-exe convention as the ingest sidecar (pythonRunner.ts) and
 * config-defaults (dataDir.ts). Dev mode never serves this — Vite's own
 * dev server (`pnpm dev`, port 5173) owns the frontend there, proxying
 * `/api` to this API on 8787, unchanged since before this pass. */
export const dashboardStaticDir = path.join(appBaseDir, "dashboard");
