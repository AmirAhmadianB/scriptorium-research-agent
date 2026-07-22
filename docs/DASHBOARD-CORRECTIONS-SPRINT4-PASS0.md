# Sprint 4 Dashboard Corrections — Pass 0: Code Map

No code changes in this pass. Major finding up front: **two of the three corrections
are smaller than the spec assumes**, because their prerequisites already exist from
earlier sprints. Noted inline below; this changes nothing about *what* gets built, only
how much of it is new versus reused.

## Research Focus: storage + update path
- `apps/api/src/db/schema.ts` — `researchProfiles` (id, professorId, focusSynthesis,
  **version** int, **updatedAt** timestamp) + `researchProfileKeywords`.
- `apps/api/src/profile/store.ts` — `commitProfile()` already increments `version` on
  every commit (`nextVersion = existing.version + 1`) and stamps `updatedAt`. **C1's
  "version the focus" ask is already done** — nothing to add to the profile record
  itself.
- `apps/api/src/profile/provider.ts` — `profileProvider.commit()`/`.getCurrent()`, the
  one read/write path; emits a `"change"` event other consumers already listen to.
- `apps/api/src/routes/research-profile.ts` — `GET/POST /api/research-profile`, plus
  `/derive` (upload-driven keyword proposal — already handles multipart PDF/DOCX/TXT/MD
  via `req.files()`, a reusable pattern for C2's upload route).

## Literature Radar tab + the run that populates it
- `apps/dashboard/src/App.tsx` — `tab === "radar"` renders `data.papers` from
  `GET /api/overview` (already focus-ranked client-visible via Sprint 2 Pass 1's
  `rankByFocusRelevance`, but that's a RE-RANK of already-fetched papers, not a new
  discovery run — exactly the gap C1 closes).
- `services/ingest/scriptorium_ingest/run_scan.py` — the actual discovery run: queries
  OpenAlex/Semantic Scholar/arXiv with `current_research_focus_keywords(c)`, upserts new
  papers, `log_run(c, "literature_scan", summary)`. This is the job C1's "Update radar"
  button must re-trigger.
- `apps/api/src/routes/scan.ts` — `POST /api/scan` already wraps `run_scan.py` +
  `crawl_funding.py` together (used by the `/scan` CLI skill). C1 needs a narrower,
  literature-only trigger stamped with the focus version — a new route, not a re-use of
  this one as-is (this one runs funding too, which C1 doesn't ask for and shouldn't
  silently do on a radar-refresh click).
- No existing column stores "which focus version did this run use" — cheapest place to
  add it: embed `focusVersion` in `run_scan.py`'s own `summary` dict (already logged to
  `agent_runs.summary` JSON) rather than a new schema column. Reading the latest
  `literature_scan` run's `summary.focusVersion` and comparing to
  `profileProvider.getCurrent().version` is the whole staleness check.

## Funding opportunity model + Proposal tab's opportunity selector
- `apps/api/src/db/schema.ts` — `fundingOpportunities`: sponsor, program, url, deadline,
  amount, duration, eligibility, keywords, scope, matchScore, contentHash, status,
  **source** (`crawl` | `manual` today — C2 adds `user_upload`), **priorities**,
  **requirements**, **proposalTemplate** (json: `{sections: [{name, guidance,
  page_limit}], evaluation_criteria}` — already the exact shape C2 calls "required
  sections with page limits"). No `submissionFormat` or "link to original file" field
  yet — both new.
- `apps/api/src/routes/server.ts` — `POST /api/funding` (Sprint 2 Pass 4's manual-add)
  already: validates program/sponsor/url, optionally runs pasted `guidelinesText`
  through `crawl_funding.py --extract-text` for priorities/requirements/proposalTemplate,
  writes `source: "manual"`. **C2 is this same route extended to accept a file instead
  of pasted text** — extract the file's text via `parse.document_reader.read_document()`
  (below) then feed the SAME extraction call, not a second extraction pipeline.
- `apps/dashboard/src/ProposalTab.tsx` — the opportunity `<select>` is fed by the
  `fundingOpportunities` prop from `App.tsx`'s `data.funding`
  (`GET /api/overview`, scope-filtered to `config/funding.yaml`'s `default_scopes`).
  Uploaded opportunities need a sane default `scope` (`internal`, already in
  `default_scopes`) so they don't get silently filtered out of the selector.
- `apps/dashboard/src/FundingTab.tsx` — already has an "Add opportunity" form (Sprint 2
  Pass 4) with a `guidelinesText` textarea; C2 adds a file-upload alternative here too
  ("reachable from the Funding tab" — spec's own wording matches this exactly).

## Gap pipeline: agent-proposed gaps
- `services/ingest/scriptorium_ingest/analyze/proposal_orchestrator.py` —
  `brainstorm_gaps()` builds `state.gaps: [{id, gap, citedSources, rationale,
  researcherAnswer, edited?}]`; `confirm_gaps()` marks suitability (+ optional
  `editedGap`, Sprint 2 Pass 5). `draft_section()` reads confirmed gaps from this SAME
  list — whatever gets appended here is already fully wired downstream (drafting,
  critique in Sprint 3 Pass 4).
- **C3 is additive to this one list**, not a parallel structure: a new
  `suggest_gap(session_id, statement, reference_notes)` grounds the researcher's
  statement (vector search + graph query, below) and appends a record shaped exactly
  like an agent-proposed one, with `source: "researcher"` and a `groundingReport`
  field carrying the evidence. Existing gaps get `source: "agent"` retrofitted for
  consistency (the spec's "one gap schema... a source field distinguishes... agent, and
  researcher").
- `apps/api/src/routes/proposal.ts` — `POST /api/proposal/sessions/:id/brainstorm-gaps`,
  `/confirm-gaps`, `/draft-section`, `/auto-critique-loop` (Sprint 3 Pass 4). C3 adds
  `POST /api/proposal/sessions/:id/suggest-gap`.

## Ingestion: existing PDF reader; DOCX parsing
- `services/ingest/scriptorium_ingest/parse/pdf_parser.py` — PyMuPDF extraction,
  heading-based sections, free local Tesseract OCR fallback, and (Sprint 3 Pass 2) an
  optional env-gated Azure Document Intelligence path — this is the "OCR / Azure
  Document Intelligence path behind its env flag" the spec's C2 edge case already wants,
  already built.
- `services/ingest/scriptorium_ingest/parse/document_reader.py` — `read_document(path)`
  dispatches by extension: `.pdf` → `parse_pdf`, **`.docx` → `_read_docx` (python-docx,
  already implemented)**, `.txt`/`.md` → plain text. **C2's "add a DOCX path (mammoth or
  python-docx)" is already done** — the shared reader already produces the same
  `{title, abstract, sections}` shape regardless of source format, which is exactly what
  an extraction prompt needs to consume uniformly.
- `services/ingest/scriptorium_ingest/knowledge/graph.py` /
  `services/ingest/scriptorium_ingest/knowledge/store.py` (Sprint 3) — `UndirectedGraph`,
  `load_graph(professorId)`, `semantic_search`/`query_by_content` — the "query the graph
  for supporting and adjacent work" primitive C3 needs already exists.
- `services/ingest/scriptorium_ingest/analyze/corpus_ingest.py` /
  `analyze/ask_corpus.py` — `query_corpus(question, professorId, k)` already does
  paper-chunk vector search with attribution; C3's "vector-search the corpus" reuses
  this, not a new retrieval path.

## Data flow: focus → radar → funding → gap → draft
1. Researcher edits Research Focus → `profileProvider.commit()` bumps `version`,
   `updatedAt`, fires `"change"` (existing).
2. Literature Radar tab (**C1, new**): compares current version to the last
   `literature_scan` run's stamped `focusVersion`; shows stale banner + "Update radar"
   if they differ; button → new `POST /api/radar/refresh` → `run_scan.py` (existing
   discovery job, now stamping its own summary with the focus version it read) → banner
   clears once the new run's stamp matches.
3. Funding opportunities arrive from three sources into the same table/selector: crawl
   (existing), manual paste (existing, Sprint 2 Pass 4), **file upload (C2, new — same
   route, same extraction call, new input path)**.
4. A proposal session correlates literature + corpus + a chosen funding opportunity
   (existing). Gaps arrive from two sources into the same list: agent-proposed
   (existing) and **researcher-suggested with a grounding report (C3, new)**.
5. `draft_section()` / `run_proposal_loop()` (Sprint 3 Pass 4, unchanged) drafts and
   critiques against whichever confirmed gap + whichever selected opportunity —
   including uploaded ones, once C2 makes their `proposalTemplate`/`priorities` fields
   populated exactly like a crawled opportunity's.

## Build order (per spec)
C1 → C3 → C2, matching the brief's stated reasoning (C1 smallest/isolated, C3 touches
only the gap pipeline, C2 largest — new ingestion path + drafter behavior change — lands
last where an end-to-end pass can absorb the testing).

## Status: all four passes complete

- **Pass 1 / C1** (`apps/api/src/routes/radar.ts`, `RadarSync.tsx`,
  `run_scan.py`'s focus-version stamp): live-verified end-to-end — a real focus commit
  (v52→v53) made the stale banner appear with correct version numbers (confirmed via
  Playwright, zero console errors), and a real `run_scan.py` invocation (307 new papers,
  ~30 min — many keywords × 3 external APIs) correctly stamped `focusVersion: 52` and
  cleared the staleness comparison. Caught and fixed two real bugs along the way: a
  pre-existing `datetime.UTC` AttributeError in `run_scan.py` (unrelated to this sprint,
  blocking the very first live test) and an under-provisioned 5-minute route timeout that
  would have made "Update radar" always fail for a multi-keyword focus (bumped to 45 min).
  4/4 fast unit tests on the pure staleness comparison.
- **Pass 2 / C3** (`suggest_gap()` in `proposal_orchestrator.py`, `/suggest-gap` route,
  "Suggest a gap" UI): live-verified twice — once producing 2 real cited papers with an
  honest `overlapFlag: false`, once (mocked) proving the overlap-flag-true path reports
  a real contradicting paper. Playwright confirmed the grounding report renders correctly
  (8 supporting papers with match %, adjacent graph entities, source badge) with zero
  console errors. 4/4 fast mocked tests.
- **Pass 3 / C2** (`extract_from_file()`, `/api/funding/extract-upload`,
  `CustomOpportunityUpload.tsx`): live-verified with BOTH a real DOCX and a real PDF —
  every field extracted correctly including the exact 3-section proposal structure and
  submission format; saved opportunity appeared in the same selector as crawled ones;
  dedup on sponsor+program+deadline confirmed (re-submit returned the same row id); a
  proposal session against the uploaded opportunity derived the EXACT extracted section
  plan (`project_summary`/`research_plan`/`external_funding_pathway`, not the generic
  fallback); the critique judge's rationale explicitly cited the extracted funder
  priority ("a credible tri-agency application within 24 months"). Playwright confirmed
  the two-step upload UI (present on both Funding and Proposal tabs) with zero console
  errors. 2/2 fast mocked tests plus the existing extraction-pipeline tests.
- **Pass 4**: full regression chain re-run on the ORIGINAL agent-proposed/radar-sourced
  path (brainstorm-gaps → confirm → draft → critique) — all still correct, gaps now
  correctly tagged `source: "agent"`, the generic-fallback section plan still triggers
  for opportunities with no extracted structure. `/api/runs` confirmed every new agent
  run kind (`literature_scan`, `proposal_loop`) carries cost/version data. Confirmed no
  code path auto-fires from a focus commit — every new run in this sprint requires an
  explicit researcher action. One operational incident during final verification: the
  long-running API dev process (alive since well before this sprint, having auto-restarted
  many times via `tsx watch` across three sprints of edits) died between test runs;
  restarted cleanly with zero errors on the very first boot, confirming it was a process-
  age/environment issue, not a defect in this sprint's code — all endpoints and data
  verified intact afterward.

Fast test totals: 29/29 Python (`services/ingest/tests/`), 25/25 TypeScript (`apps/api`).
All test/demo sessions and uploaded test files cleaned up after verification.
