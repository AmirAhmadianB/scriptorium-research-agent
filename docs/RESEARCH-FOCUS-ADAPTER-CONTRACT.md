# Research Focus adapter contract (Change 1)

This documents the seam every dashboard feature adapts through: the
`ResearchProfile` reactive loop built in Pass 1.1–1.5 of
`dashboard-revision-brief.docx`. Read this before adding a new consumer or
a new profile field — both are meant to be small, additive changes that
never touch unrelated code.

## The pieces

- **Schema** — `packages/shared/src/schema.ts`. The one `ResearchProfile`
  Zod shape, imported by both the API (validation + persistence) and the
  dashboard (inline form validation). No discipline/domain literal ever
  belongs here.
- **Store** — `apps/api/src/profile/store.ts`. Validates, normalizes,
  persists (`research_profiles` / `research_profile_keywords` tables),
  reads, versions.
- **Provider** — `apps/api/src/profile/provider.ts`. One access path
  (`getCurrent`, `commit`), emits exactly one `change` event per commit.
- **Registry** — `apps/api/src/profile/registry.ts`. Fans a `change` event
  out to every registered consumer. Each consumer runs
  `select(profile) -> apply(selected)`, isolated (one consumer throwing
  never blocks another) and optionally debounced (`debounceMs`) so bursts
  of edits coalesce to the latest profile instead of piling up.
- **Consumers** — `apps/api/src/profile/consumers/*.ts`. One file per
  feature (search, recommendations, summaries, ...). Each keeps a small
  live-updated cache of whatever view of the profile it needs, so request
  handlers read that cache instead of hitting the DB or re-deriving
  per-request state.

## The `ProfileConsumer` contract

```ts
interface ProfileConsumer<T = unknown> {
  name: string;            // unique; re-registering the same name replaces it
  debounceMs?: number;     // omit for "apply on every commit, immediately"
  select(profile: ResearchProfile): T;   // derive YOUR feature's view — pure, no side effects
  apply(selected: T): void | Promise<void>; // do the side effect (cache it, write it, etc.)
}
```

`select` and `apply` are kept separate on purpose: `select` should be a
pure function you can unit-test with a plain `ResearchProfile` object and
no server running; `apply` is the only place with side effects.

## Recipe: adding a new consumer

1. Create `apps/api/src/profile/consumers/<feature>.ts`.
2. Export a module-level cache (whatever shape your feature needs) plus a
   getter, e.g. `getXFocusKeywords()` — this is what your route/feature
   code reads at request time, NOT the registry or the DB.
3. Export a `ProfileConsumer` object: `select` derives your feature's view
   from `ResearchProfile`; `apply` writes it into the module cache.
4. Register it in `apps/api/src/profile/consumers/index.ts` (add to the
   `consumers` array — the shared `primeAll()` there already handles
   populating it from whatever profile exists at boot, so you don't need
   your own boot-time fetch).
5. Use the getter from step 2 wherever your feature currently reads a
   hardcoded domain constant.
6. Write a unit test with **two contrasting domains** (see any existing
   `consumers/*.test.ts`) proving the SAME function produces different,
   correct output for each — that's what proves no discipline is
   hardcoded, not just that the code compiles.
7. Live-verify: hit the real endpoint with the dev server running, flip
   the Research Focus via `POST /api/research-profile`, confirm the
   feature's output changes with no code change and no reload (see
   `feedback_gate_verification_live_platform` in project memory — a Gate
   requires exercising the live app, not just a green test suite).

You should NOT need to touch `registry.ts`, `provider.ts`, `store.ts`, or
any other consumer's file. If you find yourself editing those, the new
feature probably belongs in its own consumer file instead.

## Recipe: adding a new profile field

1. Add the field to `ResearchProfile` (and `ResearchProfileCommitInput` if
   the client should be able to set it) in
   `packages/shared/src/schema.ts`. Make it optional/nullable — old
   profiles committed before the field existed must keep loading.
2. Add a matching column to `research_profiles` in
   `apps/api/src/db/schema.ts`. **Do not run `drizzle-kit push`** — it has
   a known bug where any schema diff also tries to rewrite the unrelated
   `papers` table's generated `dedupe_key` column and hard-fails (see
   project memory). Hand-apply the column instead:
   `ALTER TABLE research_profiles ADD COLUMN <col> TEXT;` via
   `@libsql/client`, after backing up `data/scriptorium.db`.
3. Also add the column to the hand-maintained DDL mirror in
   `apps/api/test/setup.ts` (`CREATE TABLE research_profiles (...)`) — the
   test suite runs against a throwaway temp DB built from that DDL, not
   `data/scriptorium.db`, so skipping this step passes locally against
   your dev DB but breaks every profile test in CI/a fresh clone with
   `SQLITE_ERROR: no such column`. Found the hard way while proving this
   exact recipe in Pass 1.6.
4. Read/write it in `apps/api/src/profile/store.ts`'s `getProfile` /
   `commitProfile`.
5. Wire it into exactly the ONE consumer that needs it (see the consumer
   recipe above) — a new field should not require touching every
   consumer, only the one that actually uses it.
6. Add a UI control for it in the dashboard (typically
   `apps/dashboard/src/ResearchFocus.tsx` or a small new component), same
   debounced-autosave pattern as the existing keyword editor.
7. Gate: commit a profile WITHOUT the new field (simulating an old
   profile) and confirm it still loads with a sensible default; commit one
   WITH it and confirm only the one wired consumer's behavior changes;
   confirm every other consumer's tests still pass unmodified.

This exact recipe was proven in Pass 1.6 by adding a reserved
`preferredJournals` field end-to-end (schema, DB column, the `search`
consumer's ranking, and a dashboard input), verified live against the
running dev server (round-tripped through the real API, boosted search
ranking without beating an actual keyword match, old profiles kept
loading), confirmed the full test suite stayed green with no other
consumer or test touched, then reverted every change except this
document.

## Empty / DRAFT / ACTIVE

- **Empty** — a professor who has never committed a profile
  (`emptyProfile()` in the shared schema: `version: 0`, no keywords,
  `status: "DRAFT"`). Every consumer must degrade gracefully here (empty
  cache, e.g. `[]` keywords), never crash, never fall back to a hardcoded
  domain.
- **DRAFT** — 1 to `KEYWORD_MIN_FOR_ACTIVE - 1` (currently 4) keywords.
  Consumers still run, just with a small keyword set.
- **ACTIVE** — `KEYWORD_MIN_FOR_ACTIVE` (currently 5) or more keywords.
  `statusForKeywordCount()` in `packages/shared/src/schema.ts` is the only
  place this threshold is defined — change it there, not per-consumer.
