# Scriptorium — Architecture

An agentic research-intelligence and drafting system for university departments.
One sentence: **a self-updating map of a field (papers, trends, money) plus a
disciplined writing engine grounded in each professor's own corpus.**

## What it is, positioned against the market

Scriptorium deliberately combines four product categories that exist today only
as separate subscriptions, and adds the piece none of them have — grounding in
the professor's *own* corpus behind the university's walls:

| Category | Who does it commercially | What we take from them |
|---|---|---|
| Literature discovery & QA | Elicit, Consensus, Undermind, SciSpace | Structured extraction over papers; question-driven search |
| Citation/trend mapping | ResearchRabbit, Litmaps, Connected Papers, scite | Graph expansion from seed papers; velocity as signal |
| Funding intelligence | Pivot-RP (ProQuest), Research Professional | Deadline-diffed opportunity records matched to a profile |
| AI grant drafting | Grantable and similar | Criterion-mapped drafting workflow |

The defensible difference is the closed loop: focus config → scan → corpus →
trends → funding match → draft that cites the group's real papers → referee
critique → resubmit. Commercial tools each own one arc segment; none own the loop.

## System diagram

```
                         ┌────────────────────────────────────────┐
   config/*.yaml ───────▶│            CONTROL PLANE               │
   (focus, sources,      │  Claude Code skills: /focus /sources   │
    funding, models)     │  /scan /trends /funding /proposal      │
                         │  /paper /review /test-models           │
                         └───────────────┬────────────────────────┘
                                         │ orchestrates
        ┌────────────────────────────────┼─────────────────────────────┐
        ▼                                ▼                             ▼
┌──────────────────┐        ┌─────────────────────┐        ┌────────────────────┐
│   DATA PLANE     │        │    AGENT PLANE      │        │  DASHBOARD PLANE   │
│ (Python workers) │        │ (.claude/agents/*)  │        │ (Fastify + React)  │
│ OpenAlex Crossref│        │ literature-scout    │        │ epigraph focus     │
│ arXiv  S2  OA    │  ───▶  │ paper-analyst       │  ───▶  │ literature radar   │
│ crawl4ai (open   │        │ trend-analyst       │        │ funding deadlines  │
│  web + funding)  │        │ funding-scout       │        │ agent run log      │
│ PyMuPDF PDF parse│        │ proposal-writer     │        │ corpus search      │
│ Zotero/Mendeley/ │        │ manuscript-writer   │        └────────────────────┘
│  Drive folders   │        │ reference-librarian │
│                  │        │ knowledge-manager   │
│                  │        │ collaboration-scout │
│  PDF-folder sync │        └─────────────────────┘
└────────┬─────────┘                   ▲
         ▼                             │ reads/writes
   ┌───────────────────────────────────┴──────────┐
   │      KNOWLEDGE PLANE — SQLite (libSQL) file     │
   │ papers · funding_opportunities · professors   │
   │ drafts · agent_runs · embeddings (voyage-3)   │
   └───────────────────────────────────────────────┘
```

## The five planes

**Control plane.** All behavior is steered by four YAML files in `config/` —
the answer to "they should be able to change the focus, keywords, or websites."
`focus.yaml` is the research question; `sources.yaml` is where literature comes
from; `funding.yaml` is the money radar; `models.yaml` is which Claude model
runs which job. Professors never touch code: they run `/focus add keyword
"skyrmion imaging"` or edit the YAML in any editor, and every downstream agent
changes behavior on the next run. Per-department deployments are just different
config directories (and later, the `focusOverride` column per professor).

**Data plane.** Structured APIs first, crawler second. OpenAlex is the
workhorse (free, ~250M works, abstracts, citations, OA links); Semantic Scholar
adds TLDRs and recommendations; Crossref repairs metadata; arXiv covers
preprints; Unpaywall resolves legal OA PDFs. crawl4ai handles only the *open*
web — funding pages, lab news, preprint listings — rendering each page to
markdown, after which a pinned Claude prompt does structured extraction (we
intentionally don't depend on crawl4ai's fast-moving extraction API; see
`funding/crawl_funding.py`). Paywalled full text comes exclusively through
publisher TDM APIs with institutional keys — never by crawling subscription
sites. This is a legal constraint, not a stylistic one: **docs/COMPLIANCE.md
is required reading before changing `sources.yaml`.**

**Knowledge plane.** A single libSQL file (`data/scriptorium.db`, plain-SQLite
compatible), schema owned by Drizzle (`apps/api/src/db/schema.ts`). No
background daemon — the DB is just a file, opened directly by the API
(TypeScript, via `@libsql/client`) and by the ingest workers (Python, via
stdlib `sqlite3`), which stay in sync by convention (schema changes flow
through Drizzle first). Deduplication is a generated `dedupe_key` (DOI, else
source:external_id) so every connector can upsert blindly. Papers carry a
`structured_summary` JSON blob — the cached paper-analyst deep read — so
expensive analysis happens once per paper, not once per question. Professor
collections are scoped by `professor_id`, and `is_private` items (unpublished
drafts) are excluded from cross-professor queries and trend statistics by
construction. Embeddings are voyage-3 (1024-d), stored in an `F32_BLOB`
column using libSQL's built-in vector search (`vector_distance_cos`) — no
separate vector extension needed.

**Agent plane.** Nine specialists in `.claude/agents/`, each a persona with a
tool allowlist and a model tier. The division follows the work's economics:
high-volume extraction (funding-scout) runs on Haiku; synthesis and stewardship
(literature-scout, trend-analyst, reference-librarian, knowledge-manager,
collaboration-scout) on Sonnet; anything a human will read as prose or that
requires real scientific judgment (paper-analyst, proposal-writer,
manuscript-writer) inherits the frontier model of the session — Fable 5.
Three of these — manuscript-writer, knowledge-manager, collaboration-scout —
separate concerns that were previously implicit: manuscript-writer targets a
scientific reader and journal conventions rather than a funder's criteria (the
job proposal-writer used to double for); knowledge-manager owns consented
ingestion and privacy scoping across the library connectors; collaboration-scout
proposes internal and external partners on an evidence trail, with a hard wall
between corpus-derived internal overlaps and public-metadata-only external
leads. Anti-fabrication rules live *inside each agent's charter* (never invent
a DOI; `[[CITATION NEEDED]]` over a fake reference; dates without years are
uncertain, not guessed) because grounding enforced at the persona level
survives prompt drift better than a single system-wide plea.

**Dashboard plane.** Fastify serves a thin read API (`/api/overview`,
`/api/corpus`, `/api/funding`, `/api/runs`, semantic search); the Vite/React
front end renders it. The page opens with the group's research goal typeset as
an epigraph — the dashboard literally begins with the question the lab is
asking — followed by the literature radar, deadline board (red is reserved for
sub-30-day deadlines and nothing else), and the agent run log. The dashboard is
a *window*, not a control surface: actions happen through Claude Code skills or
scheduled runs, which keeps the audit trail in `agent_runs`.

## How work actually flows

A professor's Monday: the nightly scheduled `/scan` already ran (via
`apps/agents/orchestrator.ts` on cron, or Claude Code scheduled tasks). She
opens the dashboard, sees three new papers and an NSERC Alliance deadline at
21 days flagged red. She opens Claude Code in the repo and types
`/proposal NSERC Alliance — reflection ptychography for GAA sidewall inspection`.
The skill fetches the live program page, extracts the evaluation criteria into
a checklist, pulls her eight most relevant papers from the corpus, shows her an
outline mapped criterion-by-criterion, and only after her approval hands
long-form drafting to the proposal-writer agent on Fable 5. The draft lands in
`drafts/proposals/` with `[[CONFIRM]]` placeholders where budget numbers
belong, and `/review` immediately attacks it like referee #2.

## Multi-department tenancy (phase 2)

Department = a config directory + a `professors` cohort. The clean path: keep
one database, add `department` scoping to queries, and mount one dashboard per
department config. Authentication should ride the university's SSO (UVic uses
CAS/SAML) in front of the Fastify API; until then the system runs on the lab
network only.

## Build phases (each has a ready `/goal` condition in GOALS.md)

1. **Foundation** — sqlite created, schema pushed, `/scan` populates ≥200 papers.
2. **Funding radar** — crawler covers all `funding.yaml` sources; dashboard
   deadline board live.
3. **Deep reading** — PyMuPDF + paper-analyst caching `structured_summary` for
   every OA PDF in the corpus.
4. **Drafting loop** — `/proposal` and `/paper` produce criterion-mapped drafts
   with corpus citations; `/review` closes the loop.
5. **Hardening** — SSO, per-professor scoping enforced in API, model routing
   re-benchmarked with `/test-models`, deploy (DigitalOcean Toronto keeps data
   residency in Canada, matching the compliance posture in COMPLIANCE.md).
