"""Sprint 3 Pass 3 — LLM layer. Shaped like RD-Agent's APIBackend (one
entry point, capability detection, token accounting) but NOT a port of
litellm.py: that file's completion_cost()/token_counter()/get_model_info()
all require the `litellm` package and real API-shaped responses (usage
blocks, finish_reason, provider strings) that a CLI subprocess call doesn't
produce, and there is no real per-call dollar cost to report for a
subscription-based CLI call — see docs/RD-AGENT-EXTRACTION-PASS0.md for the
full reasoning.

"Failover" here means MODEL failover (retry once against
config/models.yaml's `default` model), not provider failover in the Sprint
6 Pass 2 sense — this predates the multi-provider layer. Sprint 6 Pass 2:
routes through llm.dispatch.complete() instead of claude_cli.complete()
directly, so this backend (and the researcher-gap convergence loop that
uses it) follows whichever provider Settings has active, same as every
other agent call — it no longer hardcodes the CLI. The context-window
table below is Claude-specific and stops being meaningful once a
non-Anthropic provider is active; see chat_token_limit()'s docstring."""
from __future__ import annotations
import time
from dataclasses import dataclass

from ..llm.dispatch import complete
from ..config import task_model, models as models_config

# Static, hand-maintained context windows for the Claude models this
# project's config/models.yaml routes to by default. There is no dynamic
# model-registry lookup available over a CLI subprocess the way litellm's
# get_model_info() has for direct API calls — this is the honest
# equivalent: known constants, not a queried capability. Sprint 6 Pass 2:
# now potentially wrong once a non-Claude provider is active (an OpenAI-
# compatible endpoint's real context window isn't looked up here) — used
# only for observability/loop-budget purposes, never enforced, so a stale
# estimate degrades gracefully rather than silently miscounting something
# that matters.
MODEL_CONTEXT_WINDOWS = {
    "claude-haiku-4-5-20251001": 200_000,
    "claude-sonnet-4-6": 200_000,
    "claude-opus-4-8": 200_000,
    "claude-fable-5": 200_000,
}
_DEFAULT_CONTEXT_WINDOW = 200_000


def chat_token_limit(model: str) -> int:
    return MODEL_CONTEXT_WINDOWS.get(model, _DEFAULT_CONTEXT_WINDOW)


def supports_response_schema(_model: str) -> bool:
    """Headless `claude -p --output-format json` wraps freeform text in a
    JSON envelope; there is no schema-constrained response mode over this
    CLI path the way a direct API call's response_format has. Honest
    'no', not a guess — every JSON-shaped prompt in this codebase already
    relies on prompt-engineered JSON + JSONParser, not a real schema."""
    return False


def estimate_tokens(text: str) -> int:
    """No tokenizer is reachable over a CLI subprocess — ~4 chars/token is
    the standard rough English-text estimate. Used ONLY for loop-budget /
    observability purposes (Pass 4's convergence cap), never billing —
    there is no per-call bill to estimate."""
    return max(1, len(text) // 4)


@dataclass
class LLMCallResult:
    content: str
    model: str
    fallback_used: bool
    estimated_input_tokens: int
    estimated_output_tokens: int
    duration_seconds: float


class ClaudeCliBackend:
    """One call in, one result out — every field on LLMCallResult is real
    (measured) or explicitly labeled as an estimate; nothing is fabricated
    to look like real API telemetry."""

    def __init__(self, cost_tracker=None):
        self.cost_tracker = cost_tracker

    def complete_for_task(self, prompt: str, task: str, timeout: int = 180) -> LLMCallResult:
        cfg = task_model(task)
        primary_model = cfg["model"]
        fallback_model = models_config()["default"]

        start = time.monotonic()
        fallback_used = False
        try:
            content = complete(prompt, model=primary_model, timeout=timeout)
            model_used = primary_model
        except Exception:
            # Sprint 6 Pass 2: broadened from `except ClaudeCliError` — the
            # active provider can now be Anthropic-SDK or an OpenAI-
            # compatible endpoint, each with its own exception type, and
            # this fallback should trigger on any of them, not just a CLI
            # failure. claude_cli.complete() (still the dev/CLI-kind path)
            # already retried the SAME model up to 4x before raising — this
            # is a second, different model, tried once, not another retry loop.
            if fallback_model == primary_model:
                raise
            content = complete(prompt, model=fallback_model, timeout=timeout)
            model_used = fallback_model
            fallback_used = True
        duration = time.monotonic() - start

        result = LLMCallResult(
            content=content, model=model_used, fallback_used=fallback_used,
            estimated_input_tokens=estimate_tokens(prompt),
            estimated_output_tokens=estimate_tokens(content),
            duration_seconds=duration,
        )
        if self.cost_tracker is not None:
            self.cost_tracker.record(result)
        return result
