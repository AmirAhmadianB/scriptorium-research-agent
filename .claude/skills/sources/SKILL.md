---
name: sources
description: Add, remove, or list the databases, APIs, and websites the system reads. Use when the user wants the crawler to watch a new site or stop watching one.
argument-hint: [add <url> | remove <name> | list]
allowed-tools: Read, Edit, Write, WebFetch
---
Manage `config/sources.yaml` (literature) and `config/funding.yaml` (funding).

Rules that must never be violated:
- Refuse to add any domain on `crawl.blocked_domains` or any paywalled publisher site to `crawl.targets`. Explain that subscription content must come through the `apis.publisher_tdm` block with an institutional TDM key instead (see docs/COMPLIANCE.md).
- Before adding a crawl target, WebFetch it once to confirm it's reachable and public, and record a short note of what the page contains.

For: $ARGUMENTS
- `list` → print a readable table of enabled APIs, crawl targets, and funding sources.
- `add` → decide whether the URL is literature or funding, append to the right file with a name and scope, and confirm.
- `remove` → delete the entry and confirm.
