/** Sprint 6 Pass 4 — first-run wizard state. A single marker file in the
 * data dir (not a DB row: this needs to be readable before we'd even want
 * to guarantee the DB schema exists, and it's genuinely just one boolean).
 * Packaged mode's fresh install never has this file; dev mode's existing
 * data dir gets it seeded once so ongoing dev work is never interrupted by
 * a wizard screen. */
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { mode } from "../runtime.js";
import { dataDir } from "../dataDir.js";

const MARKER_PATH = path.join(dataDir, ".setup-complete");

export default async function setupRoutes(app: FastifyInstance) {
  app.get("/api/setup/status", async () => ({
    completed: fs.existsSync(MARKER_PATH),
    dataDir,
    mode,
  }));

  app.post("/api/setup/complete", async () => {
    fs.writeFileSync(MARKER_PATH, new Date().toISOString());
    return { completed: true };
  });
}
