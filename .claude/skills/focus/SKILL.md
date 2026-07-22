---
name: focus
description: Set or update the research focus (goal statement, fields, keywords, venues) that drives every scan, trend brief, and funding match. Use when the user wants to change what the system pays attention to.
argument-hint: [new goal / keywords to add or remove]
allowed-tools: Read, Edit, Write, Bash(git diff:*)
---
Update the research focus in `config/focus.yaml`.

1. Read the current `config/focus.yaml`.
2. Interpret the request: $ARGUMENTS
   - A new goal statement replaces `goal`.
   - "add keyword X" / "drop keyword Y" edits `keywords.include` / `keywords.exclude`.
   - Field or venue changes edit the matching lists.
3. Show a compact before/after diff of only the changed keys and ask for confirmation if the change is destructive (goal replacement or removing >2 keywords).
4. Write the file, preserving comments and ordering.
5. Finish by stating the downstream effects: which agents will behave differently on the next `/scan`, `/trends`, and `/funding` run.
