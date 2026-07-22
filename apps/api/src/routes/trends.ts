/** Pass 1.5g — "visualizations" consumer. Keyword-velocity data has existed
 * since the /trends workflow (Pass 1.5e) but was never rendered as a chart
 * anywhere in the dashboard. This route reuses that same computation (no
 * parallel implementation) so the chart and the /trends brief can never
 * drift apart, and it already reads the current Research Focus profile
 * live (fixed in Pass 1.5e) — so the chart is field-adaptive for free. */
import type { FastifyInstance } from "fastify";
import { runIngestModuleSync } from "../pythonRunner.js";

export default async function trendsRoutes(app: FastifyInstance) {
  app.get("/api/trends", async (req) => {
    const { window } = req.query as { window?: string };
    const win = window && /^\d+$/.test(window) ? window : "4";
    const result = runIngestModuleSync(
      ["scriptorium_ingest.analyze.trends", "--window", win], { timeoutMs: 30_000 },
    ) as { error?: string };
    return result.error ? { keyword_velocity: {}, error: result.error } : result;
  });
}
