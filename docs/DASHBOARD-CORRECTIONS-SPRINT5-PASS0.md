# Sprint 5 Dashboard Corrections — Pass 0: Recon

This brief's Passes 0-5 (comments 1-12) are **verbatim identical** to
`dashboard-correction-brief-sprint2.docx`, already fully implemented and
live-Gate-verified earlier this session — see
`docs/DASHBOARD-CORRECTIONS-SPRINT4-PASS0.md`'s Pass 0 map (still current)
and the Sprint 2/3/4 work itself for file-by-file detail. Spot-checked
today: API healthy, no hardcoded focus-banner text anywhere in
`apps/dashboard/src`. **No re-implementation in this pass** — re-doing
already-verified work would itself violate "keep diffs within pass scope."

The only genuinely new item is **Pass 6 / comment 13**: an in-app,
Word-like editable draft surface with a researcher-initiated feedback
loop. This recon covers only what that pass needs.

## Where the drafts table is, and whether it's used
`apps/api/src/db/schema.ts` defines `drafts` (kind, title, professorId,
path, funderProgram, status, updatedAt) — but a repo-wide search found
**zero route or worker references to it**. It was scaffolded early
(original revision brief, Change 3 area) and never wired up. Proposal
drafts today live entirely in `proposal_sessions.state.draftSections`
(raw `[[Title]]`-marker text, Sprint 2 Pass 5) with citation numbering
recomputed fresh on every read via `proposal_orchestrator.py`'s
`_render_citations()`. Per the brief's own instruction ("reuse the drafts
table for persistence"), Pass 6 extends `drafts` — not `state` — since
`state` is a single JSON blob with no native concept of "versions" or
"who authored this," and forcing that into a JSON blob would be exactly
the kind of ad hoc parallel structure the brief warns against.

## Existing document-creation / export stack
The brief assumes one exists ("reusing the existing document-creation
stack already used elsewhere for export"). **A repo-wide search found
none** — `python-docx` is a dependency already, but only ever used to
*read* uploaded `.docx` files (`parse/document_reader.py`'s `_read_docx`,
`research-profile.ts`'s derive-from-upload). No route or worker writes a
`.docx`, and no PDF generation exists anywhere. This is a real gap
between the brief's assumption and this codebase — noted, not silently
worked around: Pass 6 builds the export path fresh, reusing
`python-docx` (already installed, for writing this time) and adding
`reportlab` (pure-Python PDF generation, no external binary/LibreOffice/
Word dependency — this machine happens to have Office installed, but a
COM-automation export would break on any other deployment, which the
"no hardcoded discipline / stay portable" spirit of every prior brief
argues against).

## Current Proposal tab draft rendering (for the editor to replace)
`apps/dashboard/src/ProposalTab.tsx`'s draft section renders
`renderedByKey.get(k)?.text` inside a plain `<p style={{whiteSpace:
"pre-wrap"}}>` — read-only text, no document model, exactly the "raw
textarea / bare contentEditable" the brief rules out as insufficient.
Citations are already `[n]` bracketed numbers (Sprint 2 Pass 5) resolved
from `[[Title]]` markers against a per-session `citablePool`
(`proposal_orchestrator.py`'s `_build_citation_pool`/`_render_citations`)
— Pass 6 must preserve this exact mechanism, not replace it: the editor's
job is to keep `[[Title]]`-equivalent markers as atomic, uncorruptable
nodes while the researcher edits prose around them, and reuse the same
Python renumbering function for the reference list.

## Editor framework choice
TipTap (`@tiptap/react` + `@tiptap/starter-kit`, MIT, actively maintained,
built on ProseMirror) — a real document model with a first-class custom
`Node` type for an atomic citation marker (`atom: true`, holds a
`sourceKey` attr, cannot be split by a text edit), which is exactly what
"citations are atomic nodes, not loose bracket text" requires. Not
installed yet; added in this pass.

## Design (drives the implementation below)
- **Persistence**: extend `drafts` with `proposalSessionId`, `sectionKey`,
  and a live *working copy* (`currentContentJson`, `currentPlainText`,
  `currentVersionNumber`) that autosave continuously updates. A new
  `draft_versions` table holds discrete **checkpoints** only (the initial
  agent-generated draft, and one snapshot per feedback request) — not
  every autosave tick, which would make "version" mean nothing. A new
  `draft_feedback` table holds one row per feedback round: the version it
  reviewed, and a JSON array of span-anchored comments
  (`{quotedText, comment, category, suggestedText, status}}`),
  status starting `pending` and moving to `accepted`/`rejected`/`ignored`
  only on explicit researcher action.
- **Citation-safe editing**: the editor's serializer converts its document
  JSON to the SAME `[[Title]]` marker plain-text format
  `_render_citations()` already consumes — no second citation format,
  no second renumbering algorithm. Numbering shown live in the editor is
  computed client-side by walking citation nodes in document order
  (mirrors the Python function's logic exactly, so the two never
  disagree) for instant feedback with no round-trip.
- **Feedback loop**: `difflib` (stdlib) diffs the current edited text
  against the version being reviewed; the LLM (task `reviewer_critique`,
  already configured for a frontier model in `config/models.yaml`, never
  used until now) receives the diff plus the funder's template/evaluation
  criteria (Pass 4 data, already on the opportunity record) and returns
  structured comments quoting exact spans — resolved to character offsets
  by substring search (LLMs can't give reliable offsets directly; exact-
  quote-then-locate is the standard robust pattern). Comments never
  auto-apply; an optional `suggestedText` can be inserted only via an
  explicit researcher click, which is a normal edit, not an agent
  overwrite.
- **Export**: server-side, Python — one shared "compile the final
  document" function (plan-order sections + resolved citations +
  IEEE reference list) feeds both a `python-docx` writer and a
  `reportlab` writer, so the two output formats can never drift from each
  other or from what's on screen.

No code written in this pass. Proceeding to Pass 6.

## Status: Pass 6 complete

Built: `services/ingest/scriptorium_ingest/analyze/draft_editor.py` (working
copy, versioning, diff-based feedback), `export_proposal.py` (docx via
python-docx, PDF via reportlab — both from one shared `compile_document()`),
`apps/api/src/routes/draft-editor.ts`, and a TipTap-based editor
(`apps/dashboard/src/editor/`: `citationUtils.ts`, `CitationNode.tsx`,
`DraftEditor.tsx`) wired into `ProposalTab.tsx` in place of the old read-only
`<p>`. Schema: `drafts` extended (proposalSessionId/sectionKey/current
working-copy columns), new `draft_versions` (checkpoints only, never every
autosave tick) and `draft_feedback` (span-anchored comments) tables.

Four real bugs found via live Playwright testing and fixed, each with a
regression test or a direct reproduction:
1. **Empty-content risk**: the editor trusted a stored rich-JSON blindly even
   if it didn't match the underlying plain text. Fixed: verifies
   `docToText(contentJson) === plainText` on load, rebuilds from plain text
   on mismatch.
2. **Comment status not visually updating**: accept/reject required a page
   reload to show. Fixed: optimistic update + self-healing refetch on any
   failure.
3. **App-crashing citation bug** (most severe — a full white-screen with no
   error boundary): a raw `sql\`...\`` query in `routes/proposal.ts` bypassed
   Drizzle's JSON deserialization, leaving `authors` as a double-encoded
   string for citations sourced from corpus chunks. Fixed the query,
   backfilled every already-corrupted session's persisted `citablePool`, and
   hardened `formatIEEE()` client-side to never crash on malformed input
   regardless of cause.
4. **Silent autosave failure**: a lone/unpaired UTF-16 surrogate reaching the
   database via the browser's JSON round-trip crashed the SQLite write with
   `UnicodeEncodeError`, while the frontend never checked the response status
   and falsely reported "Saved" anyway. Fixed: `_sanitize_text()` at every
   database write in `draft_editor.py` (never crashes regardless of input),
   and the frontend now honestly shows "Not saved — `<reason>`" instead of
   lying about success.

Live-verified end-to-end multiple times: real edits typed and persisted
across reload, a citation-spanning deletion tested for atomic (never
partial) removal, a real `request-feedback` LLM call returning 6 span-
anchored comments, an "accept" persisting correctly, and a real `.docx`
export containing the live-edited text and an intact References section
(confirmed directly via `python-docx` read-back). 13/13 new Python unit
tests pass (span resolution, working-copy/version-checkpoint distinction,
comment-status validation, Unicode sanitization) alongside the full existing
suite (42/42 Python, 25/25 TS). All test sessions and their draft data
cleaned up.
