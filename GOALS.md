# /goal conditions for building Scriptorium

/goal (Claude Code ≥ 2.1.139) keeps Claude working until a separate evaluator
confirms a condition from the transcript. These conditions are written to be
mechanically checkable — run them phase by phase, in order, with auto mode on.
Each includes a turn cap; keep it.

## Phase 1 — Foundation runs end to end
/goal `pnpm install` and `pnpm db:push` exit 0 against the local SQLite (libSQL) file, `pnpm --filter @scriptorium/api dev` starts and `curl localhost:8787/api/health` returns {"ok":true}, and `cd services/ingest && pip install -r requirements.txt && python -m scriptorium_ingest.run_scan` completes printing a JSON summary with new_total >= 100. No changes to docs/ or config/ files. Stop after 40 turns.

## Phase 2 — Funding radar live
/goal `python -m scriptorium_ingest.funding.crawl_funding` completes with errors list shorter than 4, the funding_opportunities table has >= 10 rows (prove with a sqlite3 count shown in output), and `curl localhost:8787/api/funding` returns them. Dashboard Funding tab renders the rows (prove with a Playwright screenshot or curl of the built page). Stop after 40 turns.

## Phase 3 — Deep reading cache
/goal For every paper with an oa_url, a PDF is fetched, parsed via PyMuPDF, analyzed by the paper-analyst prompt, and structured_summary is non-null — prove with a sqlite3 count showing >= 90% coverage of oa_url papers and zero rows where structured_summary contains the string "as an AI". Stop after 50 turns.

## Phase 4 — Drafting loop
/goal Running /proposal on the NSERC Alliance entry produces a file in drafts/proposals/ that (a) contains a criteria checklist section, (b) cites >= 5 corpus BibTeX keys that exist in the database (prove by script), (c) contains no bracketed citation key absent from the corpus, and running /review on it produces a referee report file. Stop after 40 turns.

## Phase 5 — Model routing verified
/goal `pnpm eval` exits 0 and eval/report.md exists containing one table row for every model in candidates_for_matrix × every task in tasks.yaml, with no ERROR rows. Stop after 20 turns.

## Everyday operational goals
/goal The literature scan and funding scan both complete and the digest of new items + deadlines within 30 days is posted in the transcript. Stop after 15 turns.
