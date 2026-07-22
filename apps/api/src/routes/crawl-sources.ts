/** Sprint 2 Pass 3 (comments 7/8) — the crawl-source registry API: list
 * (with real timestamps/status), add (with an immediate test fetch),
 * enable/disable, remove, and manual "crawl now" per source or per
 * purpose/tab. Delegates the actual add-time validation AND the crawl
 * itself to the SAME Python workers/politeness module the scheduler uses
 * (services/ingest/scriptorium_ingest/crawl/*, funding/crawl_funding.py)
 * — no parallel crawler implemented here in TS. */
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { runDailyCrawl } from "../scheduler.js";
import { runIngestModule } from "../pythonRunner.js";

function crawlerModuleFor(purpose: string): string {
  return purpose === "literature" ? "scriptorium_ingest.crawl.crawl_literature" : "scriptorium_ingest.funding.crawl_funding";
}

export default async function crawlSourcesRoutes(app: FastifyInstance) {
  app.get("/api/crawl-sources", async (req) => {
    const { purpose } = req.query as { purpose?: string };
    let query = db.select().from(s.crawlSources).$dynamic();
    if (purpose) query = query.where(eq(s.crawlSources.purpose, purpose));
    return query.orderBy(s.crawlSources.purpose, s.crawlSources.label);
  });

  /** "Validate new URLs on add with an immediate test fetch." */
  app.post("/api/crawl-sources", async (req, reply) => {
    const { url, label, purpose, scope } = (req.body ?? {}) as
      { url?: string; label?: string; purpose?: string; scope?: string };
    if (!url || !label || !purpose) {
      reply.code(400);
      return { error: "url, label, and purpose are required" };
    }
    if (purpose !== "funding" && purpose !== "literature") {
      reply.code(400);
      return { error: "purpose must be 'funding' or 'literature'" };
    }
    let testFetch: { ok: boolean; error: string | null };
    try {
      // Sprint 6 Pass 1: routed through politeness.py's own `--test-fetch`
      // entrypoint instead of `-c <inline source>` — a packaged PyInstaller
      // sidecar has no interpreter to execute arbitrary source through.
      testFetch = await runIngestModule(
        ["scriptorium_ingest.crawl.politeness", "--test-fetch", url], { timeoutMs: 35_000 },
      );
    } catch (e: any) {
      testFetch = { ok: false, error: e?.message ?? String(e) };
    }
    if (!testFetch.ok) {
      reply.code(400);
      return { error: `Test fetch failed: ${testFetch.error ?? "unreachable"}`, testFetch };
    }
    const [inserted] = await db.insert(s.crawlSources).values({ url, label, purpose, scope: scope ?? null })
      .onConflictDoUpdate({ target: s.crawlSources.url, set: { label, purpose, scope: scope ?? null } })
      .returning();

    // Gate requirement: "adding a new URL crawls it and its results
    // appear" — not just registers it for the next scheduled/manual run.
    let crawlResult: any = null;
    try {
      crawlResult = await runIngestModule([crawlerModuleFor(purpose), "--source-id", String(inserted.id)]);
    } catch (e: any) {
      crawlResult = { error: e?.message ?? String(e) };
    }
    const [refreshed] = await db.select().from(s.crawlSources).where(eq(s.crawlSources.id, inserted.id));
    return { ...refreshed, testFetch, crawlResult };
  });

  app.post("/api/crawl-sources/:id/enabled", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== "boolean") {
      reply.code(400);
      return { error: "enabled (boolean) is required" };
    }
    const [updated] = await db.update(s.crawlSources).set({ enabled }).where(eq(s.crawlSources.id, Number(id))).returning();
    return updated;
  });

  app.delete("/api/crawl-sources/:id", async (req) => {
    const { id } = req.params as { id: string };
    await db.delete(s.crawlSources).where(eq(s.crawlSources.id, Number(id)));
    return { removed: true };
  });

  /** Manual "crawl now" for one source. */
  app.post("/api/crawl-sources/:id/crawl-now", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [source] = await db.select().from(s.crawlSources).where(eq(s.crawlSources.id, Number(id)));
    if (!source) {
      reply.code(404);
      return { error: "source not found" };
    }
    try {
      return await runIngestModule([crawlerModuleFor(source.purpose), "--source-id", id]);
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Manual "crawl now" for an entire purpose/tab (comment 8: "manual
   * 'crawl now' per source and per tab"). */
  app.post("/api/crawl-sources/crawl-now", async (req, reply) => {
    const { purpose } = (req.body ?? {}) as { purpose?: string };
    if (purpose !== "funding" && purpose !== "literature") {
      reply.code(400);
      return { error: "purpose must be 'funding' or 'literature'" };
    }
    try {
      return await runIngestModule([crawlerModuleFor(purpose)], { timeoutMs: 15 * 60_000 });
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Gate proof for comment 8's "daily schedule fires (verified by a
   * forced run plus a scheduled run log)" — runs the SAME code path
   * scheduler.ts's setInterval calls, logged identically (kind:
   * 'scheduled_crawl', trigger: 'forced' vs 'scheduled' distinguishes
   * them in the agent-runs history). */
  app.post("/api/scheduler/run-now", async (req, reply) => {
    try {
      return { results: await runDailyCrawl("forced") };
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });
}
