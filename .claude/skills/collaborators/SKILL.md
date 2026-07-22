---
name: collaborators
description: Find collaboration leads for a topic or professor, with an evidence trail. Use for "who could work with me on X" or "who in the department overlaps with me".
argument-hint: <topic or professor> — internal | external
allowed-tools: Bash, Read
context: fork
agent: collaboration-scout
---
Find collaboration leads for: $ARGUMENTS

1. Decide the lane from the argument (default to both if unspecified, run internal first).
   - Internal: query the corpus for professors whose published/shared work overlaps or complements the topic; exclude `private: true` items.
   - External: query OpenAlex (via `services/ingest` connectors) for authors with topically aligned recent work who are NOT already co-authors of the group.
2. Rank by evidence (shared topics, complementary methods, co-citation, recency), not by name recognition.
3. Present the top leads as: name / affiliation (or professor) — the specific shared work — what each side brings — complementarity vs. redundancy note.
4. Separate "already connected" from "aligned but never connected" and lead with the latter.
5. Be explicit about confidence; mark thin leads as speculative. These are leads for the researcher to evaluate, not endorsements — no contact details are collected.
