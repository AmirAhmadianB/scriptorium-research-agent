---
name: trends
description: Produce a trend brief for the current research focus — what's rising, what's cooling, who's publishing, emergent methods. Use when the user asks what's happening in the field.
argument-hint: [optional subtopic or time window]
allowed-tools: Bash, Read
context: fork
agent: trend-analyst
---
Build a trend brief from the local corpus (not from vibes).

1. `cd services/ingest && python -m scriptorium_ingest.analyze.trends --window $ARGUMENTS` (defaults to `horizon_years` from focus.yaml).
2. The script emits JSON: keyword velocity, new-author entries, venue shifts, citation-burst candidates.
3. Write the brief in three sections — Rising, Steady, Cooling — each item grounded in the counts (say the numbers). End with 2–3 "watch items": weak signals worth a follow-up `/scan` keyword.
4. Save the brief to `docs/briefs/trends-<date>.md` and summarize it in chat.
