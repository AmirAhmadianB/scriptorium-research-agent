/** Sprint 6 Pass 1 spec item ("structured logging to rotating files in the
 * data dir; a debug bundle export... for support"), actually built in
 * Pass 4 once the Tauri shell's in-app log viewer needed real files to
 * read. One file per calendar day (`scriptorium-YYYY-MM-DD.log`) under
 * paths.logs — "rotation" by date boundary, not size; simple enough to not
 * need pino-roll or another dependency for a support-utility feature.
 * Files older than RETENTION_DAYS are pruned on every startup. */
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { paths } from "./dataDir.js";

const RETENTION_DAYS = 14;

function todayLogPath(): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return path.join(paths.logs, `scriptorium-${stamp}.log`);
}

function pruneOldLogs(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 864e5;
  let entries: string[];
  try {
    entries = fs.readdirSync(paths.logs);
  } catch {
    return; // paths.logs doesn't exist yet — ensureDataDirs() runs before this either way
  }
  for (const name of entries) {
    if (!/^scriptorium-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = path.join(paths.logs, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* another process may have already removed it; not worth failing startup over */ }
  }
}

/** Fastify's `logger` constructor option — pino writes structured JSON to
 * BOTH stdout (dev console visibility, unchanged from before this pass)
 * and today's rotating file. Deliberately NOT pino's `transport` option:
 * that spins up a worker thread that loads its target module (`pino/file`)
 * via normal Node module resolution from a real file location — the exact
 * class of problem Pass 3 spent a long time on for @libsql/client, and
 * confirmed live here too (the dev server hung/died silently on this
 * transport config, no error surfaced at all). A plain synchronous
 * multistream fan-out has no worker thread and no separate module to
 * resolve, so there's nothing for a SEA bundle to break. */
export function buildLogger() {
  pruneOldLogs();
  const fileStream = fs.createWriteStream(todayLogPath(), { flags: "a" });
  return pino({ level: "info" }, pino.multistream([
    { stream: process.stdout },
    { stream: fileStream },
  ]));
}

/** Debug bundle (routes/debug-bundle.ts): the last N lines across today's
 * and yesterday's log files — recent history without shipping the
 * researcher's entire log retention window in one download. */
export function recentLogLines(maxLines = 2000): string {
  const today = new Date();
  const yesterday = new Date(today.getTime() - 864e5);
  const candidates = [yesterday, today].map(
    d => path.join(paths.logs, `scriptorium-${d.toISOString().slice(0, 10)}.log`),
  );
  const lines: string[] = [];
  for (const file of candidates) {
    try {
      lines.push(...fs.readFileSync(file, "utf-8").split("\n"));
    } catch { /* file may not exist yet (e.g. app installed today, no "yesterday" log) */ }
  }
  return lines.slice(-maxLines).join("\n");
}
