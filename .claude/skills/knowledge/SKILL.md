---
name: knowledge
description: Manage the corpus's knowledge sources — list what's indexed per professor, connect a new consent-based source, trigger a sync, or audit privacy scoping. Use for "index my Zotero" or "what's in my knowledge base".
argument-hint: list | connect <zotero|mendeley|folder|gdrive|onedrive|sharepoint> <professor> | sync [professor] | audit
allowed-tools: Bash, Read, Edit
agent: knowledge-manager
---
Manage knowledge sources for: $ARGUMENTS

- **list** — show each professor's connected sources, item counts, and how many are private.
- **connect <connector> <professor>** — record a consent-based connector for that professor. Refuse anything that isn't a supported, professor-authorized source; never wire up local-database scraping or a paywalled publisher site (that's a compliance stop, not a preference — point to docs/COMPLIANCE.md). Confirm the professor's own credentials/OAuth are what's being used.
- **sync [professor]** — pull new items from connected sources, dedupe via `dedupe_key`, tag to focus areas, mark private items, and hand off to reference-librarian to regenerate BibTeX. Report the JSON summary.
- **audit** — verify no `private: true` item is reachable from cross-professor search, trends, or collaborator analysis; report any leak.

Always preserve `professor_id` scoping and Canadian data residency. Missing metadata is resolved via Crossref/OpenAlex, never invented.
