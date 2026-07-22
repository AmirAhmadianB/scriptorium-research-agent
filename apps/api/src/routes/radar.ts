/** Sprint 4 (C1) — Literature Radar staleness + an explicit refresh trigger.
 * The Research Focus profile already carries a monotonic `version`
 * (profile/store.ts, bumped on every commit) and every literature_scan run
 * now stamps the focus version it read into its own agent_runs summary
 * (run_scan.py) — this route just compares the two integers. No new
 * schema column, no new agent run kind, no parallel staleness tracker. */
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { profileProvider } from "../profile/provider.js";
import { runIngestModule } from "../pythonRunner.js";

// One dashboard, one Node process — an in-memory flag is enough to make "a
// second click during an active run does nothing" true server-side too,
// not just via the frontend's disabled button (Gate's explicit wording).
const refreshInFlight = new Set<string>();

async function lastLiteratureScan(professorId: string) {
  const rows = await db.select().from(s.agentRuns)
    .where(eq(s.agentRuns.kind, "literature_scan"))
    .orderBy(desc(s.agentRuns.startedAt)).limit(20);
  return rows.find(r => (r.summary as any)?.professorId === professorId) ?? null;
}

/** Pure — exported for a fast unit test (radar.test.ts) that doesn't need a
 * live DB. "Stale" specifically means "a focus edit happened since the
 * last run", not "no run has ever happened" — a fresh install with zero
 * runs shouldn't show a stale banner, it should show nothing until the
 * researcher's first refresh. */
export function computeStale(currentFocusVersion: number, lastRunFocusVersion: number | null,
                              hasEverRun: boolean): boolean {
  return hasEverRun && lastRunFocusVersion !== currentFocusVersion;
}

async function radarStatus(professorId: string) {
  const [profile, lastRun] = await Promise.all([
    profileProvider.getCurrent(professorId), lastLiteratureScan(professorId),
  ]);
  const lastRunFocusVersion = (lastRun?.summary as any)?.focusVersion ?? null;
  return {
    currentFocusVersion: profile.version,
    lastRunFocusVersion,
    lastRunAt: lastRun?.startedAt ?? null,
    stale: computeStale(profile.version, lastRunFocusVersion, lastRun !== null),
    refreshing: refreshInFlight.has(professorId),
  };
}

export default async function radarRoutes(app: FastifyInstance) {
  app.get("/api/radar/status", async (req) => {
    const { professorId = "default" } = req.query as { professorId?: string };
    return radarStatus(professorId);
  });

  /** Re-runs literature discovery ONLY (not the funding crawl POST /api/scan
   * also triggers) — a focus-driven radar refresh has no reason to also
   * re-crawl funding sources. Old results stay visible (this route doesn't
   * touch what /api/overview returns mid-run; the frontend just shows the
   * stale banner until this resolves), never blocked by a fresh empty tab. */
  app.post("/api/radar/refresh", async (req, reply) => {
    const { professorId = "default" } = (req.body ?? {}) as { professorId?: string };
    if (refreshInFlight.has(professorId)) {
      reply.code(409);
      return { error: "A radar refresh is already running for this professor.", ...(await radarStatus(professorId)) };
    }
    refreshInFlight.add(professorId);
    try {
      // Literature discovery queries every focus keyword against 2-3
      // external APIs (OpenAlex, Semantic Scholar, arXiv) sequentially —
      // observed to take 30+ minutes for a 6-keyword focus in practice, so
      // this needs real headroom, not the ~5min budget every other
      // orchestrator call here uses for a single LLM round-trip.
      const summary = await runIngestModule(
        ["scriptorium_ingest.run_scan", "--professor-id", professorId], { timeoutMs: 45 * 60_000 },
      );
      return { summary, ...(await radarStatus(professorId)) };
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    } finally {
      refreshInFlight.delete(professorId);
    }
  });
}
