"""Sprint 3 Pass 3 — honest loop economics. RD-Agent's litellm.py tracks a
real per-call dollar cost via litellm.completion_cost() into a process-wide
global ACC_COST accumulator; a subscription-based CLI call has no such
number (see docs/RD-AGENT-EXTRACTION-PASS0.md) — inventing a dollar figure
would be dishonest telemetry. This tracks what DOES matter for a loop-cap
decision instead: call count, wall-clock time, and a labeled token estimate
— scoped per instance (Pass 4's proposal loop creates one per session), not
a shared process global."""
from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class LoopCostTracker:
    calls: list[dict] = field(default_factory=list)

    def record(self, result) -> None:
        self.calls.append({
            "model": result.model,
            "fallback_used": result.fallback_used,
            "estimated_input_tokens": result.estimated_input_tokens,
            "estimated_output_tokens": result.estimated_output_tokens,
            "duration_seconds": round(result.duration_seconds, 2),
        })

    def summary(self) -> dict:
        return {
            "call_count": len(self.calls),
            "fallback_count": sum(1 for c in self.calls if c["fallback_used"]),
            "estimated_total_tokens": sum(
                c["estimated_input_tokens"] + c["estimated_output_tokens"] for c in self.calls
            ),
            "total_duration_seconds": round(sum(c["duration_seconds"] for c in self.calls), 2),
            # Real number, not a placeholder: a subscription CLI call has no
            # per-call bill. See docs/RD-AGENT-EXTRACTION-PASS0.md.
            "estimated_cost_usd": 0.0,
            "cost_model": "subscription_cli_no_per_call_billing",
        }
