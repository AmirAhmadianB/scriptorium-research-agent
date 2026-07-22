---
name: paper
description: Draft or extend a research manuscript section (intro, related work, methods, discussion) grounded in the local corpus. Use for "draft the related-work section on X".
argument-hint: <section> — <topic / project> [— target: <journal>]
allowed-tools: Read, Write, Bash
agent: manuscript-writer
---
Draft manuscript content for: $ARGUMENTS

1. Retrieve the 10–20 most relevant corpus papers (semantic search via the API service) and read their stored structured summaries.
2. Build a claims table first: claim → supporting papers → strength of evidence. Show it.
3. Draft the section with the manuscript-writer subagent, following the target journal's structure and reference style when one is named. Hard rules: every non-obvious claim carries a citation key that exists in the corpus; disagreements in the literature are surfaced, not smoothed over; the professor's own results are described from their actual papers, never extrapolated.
4. Output with a BibTeX block for all cited keys. Save to `drafts/manuscripts/`.
5. Close with the three weakest points a referee would attack.
