-- Sprint 6 Pass 1: full schema bootstrap for a fresh (empty) database.
-- Captured from the live dev DB, which itself was built by hand-applying
-- raw-SQL migrations over every prior sprint (this project never used
-- drizzle-kit migrate) -- this file is the equivalent starting point for
-- a packaged install's brand-new per-user data dir, applied once by
-- db/bootstrap.ts when the professors table is missing.

CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`model` text,
	`summary` text,
	`started_at` integer DEFAULT (unixepoch())
);

CREATE TABLE corpus_synthesis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id TEXT NOT NULL REFERENCES professors(id),
    synthesis_text TEXT NOT NULL,
    paper_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER DEFAULT (unixepoch())
  );

CREATE TABLE crawl_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    label TEXT NOT NULL,
    purpose TEXT NOT NULL,
    scope TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_crawled_at INTEGER,
    last_status TEXT NOT NULL DEFAULT 'never',
    last_result_count INTEGER,
    last_error TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );

CREATE TABLE draft_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_id INTEGER NOT NULL REFERENCES drafts(id),
            version_id INTEGER NOT NULL REFERENCES draft_versions(id),
            comments TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch())
        );

CREATE TABLE draft_versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            draft_id INTEGER NOT NULL REFERENCES drafts(id),
            version_number INTEGER NOT NULL,
            author_type TEXT NOT NULL,
            content_json TEXT,
            plain_text TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch())
        );

CREATE TABLE `drafts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`professor_id` text,
	`path` text NOT NULL,
	`funder_program` text,
	`status` text DEFAULT 'draft',
	`updated_at` integer DEFAULT (unixepoch()), proposal_session_id INTEGER, section_key TEXT, current_content_json TEXT, current_plain_text TEXT, current_version_number INTEGER DEFAULT 0,
	FOREIGN KEY (`professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `funding_opportunities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sponsor` text NOT NULL,
	`program` text NOT NULL,
	`url` text NOT NULL,
	`deadline` text,
	`deadline_uncertain` integer DEFAULT false,
	`amount` text,
	`duration` text,
	`eligibility` text,
	`keywords` text,
	`scope` text DEFAULT 'national',
	`match_score_pct` integer,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'open',
	`updated_at` integer DEFAULT (unixepoch())
, source TEXT DEFAULT 'crawl', priorities TEXT, requirements TEXT, proposal_template TEXT, submission_format TEXT, source_file_url TEXT);

CREATE TABLE paper_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id INTEGER NOT NULL REFERENCES papers(id),
    chunk_index INTEGER NOT NULL,
    section_head TEXT,
    text TEXT NOT NULL,
    embedding F32_BLOB(384),
    created_at INTEGER DEFAULT (unixepoch())
  );

CREATE TABLE `papers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`doi` text,
	`external_id` text,
	`source` text NOT NULL,
	`title` text,
	`abstract` text,
	`year` integer,
	`venue` text,
	`authors` text,
	`cited_by_count` integer DEFAULT 0,
	`oa_url` text,
	`concepts` text,
	`professor_id` text,
	`is_private` integer DEFAULT false,
	`structured_summary` text,
	`dedupe_key` text GENERATED ALWAYS AS (coalesce(doi, source || ':' || external_id)) STORED NOT NULL,
	`created_at` integer DEFAULT (unixepoch()), embedding F32_BLOB(384), graph_populated_at INTEGER, published_date TEXT,
	FOREIGN KEY (`professor_id`) REFERENCES `professors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `professors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`department` text NOT NULL,
	`orcid` text,
	`focus_override` text
);

CREATE TABLE proposal_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id TEXT NOT NULL REFERENCES professors(id),
    funding_opportunity_id INTEGER NOT NULL REFERENCES funding_opportunities(id),
    status TEXT NOT NULL DEFAULT 'idle',
    context TEXT,
    state TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  );

CREATE TABLE research_profile_keywords (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    profile_id integer NOT NULL,
    value text NOT NULL,
    provenance text NOT NULL,
    position integer DEFAULT 0 NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES research_profiles(id) ON UPDATE no action ON DELETE no action
  );

CREATE TABLE research_profiles (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    professor_id text NOT NULL,
    focus_synthesis text,
    version integer DEFAULT 0 NOT NULL,
    updated_at integer,
    FOREIGN KEY (professor_id) REFERENCES professors(id) ON UPDATE no action ON DELETE no action
  );

CREATE UNIQUE INDEX corpus_synthesis_professor_idx ON corpus_synthesis(professor_id);

CREATE UNIQUE INDEX crawl_sources_url_idx ON crawl_sources(url);

CREATE UNIQUE INDEX draft_versions_draft_version_idx ON draft_versions(draft_id, version_number);

CREATE UNIQUE INDEX drafts_session_section_idx ON drafts(proposal_session_id, section_key);

CREATE UNIQUE INDEX `funding_url_program_idx` ON `funding_opportunities` (`url`,`program`);

CREATE INDEX paper_chunks_paper_idx ON paper_chunks(paper_id);

CREATE UNIQUE INDEX paper_chunks_unique ON paper_chunks(paper_id, chunk_index);

CREATE UNIQUE INDEX `papers_dedupe_key_idx` ON `papers` (`dedupe_key`);

CREATE INDEX `papers_year_idx` ON `papers` (`year`);

CREATE UNIQUE INDEX research_profile_keywords_unique ON research_profile_keywords (profile_id, value);

CREATE UNIQUE INDEX research_profiles_professor_idx ON research_profiles (professor_id);

