# Sprint 6 Packaging Brief — Pass 2: Multi-LLM Provider Layer

## Built

**Python provider layer** (`services/ingest/scriptorium_ingest/llm/`):
- `providers.py` — `AnthropicProvider` (official `anthropic` SDK) and
  `OpenAICompatibleProvider` (generic `POST {baseUrl}/chat/completions`,
  covers OpenAI, Ollama, vLLM, any OpenAI-shaped gateway), both exposing
  the same `complete(prompt, timeout) -> str` shape.
- `provider_config.py` — non-secret provider metadata (name/kind/model/
  baseUrl) in `DATA_DIR/providers.json`; the actual API key never touches
  that file or any other — it's stored in and read from the OS credential
  store (Windows Credential Manager / macOS Keychain / Linux Secret
  Service) via `keyring`, referenced only by an opaque `keyRef`. A CLI
  entrypoint (`list`/`upsert`/`remove`/`activate`/`validate`/`connection`)
  is what the Node API calls — every payload carrying a real key travels
  over stdin, never argv.
- `dispatch.py` — the new `complete(prompt, model, timeout)`, same public
  shape as `claude_cli.complete()` on purpose. Dev mode with nothing
  configured falls straight through to the CLI (A0's "dev keeps the CLI
  as its default transport"); packaged mode with nothing configured raises
  a clear `NoProviderConfiguredError` instead of trying a CLI that isn't
  there. `claude_cli.py` itself is untouched — it's now simply the
  implementation the `"claude_cli"` provider kind calls.
- Every one of the 9 modules that called `claude_cli.complete()` directly
  (`focus_extractor`, `draft_editor`, `ask_corpus`, `proposal_orchestrator`,
  `paper_analyst`, `knowledge/ingest`, `crawl_funding`, `crawl_literature`,
  plus `llm/backend.py`'s `ClaudeCliBackend`) now imports from
  `llm.dispatch` instead — a one-line change per file, nothing else
  touched, so "persona prompts unchanged" (A2) holds exactly.
  `llm/backend.py`'s except clause was broadened from `ClaudeCliError`
  specifically to `Exception`, since its model-fallback logic needs to
  catch a failure from any of three provider implementations now, not
  just the CLI's own error type.

**Node API** (`apps/api/src/routes/providers.ts`): `GET /api/providers`
(current connection + redacted provider list), `POST /api/providers`
(add/edit), `POST /api/providers/validate` (live test call — a real
completion, not a shape check — against a draft or an already-saved
provider by name), `POST /api/providers/:name/activate`,
`POST /api/providers/deactivate`, `DELETE /api/providers/:name`. Pure
plumbing, same convention as every other route file — all logic lives
Python-side.

**Dashboard** (`apps/dashboard/src/SettingsTab.tsx`, new "Settings" tab):
current-connection banner, configured-provider list with
activate/deactivate/test/remove, an add-provider form with live validation
before save. No key ever round-trips back to the browser after saving —
the list only ever shows `hasKey: true/false`.

## Gate — what's actually proven, live

No paid Anthropic key exists in this environment, so the Anthropic path is
correct by construction and code review but not live-fired. The
OpenAI-compatible path was proven fully live end-to-end against this
machine's local Ollama server (`qwen2.5:3b`), which is the more demanding
proof anyway (it's the generic/unknown-shape path, not a first-party SDK):
- `llm.dispatch.complete()` called directly: activated the Ollama provider,
  passed a Claude model name as the `model` argument, confirmed the
  dispatcher correctly ignored it and used the provider's own configured
  model, got a real generated response back.
- Full HTTP round-trip via `apps/api/src/routes/providers.ts`: add →
  validate → activate → confirm connection label updates → validate again
  → deactivate → confirm reverts to the CLI dev-default label → remove →
  confirm gone from both `providers.json` and the credential store.
- Full browser round-trip via Playwright against the real dashboard: the
  exact same lifecycle, driven through actual DOM clicks, screenshotted at
  the active-provider state, zero console errors.
- Credential storage: a direct `keyring` roundtrip test against this
  machine confirmed the real backend in use is
  `keyring.backends.Windows.WinVaultKeyring` — genuine Windows Credential
  Manager, not a fallback/no-op backend — and `providers.json` was
  inspected directly on disk to confirm it only ever contains an opaque
  `keyRef`, never a key value.
- Degraded mode: dev mode's fallback-to-CLI-with-nothing-configured is
  exercised on every normal dev-server request (that's the default state
  right now). Packaged mode's `NoProviderConfiguredError` path is correct
  by construction (mirrors the same `if cfg is None` branch, just the other
  arm) but wasn't separately fired live in this pass.

All test-created provider entries and credential-store keys were removed
after each verification round — no leftover state in the shared dev DB or
this machine's credential store.

## Tests

12 new Python unit tests (`test_provider_config.py`) cover the pure
CRUD/validation/redaction logic against an isolated `providers.json` with
keyring monkeypatched to an in-memory store — the real keyring integration
and real completion calls were proven live instead (see above), not
re-mocked in the unit suite. 54/54 Python, 28/28 TS, no regressions.

## Known gap, flagged not fixed

`llm/backend.py`'s `MODEL_CONTEXT_WINDOWS` table is Claude-specific and
becomes a stale estimate once a non-Anthropic provider is active — it was
already documented as "used only for observability/loop-budget purposes,
never enforced," so a wrong estimate degrades gracefully rather than
breaking anything, but it's not really correct for e.g. an active Ollama
provider. Not fixed in this pass since it's cosmetic/observability-only;
flagging rather than silently leaving unmentioned.

## Net

Every agent call in the codebase now goes through one seam, provider
selection is genuinely live-switchable with no restart, and no key ever
touches a file on disk. Ready for Pass 3 (sidecar binaries).
