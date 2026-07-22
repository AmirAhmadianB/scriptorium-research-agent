/** Scriptorium API — read layer for the dashboard + write hooks for skills.
 *  Deliberately thin: analysis lives in agents, ingestion in Python workers. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import { db, dbReady } from "./db/client.js";
import * as s from "./db/schema.js";
import focusRoutes from "./routes/focus.js";
import scanRoutes from "./routes/scan.js";
import researchProfileRoutes from "./routes/research-profile.js";
import trendsRoutes from "./routes/trends.js";
import corpusLibraryRoutes from "./routes/corpus-library.js";
import corpusAnalysisRoutes from "./routes/corpus-analysis.js";
import proposalRoutes from "./routes/proposal.js";
import crawlSourcesRoutes from "./routes/crawl-sources.js";
import radarRoutes from "./routes/radar.js";
import fundingUploadRoutes from "./routes/funding-upload.js";
import draftEditorRoutes from "./routes/draft-editor.js";
import providersRoutes from "./routes/providers.js";
import { startScheduler } from "./scheduler.js";
import { consumersPrimed } from "./profile/consumers/index.js"; // registers Pass 1.5 feature consumers against the reactive loop
import { getSearchFocusKeywords, rankByFocusRelevance } from "./profile/consumers/search.js";
import { getRecommendationsFocusKeywords, scoreFundingRelevance } from "./profile/consumers/recommendations.js";
import { getDefaultFundingScopes } from "./config.js";
import { recencyCutoffIso } from "./papers.js";
import { ensureDataDirs } from "./dataDir.js";
import { runIngestModuleStdin } from "./pythonRunner.js";
import { mode, isPackaged, dashboardStaticDir } from "./runtime.js";
import { buildLogger } from "./logging.js";
import debugBundleRoutes from "./routes/debug-bundle.js";
import setupRoutes from "./routes/setup.js";

ensureDataDirs();

const app = Fastify({ loggerInstance: buildLogger() });

app.get("/api/health", async () => ({ ok: true }));

/** Dashboard bootstrap: everything the front page needs in one call. */
app.get("/api/overview", async () => {
  // Sprint 6: "New in the field" is a *new-articles* feed, not a corpus
  // browse — only papers published in the last 3 months (or with a
  // future/in-press date; that's already covered by ">= 3 months ago",
  // there's no separate upper bound) qualify. A paper with no
  // published_date (older rows from before this field existed, or sources
  // that never supply one, e.g. web_crawl/pdf_folder) can't be verified as
  // recent, so it's excluded here rather than assumed — it still shows up
  // everywhere else (Corpus tab, search) unfiltered.
  const cutoff = recencyCutoffIso(new Date());

  const [paperPool, fundingRows, runs] = await Promise.all([
    // Sprint 2 Pass 1 (comment 2): focus-rank a pool, THEN slice to 12 —
    // matches the same pattern GET /api/corpus already used (Pass 1.5a).
    // The pool itself is bounded by the WHERE clause (papers in the
    // recency window), not by an ORDER-BY-date LIMIT: some real papers
    // (Zenodo/OpenAlex deposits, in-press items) carry dates far in the
    // future, which would sort ahead of and crowd out every genuinely
    // on-topic recent paper if truncated by date before focus-ranking —
    // live-verified this actually happened with a limit(50) here. 1000 is
    // a defensive cap, not the real bound; the WHERE clause is.
    db.select().from(s.papers)
      .where(and(isNotNull(s.papers.publishedDate), gte(s.papers.publishedDate, cutoff)))
      .orderBy(desc(s.papers.publishedDate)).limit(1000),
    db.select().from(s.fundingOpportunities)
      .orderBy(sql`deadline nulls last`).limit(50),
    db.select().from(s.agentRuns).orderBy(desc(s.agentRuns.startedAt)).limit(8),
  ]);
  // The corpus has pre-existing duplicate-title rows (the same work indexed
  // by more than one connector with a different external_id/DOI, so the
  // dedupe_key in db.py doesn't catch it) — with only 12 slots shown here,
  // a duplicate visibly wastes one. Dedupe post-rank, not pre-rank: keeps
  // whichever copy already sorted best.
  const seenTitles = new Set<string>();
  const papers = rankByFocusRelevance(paperPool, getSearchFocusKeywords())
    .filter(p => {
      const key = p.title?.trim().toLowerCase();
      if (!key) return true;
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    })
    .slice(0, 12);
  // Pass 1.5b: same live recompute as GET /api/funding, so the funding
  // panel on the front page reflects the current Research Focus too.
  const focusKeywords = getRecommendationsFocusKeywords();
  // Sprint 2 Pass 4 (comment 4): same default-scope flagging as GET
  // /api/funding — the front page's funding panel shouldn't show
  // international calls by default either.
  const defaultScopes = new Set(getDefaultFundingScopes());
  const funding = fundingRows
    .map(f => ({ ...f, liveMatchScore: scoreFundingRelevance(f, focusKeywords), isDefaultScope: defaultScopes.has(f.scope ?? "national") }))
    .filter(f => f.isDefaultScope)
    .slice(0, 12);
  const closingSoon = funding.filter(f =>
    f.deadline && (new Date(f.deadline).getTime() - Date.now()) < 30 * 864e5);
  return { papers, funding, closingSoon, runs };
});

app.get("/api/corpus", async (req) => {
  const { q = "", year } = req.query as { q?: string; year?: string };
  let query = db.select().from(s.papers).limit(50).$dynamic();
  if (year) query = query.where(gte(s.papers.year, Number(year)));
  if (q) query = query.where(
    sql`(title LIKE ${"%" + q + "%"} OR abstract LIKE ${"%" + q + "%"})`);
  const rows = await query.orderBy(desc(s.papers.citedByCount));
  // Pass 1.5a: rank toward the researcher's CURRENT Research Focus, live —
  // getSearchFocusKeywords() reflects the latest profile via the reactive
  // loop, not a fresh per-request DB read, so an edit takes effect on the
  // very next search with no reload and no per-request profile query cost.
  return rankByFocusRelevance(rows, getSearchFocusKeywords());
});

app.get("/api/funding", async (req) => {
  const { scope, includeAll } = req.query as { scope?: string; includeAll?: string };
  let query = db.select().from(s.fundingOpportunities).$dynamic();
  if (scope) query = query.where(sql`scope = ${scope}`);
  const rows = await query.orderBy(sql`deadline nulls last`).limit(200);
  const focusKeywords = getRecommendationsFocusKeywords();
  // Sprint 2 Pass 4 (comment 4): flag, never delete — default_scopes comes
  // from config/funding.yaml, so this stays institution-adaptive, not a
  // hardcoded "Canada" check. includeAll=true (an explicit researcher
  // toggle) shows everything; the default view flags out-of-scope rows so
  // the UI can hide/dim them without losing the underlying data.
  const defaultScopes = new Set(getDefaultFundingScopes());
  const withFlags = rows.map(r => ({
    ...r,
    // Pass 1.5b: matchScore is stale the moment the researcher edits
    // Research Focus (only recomputed by the next crawl); liveMatchScore
    // recomputes on every request against the CURRENT profile.
    liveMatchScore: scoreFundingRelevance(r, focusKeywords),
    isDefaultScope: defaultScopes.has(r.scope ?? "national"),
  }));
  return includeAll === "true" ? withFlags : withFlags.filter(r => r.isDefaultScope);
});

/** Sprint 2 Pass 4 (comment 6) — manual add. Writes through the SAME
 * upsert/schema a crawled opportunity uses (source: 'manual' is the only
 * difference), so it behaves identically downstream — same match scoring,
 * same funding-scope flagging, same drafting eligibility. If the
 * researcher pastes the funder's guidelines text, it's run through the
 * exact extraction prompt the crawler uses (crawl_funding.extract_from_text)
 * to derive priorities/requirements/proposalTemplate — not a second,
 * simpler extraction path.
 *
 * Sprint 4 (C2) extends this SAME route rather than adding a second save
 * path: if priorities/requirements/proposalTemplate/submissionFormat are
 * passed DIRECTLY (the researcher's edited upload-extraction preview —
 * see POST /api/funding/extract-upload below), extraction is skipped
 * entirely; guidelinesText-driven extraction still works unchanged for the
 * paste-text case. source='user_upload' additionally dedupes on
 * sponsor+program+deadline (the spec's stated rule for uploads), on top
 * of — not instead of — the existing url+program unique constraint every
 * source already relies on. url is optional when sourceFileUrl is given
 * (an uploaded call document often has no canonical web URL); one of the
 * two is still required so the record always has a retrievable source. */
app.post("/api/funding", async (req, reply) => {
  const body = (req.body ?? {}) as {
    program?: string; sponsor?: string; url?: string; deadline?: string | null;
    amount?: string | null; duration?: string | null; eligibility?: string | null;
    scope?: string; guidelinesText?: string; source?: "manual" | "user_upload";
    priorities?: string | null; requirements?: string | null; proposalTemplate?: unknown;
    submissionFormat?: string | null; sourceFileUrl?: string | null;
  };
  if (!body.program || !body.sponsor || (!body.url && !body.sourceFileUrl)) {
    reply.code(400);
    return { error: "program, sponsor, and (url or an uploaded file) are required" };
  }
  const url = body.url || body.sourceFileUrl!;

  let priorities = body.priorities ?? null, requirements = body.requirements ?? null,
      proposalTemplate: unknown = body.proposalTemplate ?? null;
  const alreadyExtracted = body.priorities != null || body.requirements != null || body.proposalTemplate != null;
  if (!alreadyExtracted && body.guidelinesText?.trim()) {
    try {
      const extracted = await runIngestModuleStdin(
        ["scriptorium_ingest.funding.crawl_funding", "--extract-text"],
        JSON.stringify({ sponsor: body.sponsor, text: body.guidelinesText }),
      );
      priorities = extracted.priorities ?? null;
      requirements = extracted.requirements ?? null;
      proposalTemplate = extracted.proposal_structure ?? null;
    } catch { /* extraction is a best-effort enhancement; the manual entry itself still saves */ }
  }

  const source = body.source ?? "manual";
  const contentHash = createHash("sha1")
    .update(JSON.stringify({ program: body.program, sponsor: body.sponsor, url, source, at: Date.now() }))
    .digest("hex");

  // C2's dedup rule for uploads: sponsor+program+deadline, checked BEFORE
  // the generic url+program path (a re-upload of the same call rarely
  // reuses the exact same sourceFileUrl, since each upload gets its own
  // stored filename).
  if (source === "user_upload") {
    const [dup] = await db.select().from(s.fundingOpportunities).where(
      sql`sponsor = ${body.sponsor} AND program = ${body.program} AND deadline IS ${body.deadline ?? null}`,
    ).limit(1);
    if (dup) {
      const [updated] = await db.update(s.fundingOpportunities).set({
        deadline: body.deadline ?? null, amount: body.amount ?? null, duration: body.duration ?? null,
        eligibility: body.eligibility ?? null, scope: body.scope ?? dup.scope, contentHash,
        priorities, requirements, proposalTemplate: proposalTemplate as any,
        submissionFormat: body.submissionFormat ?? null, sourceFileUrl: body.sourceFileUrl ?? dup.sourceFileUrl,
        updatedAt: new Date(),
      }).where(sql`id = ${dup.id}`).returning();
      return updated;
    }
  }

  const [inserted] = await db.insert(s.fundingOpportunities).values({
    program: body.program, sponsor: body.sponsor, url,
    deadline: body.deadline ?? null, amount: body.amount ?? null, duration: body.duration ?? null,
    eligibility: body.eligibility ?? null, scope: body.scope ?? "national",
    contentHash, source,
    priorities, requirements, proposalTemplate: proposalTemplate as any,
    submissionFormat: body.submissionFormat ?? null, sourceFileUrl: body.sourceFileUrl ?? null,
  }).onConflictDoUpdate({
    target: [s.fundingOpportunities.url, s.fundingOpportunities.program],
    set: { deadline: body.deadline ?? null, amount: body.amount ?? null, eligibility: body.eligibility ?? null,
           priorities, requirements, proposalTemplate: proposalTemplate as any,
           submissionFormat: body.submissionFormat ?? null, sourceFileUrl: body.sourceFileUrl ?? null,
           updatedAt: new Date() },
  }).returning();
  return inserted;
});

app.get("/api/runs", async () =>
  db.select().from(s.agentRuns).orderBy(desc(s.agentRuns.startedAt)).limit(50));

/** Semantic search once embeddings are populated (libSQL native vector_distance_cos). */
app.post("/api/corpus/semantic", async (req) => {
  const { embedding } = req.body as { embedding: number[] };
  const v = JSON.stringify(embedding);
  return db.all(sql`
    SELECT id, title, venue, year,
           1 - vector_distance_cos(embedding, vector32(${v})) AS score
    FROM papers WHERE embedding IS NOT NULL
    ORDER BY vector_distance_cos(embedding, vector32(${v})) LIMIT 20`);
});

/** Sprint 6 Pass 3: every await that used to run at module top level (plugin
 * registration, schema bootstrap, priming the reactive loop, listen()) now
 * lives in here instead — top-level await forces ESM-only output, which the
 * Node single-executable build can't consume (SEA requires a CJS-compatible
 * entry point). Same startup sequence and ordering as before this pass,
 * just wrapped in a function instead of expressed as bare module-scope
 * statements. */
async function main(): Promise<void> {
  await dbReady;
  await consumersPrimed;

  await app.register(cors, { origin: true });
  // Registered once on the true root instance (not inside a route plugin) so
  // its content-type parser applies to every sibling route file, not just
  // whichever plugin happens to call register() — see the Pass 2.1 note in
  // routes/research-profile.ts for the 415 bug this fixes.
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 500 } });
  await app.register(focusRoutes);
  await app.register(scanRoutes);
  await app.register(researchProfileRoutes);
  await app.register(trendsRoutes);
  await app.register(corpusLibraryRoutes);
  await app.register(corpusAnalysisRoutes);
  await app.register(proposalRoutes);
  await app.register(crawlSourcesRoutes);
  await app.register(radarRoutes);
  await app.register(fundingUploadRoutes);
  await app.register(draftEditorRoutes);
  await app.register(providersRoutes);
  await app.register(debugBundleRoutes);
  await app.register(setupRoutes);

  // Sprint 6 Pass 1 spec item, actually built in Pass 4 once the Tauri
  // shell needed it: packaged mode serves the dashboard's static Vite
  // production build itself, collapsing to one port — dev keeps Vite's own
  // dev server + proxy entirely unchanged, so this never registers there.
  if (isPackaged) {
    if (!fs.existsSync(dashboardStaticDir)) {
      throw new Error(
        `Packaged mode expects the dashboard build at ${dashboardStaticDir} — ` +
        "the release build step didn't place it there.",
      );
    }
    await app.register(fastifyStatic, { root: dashboardStaticDir });
    // SPA-shaped fallback: this dashboard has no client-side router (tabs
    // are useState, not distinct URLs), so in practice only "/" is ever
    // requested — but falling back to index.html for any unmatched GET
    // that isn't an API call costs nothing and protects a future route.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "not found" });
    });
  }

  // Sprint 6 Pass 0 flagged the hardcoded port as an open item; the actual
  // packaged single-port strategy is a Pass 4 (Tauri shell) decision, but an
  // env override costs nothing now and is what let this pass's own gate spin
  // up a second, isolated instance side by side with dev for verification.
  const PORT = process.env.SCRIPTORIUM_PORT ? Number(process.env.SCRIPTORIUM_PORT) : 8787;
  await app.listen({ port: PORT, host: "0.0.0.0" });
  app.log.info({ mode }, "Scriptorium API started");
  startScheduler();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
