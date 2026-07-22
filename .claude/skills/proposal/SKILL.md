---
name: proposal
description: Draft a grant proposal for a named funder and project, grounded in the professor's own corpus and the funder's evaluation criteria. Use for "help me write the NSERC Alliance proposal".
argument-hint: <funder/program> — <project one-liner>
allowed-tools: Read, Write, Bash, WebFetch
---
Draft a proposal for: $ARGUMENTS

Method — do these in order, don't skip the grounding steps:
1. Pull the funder's real structure: WebFetch the program page from `config/funding.yaml`; extract required sections, page limits, and evaluation criteria verbatim into a checklist.
2. Ground in the group's work: query the corpus (`apps/api` `/api/corpus`, backed by the local SQLite/libSQL database) for the professor's most relevant papers; extract 5–8 citable prior results that establish credibility.
3. Outline against the funder's criteria — every section must answer a named criterion. Show the outline and wait for approval before long-form drafting.
4. Draft with the proposal-writer subagent (deep model per config/models.yaml). Requirements: claims about prior work must cite the corpus; budget/timeline tables as placeholders clearly marked `[[CONFIRM]]`; no invented preliminary data, ever.
5. Save to `drafts/proposals/<funder>-<date>.md` and run a one-pass `/review` on it.
