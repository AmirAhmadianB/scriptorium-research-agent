/** Sprint 2 Pass 3 (comment 8) — the daily crawl schedule. "The cheapest
 * correct place to add one" (per the Pass 0 recon question): this API
 * server is already the one long-running process in the deployment (dev:
 * tsx watch; production: whatever process manager runs `node
 * dist/server.js`), so a plain `setInterval` checking "is it the
 * configured time, and haven't we already run today" is enough — no
 * node-cron dependency, no OS-level timer, no second process to keep
 * alive. Runs BOTH crawl paths (funding + literature) so "all tabs'
 * sources" are covered by one daily firing, reusing the exact same Python
 * workers a manual per-source/per-tab "crawl now" already uses
 * (routes/crawl-sources.ts) — no separate scheduled-vs-manual code path. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { db } from "./db/client.js";
import * as s from "./db/schema.js";
import { configDir } from "./dataDir.js";
import { runIngestModule } from "./pythonRunner.js";

const SOURCES_YAML = path.join(configDir, "sources.yaml");

const CRAWL_MODULES = ["scriptorium_ingest.funding.crawl_funding", "scriptorium_ingest.crawl.crawl_literature"];

function getDailyCrawlTimeUTC(): string {
  try {
    const cfg = parse(readFileSync(SOURCES_YAML, "utf8"));
    return cfg?.crawl?.daily_crawl_time_utc ?? "03:00";
  } catch {
    return "03:00"; // sensible default if the config key is ever missing
  }
}

/** Exported so both the interval check and a forced manual run
 * (POST /api/scheduler/run-now, for the Gate's "forced run" proof) share
 * one implementation. Every module runs even if an earlier one throws —
 * "a failing source degrades to a logged error, never blocks the
 * schedule" applies at the crawl-module level too, not just per-URL. */
export async function runDailyCrawl(trigger: "scheduled" | "forced"): Promise<Record<string, any>> {
  const results: Record<string, any> = {};
  for (const mod of CRAWL_MODULES) {
    try {
      results[mod] = await runIngestModule([mod], { timeoutMs: 20 * 60_000 });
    } catch (e: any) {
      results[mod] = { error: e?.message ?? String(e) };
    }
  }
  await db.insert(s.agentRuns).values({ kind: "scheduled_crawl", summary: { trigger, results } });
  return results;
}

let lastRunDate: string | null = null;

export function startScheduler(): void {
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const today = now.toISOString().slice(0, 10);
    if (hhmm === getDailyCrawlTimeUTC() && lastRunDate !== today) {
      lastRunDate = today;
      runDailyCrawl("scheduled").catch(() => { /* already logs per-module errors; nothing else to do here */ });
    }
  }, 60_000);
}
