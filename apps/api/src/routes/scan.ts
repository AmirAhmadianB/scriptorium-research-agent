/** Triggers the same ingestion pipeline the /scan skill runs in Claude Code
 *  (literature scan, then funding crawl), so a dashboard focus change can be
 *  followed by "refresh now" without opening a terminal. Both Python scripts
 *  already log their own agent_runs row and print a JSON summary as their
 *  last stdout line — this route just relays that back to the caller. */
import type { FastifyInstance } from "fastify";
import { runIngestModuleSync } from "../pythonRunner.js";

export default async function scanRoutes(app: FastifyInstance) {
  app.post("/api/scan", async () => ({
    literature: runIngestModuleSync(["scriptorium_ingest.run_scan"]),
    funding: runIngestModuleSync(["scriptorium_ingest.funding.crawl_funding"]),
  }));
}
