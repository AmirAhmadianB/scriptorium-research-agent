"""Sprint 6 Pass 2 (A2) — the one gateway every analyze/*.py module should
import `complete` from instead of claude_cli.py directly (claude_cli.py
itself is untouched — it's now just the implementation of the "claude_cli"
provider kind, called from here exactly as it always was, so its proven
retry/CREATE_NO_WINDOW behavior carries over unchanged).

Same public shape as claude_cli.complete(prompt, model, timeout) on
purpose: every caller's import line is a one-line change
(`from ..claude_cli import complete` -> `from ..llm.dispatch import
complete`), nothing else in any caller changes. For a non-CLI provider the
`model` argument is intentionally NOT forwarded — "per-provider parameters
live in the provider config" (A2): the active provider's own configured
model is what runs, since a Claude model name is meaningless to an
Anthropic-but-different-model or an OpenAI-compatible endpoint."""
from __future__ import annotations

from .. import claude_cli
from ..config import MODE
from . import provider_config
from .providers import AnthropicProvider, OpenAICompatibleProvider


class NoProviderConfiguredError(RuntimeError):
    """Degraded mode (A2): every non-agent feature keeps working; an agent
    call surfaces this specific, actionable message instead of a stack
    trace or a silent wrong answer."""

    def __init__(self):
        super().__init__(
            "No LLM provider is configured. Add one in Settings (Anthropic "
            "key, or an OpenAI-compatible endpoint) to use agent features."
        )


def complete(prompt: str, model: str, timeout: int = 180) -> str:
    cfg = provider_config.active_provider_raw()

    if cfg is None:
        # A2: "Dev mode keeps the CLI as its default transport" — a fresh
        # checkout with no providers.json entry falls straight through to
        # the same behavior every prior sprint had. Packaged mode has no
        # subscription CLI to fall back to, so an unconfigured install is
        # honestly degraded rather than silently trying a CLI that doesn't
        # exist there.
        if MODE == "dev":
            return claude_cli.complete(prompt, model=model, timeout=timeout)
        raise NoProviderConfiguredError()

    if cfg["kind"] == "claude_cli":
        return claude_cli.complete(prompt, model=model, timeout=timeout)
    if cfg["kind"] == "anthropic":
        key = provider_config.get_key(cfg["keyRef"])
        return AnthropicProvider(cfg["model"], key).complete(prompt, timeout=timeout)
    if cfg["kind"] == "openai_compatible":
        key = provider_config.get_key(cfg["keyRef"]) if cfg.get("keyRef") else None
        return OpenAICompatibleProvider(cfg["model"], cfg["baseUrl"], key).complete(prompt, timeout=timeout)

    raise ValueError(f"unknown provider kind {cfg['kind']!r} in providers.json")


def current_connection_label() -> str:
    """What the Settings panel's "current connection" line shows — A2:
    'today's implicit direct connection becomes explicit on screen.'"""
    cfg = provider_config.active_provider_raw()
    if cfg is None:
        return "Claude CLI: founder subscription (dev default)" if MODE == "dev" else "No provider configured"
    if cfg["kind"] == "claude_cli":
        return "Claude CLI: founder subscription"
    return f"{cfg['name']} ({cfg['kind']}, {cfg['model']})"
