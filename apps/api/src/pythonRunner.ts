/** Sprint 6 Pass 1 (A0) — the single place that knows how to invoke the
 * ingest/analysis Python workers. Replaces 13 independently duplicated
 * `PYTHON = path.join(INGEST_DIR, ".venv/Scripts/python.exe" | ...)`
 * constants and their own ad hoc spawn/execFile wrappers (Sprint 6 Pass 0's
 * recon). Dev mode invokes the repo's venv exactly as every prior sprint
 * did; packaged mode will invoke the Pass 3 PyInstaller sidecar — same
 * call shape either way, so route handlers don't know or care which mode
 * they're running in. */
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { mode, appBaseDir } from "./runtime.js";
import { dataDir, configDir } from "./dataDir.js";

const INGEST_SOURCE_DIR = path.join(appBaseDir, "services", "ingest");
const DEV_PYTHON = path.join(
  INGEST_SOURCE_DIR, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python",
);
// Pass 3 builds this; until then packaged mode has no sidecar to invoke —
// callers get a clear error at spawn time rather than a silently wrong path.
const PACKAGED_INGEST_EXE = path.join(
  appBaseDir, "ingest", process.platform === "win32" ? "scriptorium-ingest.exe" : "scriptorium-ingest",
);

function invocation(moduleArgs: string[]): { command: string; args: string[]; cwd: string } {
  if (mode === "dev") return { command: DEV_PYTHON, args: ["-m", ...moduleArgs], cwd: INGEST_SOURCE_DIR };
  // The PyInstaller sidecar (Pass 3) dispatches by its first argument
  // instead of Python's `-m module`; same moduleArgs shape either way.
  return { command: PACKAGED_INGEST_EXE, args: moduleArgs, cwd: appBaseDir };
}

function ingestEnv(): NodeJS.ProcessEnv {
  return { ...process.env, SCRIPTORIUM_DATA_DIR: dataDir, SCRIPTORIUM_CONFIG_DIR: configDir, SCRIPTORIUM_MODE: mode };
}

function extractTrailingJson(out: string): unknown {
  const start = out.indexOf("{");
  if (start === -1) return { raw: out.slice(-2000) };
  try { return JSON.parse(out.slice(start)); } catch { return { raw: out.slice(-2000) }; }
}

/** Synchronous, module args only (e.g. ["scriptorium_ingest.run_scan"]) —
 * matches routes/scan.ts's prior runPython(module: string). */
export function runIngestModuleSync(
  moduleArgs: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {},
): unknown {
  const { command, args, cwd } = invocation(moduleArgs);
  let out: string;
  try {
    out = execFileSync(command, args, {
      cwd, env: ingestEnv(), encoding: "utf-8",
      maxBuffer: opts.maxBuffer ?? 1024 * 1024 * 20,
      timeout: opts.timeoutMs ?? 5 * 60_000,
    });
  } catch (e: any) {
    return { error: e?.message ?? String(e), stdout: (e?.stdout ?? "").slice(-2000) };
  }
  return extractTrailingJson(out);
}

/** Async, module args + extra CLI args (e.g. ["scriptorium_ingest.analyze.
 * proposal_orchestrator", "--session-id", id]). Rejects on non-zero exit or
 * timeout; resolves the last JSON object on stdout. */
export function runIngestModule(moduleArgs: string[], opts: { timeoutMs?: number } = {}): Promise<any> {
  const { command, args, cwd } = invocation(moduleArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: ingestEnv() });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("ingest worker timed out")); }, opts.timeoutMs ?? 5 * 60_000);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`ingest worker exited ${code}: ${stderr.slice(-2000)}`)); return; }
      resolve(extractTrailingJson(stdout));
    });
  });
}

/** Async, prompt/payload piped over stdin instead of argv — for calls where
 * the input can be long (funding-extraction text, draft content). Resolves
 * strict JSON (no trailing-object salvage), matching the prior
 * runPythonStdin/runDraftEditorStdin behavior. */
export function runIngestModuleStdin(moduleArgs: string[], stdin: string, timeoutMs = 60_000): Promise<any> {
  const { command, args, cwd } = invocation(moduleArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: ingestEnv() });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("extraction timed out")); }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`extraction exited ${code}: ${stderr.slice(-2000)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`bad JSON from extraction: ${stdout.slice(-500)}`)); }
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}
