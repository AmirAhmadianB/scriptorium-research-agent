# RD-Agent Extraction — Pass 0: Context and Coupling Map

Source: `microsoft/RD-Agent` (MIT), shallow-cloned to a scratch dir for reading only —
not part of this repo. Six files read in full; two large `oai/backend` files summarized
by a research pass. Findings below drove the actual Pass 1–4 implementation, per the
project's standing rule (established across the dashboard-revision and correction briefs):
**complement existing seams, never duplicate them.**

## 1. `rdagent/core/knowledge_base.py` (27 lines)
`KnowledgeBase`: `path`, `load()`/`dump()` via `dill` pickle. Coupling: only
`rdagent.log.rdagent_logger` (one `logger.warning` call). Trivial to port — swap for
stdlib `logging`.

## 2. `rdagent/components/knowledge_management/vector_base.py` (208 lines)
`KnowledgeMetaData`/`Document`, `VectorBase` (abstract `add`/`search`), `PDVectorBase`
(pandas DataFrame + `scipy.spatial.distance.cosine`, brute-force). Coupling:
`KnowledgeBase`, `rdagent.log`, `rdagent.oai.llm_utils.APIBackend.create_embedding`.

**Overlap finding:** scriptorium already has a real vector store — `papers.embedding` /
`paper_chunks.embedding` (libSQL `F32_BLOB`, native `vector_distance_cos()`), populated by
`analyze/chunking.py` + `analyze/embed.py`, queried by `analyze/corpus_ingest.py` and
`analyze/ask_corpus.py`. Porting `PDVectorBase` as a second paper/chunk store would be
exactly the "parallel store where one exists" defect the correction briefs call out.
**Decision:** `PDVectorBase` is ported, but scoped narrowly as the entity **graph's own
node store** (Pass 1) — a new kind of data (concepts/entities, not papers) that has no
existing table. Paper/chunk semantic search is untouched. Embedding calls route through
`analyze/embed.py`'s `embed_batch`/`embed_query` (already the project's provider — free
local `fastembed` by default, Voyage if `VOYAGE_API_KEY` is set), not a new one.

## 3. `rdagent/components/knowledge_management/graph.py` (497 lines)
`UndirectedNode`, `UndirectedGraph`: `add_node`/`add_nodes`, `get_nodes_within_steps`
(n-hop BFS), `get_nodes_intersection` (the structural-gap primitive the brief calls out),
`semantic_search`, `query_by_content`. Coupling: `VectorBase`/`KnowledgeMetaData` (above),
`KnowledgeBase`, `rdagent.log`, `APIBackend.create_embedding`.

**Overlap finding:** none — nothing like a traversable entity graph exists in this repo.
Genuinely new capability, highest-value piece of this brief. Ported close to verbatim.

## 4. `rdagent/components/document_reader/document_reader.py` (121 lines)
`load_documents_by_langchain` (langchain `PyPDFLoader`/`PyPDFDirectoryLoader`),
Azure Document Intelligence OCR path (`RD_AGENT_SETTINGS.azure_document_intelligence_*`),
`extract_first_page_screenshot_from_pdf` (PyMuPDF).

**Overlap finding:** scriptorium's `parse/document_reader.py` + `parse/pdf_parser.py` is
already **the** shared document reader (dashboard-revision-brief Pass 1.3/2.2 built it on
that exact premise) — PyMuPDF text extraction, heading-based section splitting, caption/
reference extraction, and a **free local Tesseract OCR fallback** for scanned PDFs. RD-
Agent's langchain PDF path and its paid Azure Document Intelligence path both duplicate
this, and Azure reintroduces a paid-cloud dependency this project has deliberately avoided
(no Docker, no provisioning paid keys on the operator's behalf — project memory).
**Decision:** do not port the PDF-loading or Azure paths. Port only
`extract_first_page_screenshot_from_pdf` (genuinely new — a UI thumbnail capability;
reuses the `fitz` dependency already present). Graph ingestion (Pass 2) reuses
`parse.document_reader.read_document()` output and `analyze/chunking.py`'s existing
chunker; it does not re-parse anything.

## 5. `rdagent/oai/backend/base.py` (793 lines) + `litellm.py` (250 lines)
`APIBackend` (ABC, lives in `base.py`): `build_messages_and_create_chat_completion`,
`create_embedding`, `build_messages_and_calculate_token`, a hand-rolled retry loop
(`_try_create_chat_completion_or_embedding`) matching litellm/openai exception types.
`litellm.py` supplies the one concrete subclass, `LiteLLMAPIBackend`: cost via
`litellm.completion_cost()` into a module-global `ACC_COST` accumulator, tokens via
`litellm.token_counter()`, capability probes via `litellm.supports_response_schema()` /
`get_model_info()`. Coupling: `rdagent.log` (pervasively, including a private
`logger._tag` reach-through for per-tag model routing), `rdagent.oai.llm_conf.LLM_SETTINGS`,
`rdagent.core.exception`, `rdagent.core.utils.SingletonBaseClass`/`LLM_CACHE_SEED_GEN`,
`rdagent.oai.utils.embedding.truncate_content_list`, `rdagent.log.timer`.

**Overlap finding / architecture tension:** this project's `claude_cli.py` deliberately
shells out to the local `claude` CLI in headless mode so ingestion workers ride the
operator's existing Claude subscription instead of a **billed** `ANTHROPIC_API_KEY` — a
hard, explicit project constraint. All of `litellm.py`'s cost/token machinery requires
the `litellm` package and real API-shaped responses (usage blocks, `finish_reason`,
provider strings like `"anthropic/claude-..."`) that a CLI subprocess call does not
produce, and there is no real per-call dollar cost to track in a subscription-CLI model —
fabricating one would be dishonest telemetry. **Decision:** do not port `litellm.py`.
Port the *shape* of `APIBackend` as a thin `ClaudeCliBackend` wrapping the existing
`claude_cli.complete()`, with **honest** loop economics instead of fake dollars: call
count, a labeled *character-based token estimate* (no tokenizer access over a CLI),
wall-clock duration, logged per call and accumulated per loop. "Failover" is reframed as
*model* failover (not provider failover — there is only one provider here): on repeated
failure of `task_model(task)`'s configured model, retry once against
`config/models.yaml`'s `default` model, using the routing table that already exists
(`config.py:task_model`) rather than inventing a second one. `JSONParser`'s multi-strategy
JSON-from-LLM-text extraction is self-contained and genuinely useful — every current
call site (`crawl_funding.py`, `proposal_orchestrator.py`, `ask_corpus.py`) hand-rolls the
same ` ```json ` fence strip — so a trimmed version is ported as a small shared utility,
replacing the duplicated logic rather than adding a second convention beside it.

## Path mapping
Brief says `src/knowledge` and `src/llm`. This repo's Python code lives entirely under
`services/ingest/scriptorium_ingest/` (no top-level `src/`), so:
- `src/knowledge` → `services/ingest/scriptorium_ingest/knowledge/`
- `src/llm` → `services/ingest/scriptorium_ingest/llm/`

## Overlap summary table

| RD-Agent piece | Existing scriptorium equivalent | Verdict |
|---|---|---|
| `vector_base.py` (paper-shaped store) | `papers`/`paper_chunks` libSQL vector columns | Do not duplicate; reuse as graph's own node store only |
| `graph.py` | (none) | Port — new capability |
| PDF loading (langchain) | `parse/pdf_parser.py` (PyMuPDF, sections, captions, refs) | Do not port |
| Azure Document Intelligence OCR | `parse/pdf_parser.py`'s free local Tesseract OCR | Do not port (paid, redundant) |
| First-page screenshot | (none) | Port — new capability |
| `litellm.py` cost/token/capability | (none; CLI has no usage metadata) | Do not port; build honest CLI-shaped equivalent |
| `APIBackend` retry loop | `claude_cli.complete()`'s tenacity retry | Reuse existing; add model-level fallback on top |
| `JSONParser` | ad-hoc regex fence-strip repeated in 3+ files | Port as shared utility, replacing the duplication |
| RD-Agent proposal/evaluation/interactor templates | `analyze/proposal_orchestrator.py` (brainstorm_gaps/draft_section, Sprint 1–2) | Extend existing orchestrator with graph-informed propose + judge-critique, not a second proposal system |

No code changes in this pass. Proceeding to Pass 1 (knowledge stores).

## Status: all five passes complete

- **Pass 1** (`knowledge/persistence.py`, `vector_store.py`, `graph.py`, `store.py`): standalone, zero `rdagent.*` imports, per-professor entity graph persisted to `data/knowledge/<professorId>/graph.dill`. Gate: `tests/test_knowledge_store.py` (5/5 passing), including a live `get_nodes_intersection` structural-gap proof.
- **Pass 2** (`knowledge/ingest.py`, `knowledge/screenshot.py`, `parse/pdf_parser.py`'s optional Azure toggle): reuses `library/watch_folder.scan_pdf_folder()` and existing PDF parsing rather than duplicating them; new entity extraction (`config/models.yaml`'s `entity_extraction` task) only runs when a paper has no OpenAlex `concepts`. Live-verified against 3 real corpus papers (21 concepts, correctly deduped/shared across papers, persisted across a process restart).
- **Pass 3** (`llm/backend.py`, `llm/cost.py`, `llm/json_parser.py`): `ClaudeCliBackend` wraps `claude_cli.complete()` with honest (not fabricated) cost/token/duration tracking and same-provider model failover via `config/models.yaml`'s `default`. Live-verified with a real CLI call; failover verified via fast mocked tests (`tests/test_llm_backend.py`, 6/6).
- **Pass 4** (`analyze/proposal_orchestrator.py`'s `_structural_gap_hints`, `critique_draft`, `run_proposal_loop`): R (propose) now folds in graph-derived structural-gap hints alongside the existing LLM brainstorming; D (realize) reuses `draft_section()` verbatim; critique is a new LLM-judge (`eval_judge` task) against three rubrics. Live-verified end-to-end multiple times against real sessions, proving both termination paths (`converged` at threshold=0, `cap_reached` at the iteration limit) and per-loop cost logging. One real bug found and fixed along the way: the API route dropped a `convergenceThreshold: 0` because `if (x)` treats `0` as falsy in JS — fixed to `!= null`. One transient failure (a concurrent global `npm install -g @anthropic-ai/claude-code` briefly took the `claude` CLI off PATH mid-call) was confirmed environmental, not a code defect, by a clean re-run immediately after.

Fast test totals: 23/23 Python (`services/ingest/tests/`), 21/21 TypeScript (`apps/api`). `NOTICE` at `services/ingest/scriptorium_ingest/knowledge/NOTICE` carries the MIT attribution.
