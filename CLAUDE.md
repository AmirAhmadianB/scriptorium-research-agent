# Scriptorium — project memory for Claude Code

Research-intelligence + drafting system for university departments.
Read docs/ARCHITECTURE.md once per session before structural changes.

## Mental model
- config/*.yaml is the control plane; code reads it, never hardcodes focus,
  sources, funding targets, or model choices.
- Python (services/ingest) = ingestion & analysis workers. TypeScript
  (apps/api) = read API + Drizzle-owned schema. React (apps/dashboard) = view.
  .claude/skills + .claude/agents = the operator interface.
- SQLite (`data/scriptorium.db`) is the only shared state. Workers upsert via
  dedupe_key; never bypass it.

## Hard rules (compliance — docs/COMPLIANCE.md)
- NEVER add paywalled publisher domains to crawl targets or write code that
  authenticates a crawler through EZproxy/Shibboleth. Subscription full text
  goes through the apis.publisher_tdm block only.
- Professor collections: opt-in connectors only, always scoped to
  professor_id; is_private items stay out of cross-professor queries and
  trends. Preserve these invariants in any query you write.
- Drafting agents never fabricate citations, results, or dates. The
  [[CONFIRM]] / [[CITATION NEEDED]] conventions are load-bearing; keep them.
- collaboration-scout keeps two lanes apart: internal leads come from the
  corpus (private items excluded); external leads come ONLY from public
  scholarly metadata (OpenAlex) — never from anyone's private collection, and
  never scrape contact details. knowledge-manager indexes only sources a
  professor has explicitly connected with their own credentials.

## Conventions
- TS: ESM, strict, tsx for dev; Fastify routes stay thin — logic goes to
  workers or agents. Python: type hints, httpx, tenacity for retries; every
  worker prints a JSON summary as its last line (skills parse it).
- Model choices come from config/models.yaml via config.task_model(); when
  adding an agentic task, add a row there instead of hardcoding a model id.
- Secrets via environment (.env.example lists all); Infisical-friendly.
- No ANTHROPIC_API_KEY is provisioned for this deployment by choice: standalone
  Python/TS workers that need a Claude completion outside an interactive
  session (crawl_funding.py today) call the local `claude` CLI in headless
  print mode (see services/ingest/scriptorium_ingest/claude_cli.py) instead of
  the `anthropic`/`@anthropic-ai/sdk` clients, so they ride the operator's
  existing Claude subscription rather than needing separate billing. Follow
  this pattern for any new worker-side Claude call; only reach for a raw SDK
  client if the user explicitly provides an API key. apps/agents/orchestrator.ts
  already gets this for free via `@anthropic-ai/claude-agent-sdk`, which
  authenticates the same way.

## Ops
- No Docker: `pnpm db:push` (creates `data/scriptorium.db` on first run) →
  `pnpm dev` (API :8787, dashboard :5173). `pnpm scan` / `pnpm funding` run
  workers.
- Nightly automation: cron `npx tsx apps/agents/src/orchestrator.ts "/scan"`,
  or Claude Code scheduled tasks if available in this environment.
- Long build tasks: use /goal with the conditions in GOALS.md; pair with auto
  mode for unattended runs, and keep the turn cap in the condition.
- Optional: connect a SQLite MCP server (`claude mcp add ...`) so corpus
  queries in /proposal and /paper skip the HTTP hop.
