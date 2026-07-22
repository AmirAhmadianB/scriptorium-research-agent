/** Scriptorium schema — Drizzle owns migrations; Python workers only read/write.
 *  SQLite (libSQL) file DB (see db/client.ts for path resolution). Embeddings
 *  use libSQL's native vector type (F32_BLOB) — no separate vector extension
 *  needed; see server.ts for the vector_distance_cos query side. Dim (384)
 *  must match analyze/embed.py's DIM — sized for the free local default
 *  (BAAI/bge-small-en-v1.5), not Voyage's larger models, per Pass 2.2. */
import { sql } from "drizzle-orm";
import {
  customType, index, integer, sqliteTable, text, uniqueIndex,
} from "drizzle-orm/sqlite-core";

const embeddingF32 = customType<{ data: Buffer }>({
  dataType: () => "F32_BLOB(384)",
});

export const professors = sqliteTable("professors", {
  id: text("id").primaryKey(),                 // e.g. "blackburn-a"
  name: text("name").notNull(),
  department: text("department").notNull(),
  orcid: text("orcid"),
  focusOverride: text("focus_override", { mode: "json" }),  // per-prof deltas on config/focus.yaml
});

export const papers = sqliteTable("papers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  doi: text("doi"),
  externalId: text("external_id"),
  source: text("source").notNull(),            // openalex | arxiv | zotero | pdf_folder ...
  title: text("title"),
  abstract: text("abstract"),
  year: integer("year"),
  // ISO YYYY-MM-DD when the source gives one (OpenAlex/arXiv/Semantic
  // Scholar all do; Crossref/Zotero best-effort; pdf_folder never does).
  // Nullable and separate from `year` on purpose: `year` alone can't tell
  // "published 2 months ago" from "published 11 months ago" in the same
  // calendar year, which the Literature Radar's recency window needs.
  publishedDate: text("published_date"),
  venue: text("venue"),
  authors: text("authors", { mode: "json" }).$type<{ name: string; orcid: string | null }[]>(),
  citedByCount: integer("cited_by_count").default(0),
  oaUrl: text("oa_url"),
  concepts: text("concepts", { mode: "json" }).$type<string[]>(),
  professorId: text("professor_id").references(() => professors.id),
  isPrivate: integer("is_private", { mode: "boolean" }).default(false),  // unpublished drafts stay scoped
  structuredSummary: text("structured_summary", { mode: "json" }),      // paper-analyst output cache
  embedding: embeddingF32("embedding"),
  // Sprint 3 Pass 2 — RD-Agent extraction: set once this paper's concepts/
  // entities have been added to the entity graph (knowledge/ingest.py).
  // Column only; the graph itself lives in data/knowledge/, not this DB.
  graphPopulatedAt: integer("graph_populated_at", { mode: "timestamp" }),
  // One dedupe key regardless of whether a DOI exists:
  dedupeKey: text("dedupe_key")
    .generatedAlwaysAs(sql`coalesce(doi, source || ':' || external_id)`, { mode: "stored" })
    .notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex("papers_dedupe_key_idx").on(t.dedupeKey),
  index("papers_year_idx").on(t.year),
]);

export const fundingOpportunities = sqliteTable("funding_opportunities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sponsor: text("sponsor").notNull(),
  program: text("program").notNull(),
  url: text("url").notNull(),
  deadline: text("deadline"),                   // ISO YYYY-MM-DD
  deadlineUncertain: integer("deadline_uncertain", { mode: "boolean" }).default(false),
  amount: text("amount"),
  duration: text("duration"),
  eligibility: text("eligibility"),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  scope: text("scope").default("national"),    // national | provincial | international
  matchScore: integer("match_score_pct"),      // 0–100, refreshed on each focus change
  contentHash: text("content_hash").notNull(),
  status: text("status").default("open"),      // open | closed
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  // Sprint 2 Pass 4 (comments 5/6/9):
  source: text("source").default("crawl"),     // crawl | manual | user_upload — every source behaves identically downstream
  priorities: text("priorities"),              // the funder's own stated focus/priorities for the call
  requirements: text("requirements"),          // application requirements beyond plain eligibility
  proposalTemplate: text("proposal_template", { mode: "json" }),  // derived {sections, evaluationCriteria} — see analyze/proposal_template.py
  // Sprint 4 (C2):
  submissionFormat: text("submission_format"), // e.g. "single PDF via portal", "email to program officer"
  sourceFileUrl: text("source_file_url"),      // retrievable link to the uploaded call document, if any
}, (t) => [uniqueIndex("funding_url_program_idx").on(t.url, t.program)]);

export const agentRuns = sqliteTable("agent_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),                // literature_scan | funding_scan | proposal ...
  model: text("model"),
  summary: text("summary", { mode: "json" }),
  startedAt: integer("started_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

/** Scaffolded in the original revision brief (Change 3 area), never wired
 * to a route — Sprint 5 Pass 6 (comment 13) is the first real user. `path`
 * predates this pass (was meant as a file-on-disk pointer); kept for
 * back-compat but no longer load-bearing — the actual content lives in
 * draftVersions/current* below, same "state lives in the DB, not loose
 * files" convention as everything else in this project. */
export const drafts = sqliteTable("drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),                // proposal | manuscript
  title: text("title").notNull(),
  professorId: text("professor_id").references(() => professors.id),
  path: text("path").notNull(),                // legacy — no longer read
  funderProgram: text("funder_program"),
  status: text("status").default("draft"),    // draft | in-review | submitted
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  // Sprint 5 Pass 6 — one draft row per (proposal session, section).
  proposalSessionId: integer("proposal_session_id"),
  sectionKey: text("section_key"),
  // The researcher's live working copy — autosaved continuously, distinct
  // from the checkpointed history in draftVersions below (comment 13:
  // "keep the last agent-generated version distinct from the researcher-
  // edited version so the two can be compared").
  currentContentJson: text("current_content_json", { mode: "json" }),  // TipTap document JSON
  currentPlainText: text("current_plain_text"),  // [[Title]]-marker text, same format proposal_orchestrator.py already renders
  currentVersionNumber: integer("current_version_number").default(0),
}, (t) => [uniqueIndex("drafts_session_section_idx").on(t.proposalSessionId, t.sectionKey)]);

/** Discrete checkpoints only (NOT every autosave tick, which would make
 * "version" meaningless) — the initial agent-generated draft, and one
 * snapshot per feedback request, so the back-and-forth is traceable
 * (comment 13's explicit requirement). */
export const draftVersions = sqliteTable("draft_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id").notNull().references(() => drafts.id),
  versionNumber: integer("version_number").notNull(),
  authorType: text("author_type").notNull(),   // agent | researcher
  contentJson: text("content_json", { mode: "json" }),
  plainText: text("plain_text").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
}, (t) => [uniqueIndex("draft_versions_draft_version_idx").on(t.draftId, t.versionNumber)]);

/** One row per "request feedback" click. comments is the full span-
 * anchored list; status on each starts 'pending' and only ever moves to
 * 'accepted'/'rejected'/'ignored' via an explicit researcher action —
 * never auto-applied (comment 13: "never as an automatic rewrite"). */
export const draftFeedback = sqliteTable("draft_feedback", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draftId: integer("draft_id").notNull().references(() => drafts.id),
  versionId: integer("version_id").notNull().references(() => draftVersions.id),  // the version reviewed
  comments: text("comments", { mode: "json" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

/** Research Focus profile (dashboard-revision-brief.docx, Change 1) — the
 * global context every feature reads from instead of a hardcoded domain.
 * One profile per professor (uniqueIndex below); status (DRAFT/ACTIVE) is
 * NOT stored here, it's derived from keyword count at read time by
 * profile/store.ts — see @scriptorium/shared for the threshold and the
 * canonical ResearchProfile shape both this API and the dashboard validate
 * against. Supersedes config/focus.yaml's role for live, reactive use;
 * focus.yaml/routes/focus.ts are left in place for now (the CLI /focus
 * skill still uses them) and are candidates for removal in Pass 1.6. */
export const researchProfiles = sqliteTable("research_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  professorId: text("professor_id").notNull().references(() => professors.id),
  focusSynthesis: text("focus_synthesis"),
  version: integer("version").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
}, (t) => [uniqueIndex("research_profiles_professor_idx").on(t.professorId)]);

export const researchProfileKeywords = sqliteTable("research_profile_keywords", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  profileId: integer("profile_id").notNull().references(() => researchProfiles.id),
  value: text("value").notNull(),
  provenance: text("provenance").notNull(),    // manual | derived
  position: integer("position").notNull().default(0),  // display order, Pass 1.2 reordering
}, (t) => [uniqueIndex("research_profile_keywords_unique").on(t.profileId, t.value)]);

/** Pass 2.2 — chunked + embedded corpus text for grounded semantic search
 * (Change 2: corpus ingestion). One row per chunk; `papers.embedding`
 * stays a whole-paper vector (used by the existing /api/corpus/semantic),
 * this is the finer-grained per-passage index that gives source-attributed
 * retrieval (paper + section + snippet, not just a whole-paper score). */
export const paperChunks = sqliteTable("paper_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  paperId: integer("paper_id").notNull().references(() => papers.id),
  chunkIndex: integer("chunk_index").notNull(),
  sectionHead: text("section_head"),
  text: text("text").notNull(),
  embedding: embeddingF32("embedding"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
}, (t) => [
  uniqueIndex("paper_chunks_unique").on(t.paperId, t.chunkIndex),
  index("paper_chunks_paper_idx").on(t.paperId),
]);

/** Pass 3.1 — a proposal-writing session (Change 3). Created ONLY on an
 * explicit researcher action ("start working on this opportunity") — the
 * brief's hard rule that no proposal work begins unassisted. `context` is
 * the orchestrator's correlated snapshot (literature + corpus + funding +
 * research focus) gathered once at session start; `state` accumulates
 * confirmed gaps (Pass 3.2) and drafted sections (Pass 3.3) as the
 * back-and-forth proceeds. One row per session, not per turn — the whole
 * conversation lives in `state`, so a session surviving a restart is the
 * same persistence story as Pass 2.3's corpus memory. */
export const proposalSessions = sqliteTable("proposal_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  professorId: text("professor_id").notNull().references(() => professors.id),
  fundingOpportunityId: integer("funding_opportunity_id").notNull().references(() => fundingOpportunities.id),
  status: text("status").notNull().default("idle"),  // idle | gaps_proposed | drafting | done
  context: text("context", { mode: "json" }),
  state: text("state", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
});

/** Pass 2.3 — corpus memory: a running, persisted synthesis across the
 * whole corpus (not per-paper), one row per professor, updated as papers
 * are added/analyzed. Durable across restarts by construction (it's a DB
 * row, not in-memory state) — see profile/consumers/summaries.ts's
 * per-request digest for the lighter-weight Pass 1.5f equivalent this
 * supersedes for corpus-memory purposes. */
export const corpusSynthesis = sqliteTable("corpus_synthesis", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  professorId: text("professor_id").notNull().references(() => professors.id),
  synthesisText: text("synthesis_text").notNull(),
  paperCount: integer("paper_count").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
}, (t) => [uniqueIndex("corpus_synthesis_professor_idx").on(t.professorId)]);

/** Sprint 2 Pass 3 (comments 7/8) — the crawl-source registry. Single
 * source of truth for "what gets crawled" going forward: seeded once from
 * config/funding.yaml's `sources:` list and config/sources.yaml's
 * `crawl.targets`, but from here on THIS table is authoritative, not the
 * YAML (the brief's "Complement, never duplicate" rule — two stores for
 * the same list would drift). crawl_funding.py reads its target list from
 * here now. purpose distinguishes what kind of extraction applies
 * (funding-opportunity extraction vs. paper-metadata extraction); scope is
 * funding-specific (national/provincial/international/...), null for
 * literature sources. */
export const crawlSources = sqliteTable("crawl_sources", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  url: text("url").notNull(),
  label: text("label").notNull(),
  purpose: text("purpose").notNull(),           // funding | literature
  scope: text("scope"),                         // national | provincial | international | internal | foundation
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastCrawledAt: integer("last_crawled_at", { mode: "timestamp" }),
  lastStatus: text("last_status").notNull().default("never"),  // never | ok | error
  lastResultCount: integer("last_result_count"),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
}, (t) => [uniqueIndex("crawl_sources_url_idx").on(t.url)]);
