/** Pass 3.1 — Proposal Writing tab (Change 3) scaffolding: the tab, and an
 * orchestrator that CORRELATES literature + corpus + a chosen funding
 * opportunity into one session context. No drafting yet (Pass 3.3) and no
 * gap brainstorming yet (Pass 3.2) — this pass only proves the orchestrator
 * can gather grounded context and that it does so ONLY on an explicit
 * researcher request, never on its own.
 *
 * Agent contracts (the three inputs the orchestrator correlates):
 *   LiteratureContext — { recentPapers: {id,title,year,venue,citedByCount}[] }
 *     from the papers table, ranked toward the current Research Focus
 *     (reuses Pass 1.5a's rankByFocusRelevance — no parallel ranking logic).
 *   CorpusContext — { synthesis: string|null, relevantChunks: {paperId,paperTitle,sectionHead,snippet,score}[] }
 *     from Pass 2.2/2.3's paper_chunks + corpus_synthesis, queried with the
 *     funding opportunity's own program/eligibility/keywords text so the
 *     retrieval is opportunity-specific, not generic.
 *   FundingContext — { opportunity: {id,program,sponsor,deadline,amount,eligibility,keywords} }
 *     the chosen row from funding_opportunities, verbatim.
 * ResearchFocus (profile keywords + synthesis) is included as the fourth,
 * implicit context every one of the above is already field-adaptive
 * through (Change 1).
 */
import type { FastifyInstance } from "fastify";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { profileProvider } from "../profile/provider.js";
import { getSearchFocusKeywords, rankByFocusRelevance } from "../profile/consumers/search.js";
import { embedQuery } from "../embed-client.js";
import { runIngestModule } from "../pythonRunner.js";

async function runOrchestrator(args: string[], timeoutMs = 5 * 60_000): Promise<any> {
  return runIngestModule(["scriptorium_ingest.analyze.proposal_orchestrator", ...args], { timeoutMs });
}

async function gatherCorpusContext(queryText: string) {
  const synthesisRows = await db.all<{ synthesisText: string }>(
    sql`SELECT synthesis_text as synthesisText FROM corpus_synthesis WHERE professor_id = 'default'`);
  let relevantChunks: unknown[] = [];
  try {
    const vec = JSON.stringify(await embedQuery(queryText));
    // Sprint 2 Pass 5 (comment 11): pull the source paper's own citation
    // metadata alongside each chunk — IEEE-formatting a reference needs
    // authors/doi/year/venue, not just the title this previously carried.
    const rawChunks = await db.all<any>(sql`
      SELECT p.id as paperId, p.title as paperTitle, p.authors as authors, p.doi as doi,
             p.year as year, p.venue as venue, p.oa_url as oaUrl,
             pc.section_head as sectionHead, pc.text as snippet,
             1 - vector_distance_cos(pc.embedding, vector32(${vec})) AS score
      FROM paper_chunks pc JOIN papers p ON p.id = pc.paper_id
      WHERE pc.embedding IS NOT NULL
      ORDER BY vector_distance_cos(pc.embedding, vector32(${vec})) LIMIT 6`);
    // A raw sql`` query bypasses Drizzle's schema-driven JSON deserialization
    // (that only applies through the typed .select() query builder) — the
    // authors column comes back as its raw stored TEXT (a JSON string), not
    // a parsed array, unlike gatherLiteratureContext()'s db.select() below.
    // Left unparsed, formatIEEE() on the dashboard crashes the whole editor
    // (authors.slice(...).map is not a function) the first time a chunk from
    // THIS query — not the literature-radar one — gets cited.
    relevantChunks = rawChunks.map(r => ({
      ...r, authors: typeof r.authors === "string" ? JSON.parse(r.authors || "[]") : (r.authors ?? []),
    }));
  } catch {
    // Embedding unavailable (e.g. model not yet downloaded) — degrade to no
    // chunk evidence rather than failing session creation outright; the
    // synthesis (if any) still gives SOME grounding.
  }
  return { synthesis: synthesisRows[0]?.synthesisText ?? null, relevantChunks };
}

async function gatherLiteratureContext() {
  const rows = await db.select().from(s.papers).orderBy(desc(s.papers.citedByCount)).limit(50);
  const ranked = rankByFocusRelevance(rows, getSearchFocusKeywords());
  return {
    recentPapers: ranked.slice(0, 10).map(p => ({
      id: p.id, title: p.title, year: p.year, venue: p.venue, citedByCount: p.citedByCount,
      authors: p.authors, doi: p.doi, oaUrl: p.oaUrl,
    })),
  };
}

async function gatherContext(fundingOpportunityId: number) {
  const [opportunity] = await db.select().from(s.fundingOpportunities).where(eq(s.fundingOpportunities.id, fundingOpportunityId));
  if (!opportunity) throw new Error(`No funding opportunity with id ${fundingOpportunityId}`);

  const profile = await profileProvider.getCurrent();
  const queryText = [opportunity.program, opportunity.eligibility, ...(opportunity.keywords ?? [])].filter(Boolean).join(" ");

  const [literature, corpus] = await Promise.all([gatherLiteratureContext(), gatherCorpusContext(queryText)]);
  return {
    funding: { opportunity },
    literature,
    corpus,
    researchFocus: { keywords: profile.keywords.map(k => k.value), focusSynthesis: profile.focusSynthesis },
  };
}

export default async function proposalRoutes(app: FastifyInstance) {
  app.get("/api/proposal/sessions", async (req) => {
    const { professorId = "default" } = req.query as { professorId?: string };
    return db.select().from(s.proposalSessions)
      .where(eq(s.proposalSessions.professorId, professorId))
      .orderBy(desc(s.proposalSessions.createdAt));
  });

  app.get("/api/proposal/sessions/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [row] = await db.select().from(s.proposalSessions).where(eq(s.proposalSessions.id, Number(id)));
    if (!row) { reply.code(404); return { error: "session not found" }; }
    return row;
  });

  /** The ONLY way a session (and therefore any context-gathering) comes
   * into existence — no background job, no auto-trigger on opportunity
   * selection alone. This IS "the researcher explicitly requests it for a
   * chosen funding opportunity." Status starts at 'idle': context is
   * correlated so the orchestrator HAS what it needs, but no gap
   * brainstorming (Pass 3.2) or drafting (Pass 3.3) happens until a
   * FURTHER explicit action. */
  app.post("/api/proposal/sessions", async (req, reply) => {
    const { fundingOpportunityId, professorId = "default" } = (req.body ?? {}) as
      { fundingOpportunityId?: number; professorId?: string };
    if (!fundingOpportunityId) {
      reply.code(400);
      return { error: "fundingOpportunityId is required" };
    }
    let context;
    try {
      context = await gatherContext(fundingOpportunityId);
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
    const [inserted] = await db.insert(s.proposalSessions).values({
      professorId, fundingOpportunityId, status: "idle", context, state: { gaps: [], draftSections: [] },
    }).returning();
    return inserted;
  });

  /** Pass 3.2 — explicit "Brainstorm gaps" action. Never runs as a side
   * effect of session creation (Pass 3.1's Gate: orchestrator stays idle
   * until asked). Delegates the actual LLM call to
   * analyze/proposal_orchestrator.py so it goes through claude_cli.complete()
   * like every other completion in this project. */
  app.post("/api/proposal/sessions/:id/brainstorm-gaps", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await runOrchestrator(["--session-id", id, "--brainstorm-gaps"]);
      return result;
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Pass 3.2 — records the researcher's suitability answer per gap. Pure
   * bookkeeping (delegated to the same Python module so the session row's
   * read-modify-write isn't duplicated in two languages) — no LLM call.
   * Pass 3.3's drafting step checks for at least one gap with
   * researcherAnswer === true before it will do anything, which is what
   * actually enforces "do not proceed without an answer". */
  app.post("/api/proposal/sessions/:id/confirm-gaps", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { answers } = (req.body ?? {}) as { answers?: { id: number; suitable: boolean; editedGap?: string }[] };
    if (!answers || !Array.isArray(answers)) {
      reply.code(400);
      return { error: "answers (array of {id, suitable}) is required" };
    }
    try {
      const result = await runOrchestrator(["--session-id", id, "--confirm-gaps", JSON.stringify(answers)]);
      return result;
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Sprint 4 (C3) — the researcher hands the pipeline a gap instead of
   * waiting on brainstorm-gaps. Still explicit (a distinct button, fired
   * only on submit) and still grounded before it's usable: the LLM call
   * here only grounds/reports on the researcher's statement (vector
   * search + graph query), it never rewrites the statement itself — "the
   * gap is theirs; the agent enriches, never overrides" (spec's own
   * wording). Produces a gap record in the SAME state.gaps list
   * brainstorm-gaps populates, so confirm-gaps/draft-section/the critique
   * judge need no source-specific branch downstream. */
  app.post("/api/proposal/sessions/:id/suggest-gap", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { statement, referenceNotes } = (req.body ?? {}) as { statement?: string; referenceNotes?: string };
    if (!statement || !statement.trim()) {
      reply.code(400);
      return { error: "statement is required" };
    }
    const args = ["--session-id", id, "--suggest-gap", statement];
    if (referenceNotes) args.push("--reference-notes", referenceNotes);
    try {
      // Grounding does a vector search + graph traversal + one LLM call —
      // similar cost shape to brainstorm-gaps, same timeout budget.
      const result = await runOrchestrator(args);
      return result;
    } catch (e: any) {
      reply.code(500);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Pass 3.3 — draft (or revise, given feedback) exactly ONE section per
   * call. There is no "draft the whole proposal" endpoint anywhere in this
   * API — that omission IS the enforcement of "never generates a full
   * proposal unprompted": the only way to get a second section is a second,
   * separate, explicit request. proposal_orchestrator.py's draft_section()
   * additionally refuses to run at all unless the session already has a
   * confirmed (suitable=true) gap, independent of anything checked here. */
  app.post("/api/proposal/sessions/:id/draft-section", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sectionKey, feedback } = (req.body ?? {}) as { sectionKey?: string; feedback?: string };
    if (!sectionKey) {
      reply.code(400);
      return { error: "sectionKey is required" };
    }
    const args = ["--session-id", id, "--draft-section", sectionKey];
    if (feedback) args.push("--feedback", feedback);
    try {
      const result = await runOrchestrator(args);
      return result;
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Sprint 3 Pass 4 — the RD-Agent-derived propose/draft/critique loop.
   * Still an explicit researcher action (never auto-fires), and still
   * bounded: draft_section()'s own confirmed-gap gate applies underneath
   * this exactly as it does for a single manual draft call, and the loop
   * itself additionally refuses without a confirmed gap. Runs D (draft,
   * reusing draft_section — no second drafting path) and critique
   * (an LLM-judge against explicit rubrics) for up to maxIterations
   * rounds or until convergenceThreshold is met, then returns — the
   * researcher still reviews the final draft and can send further
   * feedback via the existing /draft-section route exactly as before. */
  app.post("/api/proposal/sessions/:id/auto-critique-loop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sectionKey, maxIterations, convergenceThreshold, feedback } = (req.body ?? {}) as {
      sectionKey?: string; maxIterations?: number; convergenceThreshold?: number; feedback?: string;
    };
    if (!sectionKey) {
      reply.code(400);
      return { error: "sectionKey is required" };
    }
    const args = ["--session-id", id, "--auto-critique-loop", sectionKey];
    // maxIterations/convergenceThreshold are legitimately 0-valued in
    // principle (a threshold of 0 means "accept the first draft") — `if
    // (x)` treats 0 as falsy and would silently drop it, so check for
    // presence explicitly instead.
    if (maxIterations != null) args.push("--max-iterations", String(maxIterations));
    if (convergenceThreshold != null) args.push("--convergence-threshold", String(convergenceThreshold));
    if (feedback) args.push("--feedback", feedback);
    // Each iteration is TWO frontier-model calls (draft + critique), unlike
    // every other orchestrator call here which is one — scale the timeout
    // by maxIterations (capped) instead of sharing the single-call 5min
    // budget every other route uses.
    const iterations = Math.max(1, Math.min(maxIterations ?? 3, 10));
    const loopTimeoutMs = Math.min(iterations * 4 * 60_000, 20 * 60_000);
    try {
      const result = await runOrchestrator(args, loopTimeoutMs);
      return result;
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });
}
