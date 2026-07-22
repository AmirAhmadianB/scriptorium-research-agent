---
name: scan
description: Run a full literature + funding scan now — pull new papers from the APIs, crawl configured pages, refresh funding opportunities, and load everything into the local SQLite (libSQL) database. Use for "check what's new".
allowed-tools: Bash, Read, Grep
context: fork
---
Execute the ingestion pipeline and report what changed.

1. `cd services/ingest && python -m scriptorium_ingest.run_scan`
2. `python -m scriptorium_ingest.funding.crawl_funding`
3. Read the run summary the scripts print (papers found / new / duplicates, funding opps found / new / closing soon).
4. Return a short digest: counts per source, the 5 most focus-relevant new papers (title, venue, one-line why), and any funding deadlines inside 30 days.
5. If a source errored, name it and the error class — don't bury failures in the digest.
