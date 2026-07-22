import path from "node:path";
import fs from "node:fs";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { paths } from "../dataDir.js";
import { moduleDir } from "../moduleDir.js";

// Sprint 6 Pass 1 (A0/A4): paths.db already honors SCRIPTORIUM_DATA_DIR /
// SCRIPTORIUM_DB_PATH and resolves to today's data/scriptorium.db in dev —
// same effective path as before this pass, now through the shared seam.
const DB_PATH = paths.db;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// Sprint 6 Pass 1: "first run creates and migrates the directory" (A0/Pass
// 1 spec) — a fresh per-user data dir has no DB file at all, and this
// project's migrations have always been hand-applied raw SQL (never
// drizzle-kit migrate), so there is no existing auto-bootstrap to reuse.
// bootstrap.sql is the current live schema, captured once; applied only
// when `professors` (the earliest table, Change 1) doesn't exist yet, so a
// real dev DB with real data is never touched by this on every restart.
async function ensureSchema(client: Client): Promise<void> {
  const check = await client.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='professors'");
  if (check.rows.length > 0) return;
  // Dev (tsx, real ESM): moduleDir() resolves to this file's own directory
  // (apps/api/src/db/), where bootstrap.sql already lives. Packaged (SEA,
  // esbuild-bundled to one CJS file): moduleDir() resolves to wherever the
  // bundle itself sits, since bundling collapses every source file into one
  // shared __dirname — the Pass 3 build step copies bootstrap.sql to sit
  // next to the bundle for exactly this reason, not alongside its original
  // source location.
  const bootstrapPath = path.join(moduleDir(import.meta.url), "bootstrap.sql");
  await client.executeMultiple(fs.readFileSync(bootstrapPath, "utf-8"));
}

// Sprint 6 Pass 3: NOT a plain top-level `import { createClient } from
// "@libsql/client"` — verified directly (in a completely normal, non-SEA
// Node process) that this package's CJS build fails to resolve its own
// internal `require("@libsql/core/config")` through this project's exact
// pnpm layout, while the equivalent ESM `import()` resolves it correctly
// every time (a real pnpm/Node CJS-resolver interaction, not specific to
// packaging). Since the Node single-executable build's blob always
// executes as CJS regardless of source format (verified live: an ESM-
// format bundle fails at the SEA loader with "Cannot use import statement
// outside a module"), a dynamic import() is the one thing that reaches the
// working ESM resolver from inside CJS-executed code either way — dev or
// packaged, this is the one path proven to work in both. The specifier is
// built from a join(), not a plain string literal, so esbuild's bundler
// (which DOES try to statically resolve/inline literal-string dynamic
// imports) leaves this as a genuine runtime import() instead of attempting
// to bundle a package whose CJS build doesn't actually work here.
async function loadLibsqlClient(): Promise<typeof import("@libsql/client")> {
  return import(["@libsql", "client"].join("/"));
}

let db!: ReturnType<typeof drizzle>;

async function init(): Promise<void> {
  const { createClient } = await loadLibsqlClient();
  // libSQL (not better-sqlite3): ships prebuilt native binaries, so no
  // Visual Studio / node-gyp toolchain needed on Windows — the whole point
  // of dropping Docker is to not trade one heavy local dependency for
  // another. Bonus: libSQL has vector search (F32_BLOB, vector_distance_cos)
  // built into the engine, so no separate sqlite-vec extension to load.
  // file: URLs want forward slashes even on Windows (DB_PATH may contain
  // backslashes and a drive letter, e.g. "E:\...\data\scriptorium.db").
  const client = createClient({ url: `file:${DB_PATH.replace(/\\/g, "/")}` });
  await ensureSchema(client);
  db = drizzle(client);
}
// Sprint 6 Pass 3: NOT `await`ed at module scope — top-level await forces
// CJS-incompatible ESM output, which breaks the Node single-executable
// build (SEA requires a CJS-compatible entry). server.ts's main() awaits
// this exported promise before the app starts accepting requests; every
// route handler that touches `db` only ever runs after that (Fastify
// doesn't dispatch requests until listen() succeeds), so `db`'s `let` +
// definite-assignment binding above is always populated by the time
// anything reads it — same guarantee an immediately-available const used
// to give, just resolved one microtask later.
export const dbReady = init();

export { db };
