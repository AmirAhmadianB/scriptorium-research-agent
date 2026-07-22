/** Test DB bootstrap — runs BEFORE any test file (and therefore before
 * db/client.js is first imported) so SCRIPTORIUM_DB_PATH points at a
 * throwaway temp file, never the real data/scriptorium.db. DDL here
 * mirrors db/schema.ts for just the tables the profile layer touches;
 * keep it in sync if that schema changes. */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";

const dir = mkdtempSync(path.join(os.tmpdir(), "scriptorium-test-"));
const dbPath = path.join(dir, "test.db");
process.env.SCRIPTORIUM_DB_PATH = dbPath;

const client = createClient({ url: `file:${dbPath.replace(/\\/g, "/")}` });

const ddl = [
  `CREATE TABLE professors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    orcid TEXT,
    focus_override TEXT
  )`,
  `CREATE TABLE research_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id TEXT NOT NULL REFERENCES professors(id),
    focus_synthesis TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER
  )`,
  `CREATE UNIQUE INDEX research_profiles_professor_idx ON research_profiles(professor_id)`,
  `CREATE TABLE research_profile_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL REFERENCES research_profiles(id),
    value TEXT NOT NULL,
    provenance TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE UNIQUE INDEX research_profile_keywords_unique ON research_profile_keywords(profile_id, value)`,
  `CREATE TABLE agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    model TEXT,
    summary TEXT,
    started_at INTEGER
  )`,
];

for (const stmt of ddl) {
  await client.execute(stmt);
}
client.close();
