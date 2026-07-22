/** Pass 2.2 — trigger + status for the corpus_ingest.py pipeline (chunk +
 * embed + deep-analyze locally-uploaded PDFs, then regenerate the corpus
 * synthesis), plus Pass 2.2's Gate requirement: "querying the corpus
 * returns grounded results with source attribution." */
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { runIngestModule } from "../pythonRunner.js";

export default async function corpusAnalysisRoutes(app: FastifyInstance) {
  /** Pending count so the dashboard can show real progress before/after a
   * run — both scopes: the researcher's own uploaded PDFs (Pass 2.1/2.2),
   * and the full corpus (Sprint 2 Pass 2, comment 12: "embeddings populated
   * for the full corpus" covers everything, not just manual uploads). */
  app.get("/api/corpus/analysis-status", async (req) => {
    const { professorId = "default" } = req.query as { professorId?: string };
    const [{ total }] = await db.all<{ total: number }>(
      sql`SELECT COUNT(*) as total FROM papers WHERE source = 'pdf_folder' AND professor_id = ${professorId}`);
    const [{ analyzed }] = await db.all<{ analyzed: number }>(
      sql`SELECT COUNT(*) as analyzed FROM papers
          WHERE source = 'pdf_folder' AND professor_id = ${professorId} AND structured_summary IS NOT NULL`);
    const [{ chunked }] = await db.all<{ chunked: number }>(
      sql`SELECT COUNT(DISTINCT paper_id) as chunked FROM paper_chunks pc
          JOIN papers p ON p.id = pc.paper_id
          WHERE p.source = 'pdf_folder' AND p.professor_id = ${professorId}`);
    const [{ corpusTotal }] = await db.all<{ corpusTotal: number }>(
      sql`SELECT COUNT(*) as corpusTotal FROM papers WHERE oa_url IS NOT NULL AND oa_url <> ''`);
    const [{ corpusAnalyzed }] = await db.all<{ corpusAnalyzed: number }>(
      sql`SELECT COUNT(*) as corpusAnalyzed FROM papers
          WHERE oa_url IS NOT NULL AND oa_url <> '' AND structured_summary IS NOT NULL`);
    const [{ corpusChunked }] = await db.all<{ corpusChunked: number }>(
      sql`SELECT COUNT(DISTINCT paper_id) as corpusChunked FROM paper_chunks pc
          JOIN papers p ON p.id = pc.paper_id
          WHERE p.oa_url IS NOT NULL AND p.oa_url <> ''`);
    const synthesis = await db.all(
      sql`SELECT synthesis_text as synthesisText, paper_count as paperCount, updated_at as updatedAt
          FROM corpus_synthesis WHERE professor_id = ${professorId}`);
    return {
      total, analyzed, chunked, pending: Math.max(0, total - analyzed),
      corpusTotal, corpusAnalyzed, corpusChunked,
      corpusPending: Math.max(0, corpusTotal - Math.min(corpusAnalyzed, corpusChunked)),
      synthesis: synthesis[0] ?? null,
    };
  });

  /** Sprint 2 Pass 2 (comment 12) backfill trigger — runs paper_analyst.py
   * over the WHOLE oa_url-fetchable corpus (not just uploaded PDFs),
   * analyzing AND chunking whatever's missing either. Separate endpoint
   * from /api/corpus/analyze (which only walks the local upload folder)
   * because this can cover hundreds of papers and legitimately takes much
   * longer — same reasoning /api/scan already applies to its own slow
   * external-fetch work. */
  app.post("/api/corpus/backfill-analysis", async (req, reply) => {
    const { limit } = (req.body ?? {}) as { limit?: number };
    const args = ["scriptorium_ingest.analyze.paper_analyst"];
    if (limit) args.push("--limit", String(limit));
    try {
      const result = await runIngestModule(args, { timeoutMs: 30 * 60_000 });
      // Full-corpus analysis touches papers outside any one professor's
      // scope (bulk-scanned rows have no professor_id — see corpus_ingest.py),
      // so resync the default professor's synthesis to pick up the new coverage.
      try {
        // Sprint 6 Pass 1: routed through corpus_ingest.py's own `--resync`
        // entrypoint instead of `-c <inline source>` (see politeness.py's
        // --test-fetch for the same reasoning — no interpreter in a
        // packaged sidecar to run arbitrary source through).
        await runIngestModule(
          ["scriptorium_ingest.analyze.corpus_ingest", "--resync", "--professor", "default"],
          { timeoutMs: 5 * 60_000 },
        );
      } catch { /* best-effort resync; the analysis result itself is the important response */ }
      return result;
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Runs synchronously (deep analysis of a handful of papers is what this
   * pipeline is for; a large corpus should use --limit via the CLI/cron,
   * same convention as /api/scan). */
  app.post("/api/corpus/analyze", async (req, reply) => {
    const { professorId = "default", limit } = (req.body ?? {}) as { professorId?: string; limit?: number };
    const args = ["scriptorium_ingest.analyze.corpus_ingest", "--professor", professorId];
    if (limit) args.push("--limit", String(limit));
    try {
      return await runIngestModule(args, { timeoutMs: 10 * 60_000 });
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Sprint 2 Pass 2 (comment 12): rebuilt as retrieval-then-synthesis —
   * delegates to analyze/ask_corpus.py, which reuses the SAME retrieval
   * (query_corpus) this route used to do inline, then adds the missing
   * synthesis step: a grounded, cited answer or an explicit
   * not-found-in-corpus decline instead of raw ranked snippets. */
  app.get("/api/corpus/ask", async (req, reply) => {
    const { q, professorId = "default" } = req.query as { q?: string; professorId?: string };
    if (!q || !q.trim()) {
      reply.code(400);
      return { error: "q is required" };
    }
    try {
      return await runIngestModule(
        ["scriptorium_ingest.analyze.ask_corpus", "--question", q, "--professor", professorId],
        { timeoutMs: 2 * 60_000 },
      );
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });
}
