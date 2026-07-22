/** Sprint 6 Pass 1 (A0/A4) — the per-user data directory. Dev mode keeps
 * writing into the repo tree exactly as before (data/, config/) so
 * `pnpm dev` and live YAML editing are untouched; packaged mode moves
 * everything mutable to the OS-standard per-user app-data directory, and
 * the install directory is never written to at runtime. */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { mode, appBaseDir } from "./runtime.js";

function platformAppDataRoot(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Scriptorium");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Scriptorium");
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"), "Scriptorium");
}

/** SCRIPTORIUM_DATA_DIR overrides in either mode (matches the existing
 * SCRIPTORIUM_DB_PATH override precedent in db/client.ts). Unset: dev uses
 * the repo's own data/ folder (unchanged from every prior sprint); packaged
 * uses the OS per-user app-data directory. */
export const dataDir = process.env.SCRIPTORIUM_DATA_DIR
  ?? (mode === "dev" ? path.join(appBaseDir, "data") : platformAppDataRoot());

/** Config precedence (Pass 1 spec): dev keeps reading/writing the live repo
 * config/*.yaml (the /focus skill and dashboard both depend on this staying
 * true). Packaged mode seeds copies into the data dir on first run — see
 * ensureDataDirs() — and every read/write after that touches only the seed,
 * never the install directory. */
export const configDir = process.env.SCRIPTORIUM_CONFIG_DIR
  ?? (mode === "dev" ? path.join(appBaseDir, "config") : path.join(dataDir, "config"));

export const paths = {
  // SCRIPTORIUM_DB_PATH predates SCRIPTORIUM_DATA_DIR (db/client.ts's
  // original override) and stays honored on its own — more granular than
  // redirecting the whole data dir when only the DB needs to move.
  db: process.env.SCRIPTORIUM_DB_PATH ?? path.join(dataDir, "scriptorium.db"),
  logs: path.join(dataDir, "logs"),
  uploads: path.join(dataDir, "uploads", "funding"),
  knowledge: path.join(dataDir, "knowledge"),
  // Pre-existing dev-mode inconsistency (Sprint 2 Pass 2.1 put this under
  // services/ingest/ instead of data/, unlike every other mutable path here)
  // deliberately preserved rather than "fixed": real uploaded PDFs already
  // sit at that exact path today, and A0 says packaging adapts to the repo,
  // not the reverse — silently relocating a researcher's own files is not
  // this pass's call to make. New in packaged mode only, where there's no
  // pre-existing location to conflict with.
  libraryInbox: mode === "dev"
    ? path.join(appBaseDir, "services", "ingest", "library-inbox")
    : path.join(dataDir, "library-inbox"),
  extensions: {
    root: path.join(dataDir, "extensions"),
    agents: path.join(dataDir, "extensions", "agents"),
    prompts: path.join(dataDir, "extensions", "prompts"),
    sources: path.join(dataDir, "extensions", "sources"),
  },
};

/** Packaged mode only: where the installer bundles the default
 * config/*.yaml (Pass 5 populates this at build time, next to the
 * sidecars — same relative-to-appBaseDir convention pythonRunner.ts uses
 * for the ingest sidecar). Dev mode never calls seedConfigIfMissing():
 * configDir already IS the live repo config/ folder, nothing to seed. */
const PACKAGED_CONFIG_DEFAULTS_DIR = path.join(appBaseDir, "config-defaults");

/** Copies each default *.yaml into the user's config dir the first time
 * it's missing there — never overwrites a file the researcher (or a prior
 * run) already created, so a Settings-panel edit is never silently
 * reverted by an update. */
function seedConfigIfMissing(): void {
  if (mode !== "packaged" || !fs.existsSync(PACKAGED_CONFIG_DEFAULTS_DIR)) return; // Pass 5 not built yet
  for (const name of fs.readdirSync(PACKAGED_CONFIG_DEFAULTS_DIR)) {
    if (!name.endsWith(".yaml")) continue;
    const dest = path.join(configDir, name);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(PACKAGED_CONFIG_DEFAULTS_DIR, name), dest);
  }
}

const EXTENSIONS_README = `# Scriptorium extensions

Files dropped in these folders load alongside Scriptorium's packaged
defaults on the next app start — no reinstall needed. Updates never modify
this folder.

- agents/   additional agent persona definitions
- prompts/  additional/overriding prompt templates
- sources/  additional crawl source registry entries

See docs/ (in the repository, or the app's Help tab) for the file format.
`;

/** Idempotent; safe to call on every startup. Packaged-mode-only concerns
 * (extensions folders, logs) are created in dev too, so the two modes
 * exercise the same directory-creation code path rather than diverging. */
export function ensureDataDirs(): void {
  for (const p of [
    dataDir, configDir, paths.logs, paths.uploads, paths.knowledge,
    paths.libraryInbox, paths.extensions.root, paths.extensions.agents,
    paths.extensions.prompts, paths.extensions.sources,
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }
  seedConfigIfMissing();
  const readmePath = path.join(paths.extensions.root, "README.md");
  if (!fs.existsSync(readmePath)) fs.writeFileSync(readmePath, EXTENSIONS_README);
}
