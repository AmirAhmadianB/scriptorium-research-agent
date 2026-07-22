---
name: funding
description: Refresh and rank funding opportunities against the current research focus. Use when the user asks what grants are open or what's worth applying to.
argument-hint: [optional filter: national | provincial | international | internal | industry | foundation | closing-soon]
allowed-tools: Bash, Read
context: fork
agent: funding-scout
---
1. `cd services/ingest && python -m scriptorium_ingest.funding.crawl_funding --filter "$ARGUMENTS"`
2. From the resulting table, rank opportunities by (focus-match score × feasibility) and present the top items as: program — sponsor — deadline — typical amount — one-sentence fit rationale — link.
3. Flag anything closing within 30 days at the top.
4. For the single best match, sketch a 5-line application skeleton and offer to run `/proposal` on it.
