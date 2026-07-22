"""Sprint 6 Pass 2 (A2) — the two non-CLI providers. Both expose the same
`complete(prompt, timeout) -> str` shape claude_cli.complete() already has,
so dispatch.py can call whichever is active without the callers (every
analyze/*.py module) knowing or caring which one ran. Persona prompts are
plain strings already — nothing provider-specific leaks into them."""
from __future__ import annotations

import httpx


class AnthropicProvider:
    """Direct Anthropic API access (the `anthropic` SDK) — the packaged-mode
    default per A2, distinct from claude_cli.py's CLI subprocess path,
    which rides a Claude Code subscription rather than a billed API key."""

    def __init__(self, model: str, api_key: str):
        self.model = model
        self.api_key = api_key

    def complete(self, prompt: str, timeout: int = 180) -> str:
        import anthropic
        client = anthropic.Anthropic(api_key=self.api_key, timeout=timeout)
        resp = client.messages.create(
            model=self.model, max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(block.text for block in resp.content if block.type == "text")
        if not text:
            raise RuntimeError(f"Anthropic response had no text content: {resp.stop_reason!r}")
        return text


class OpenAICompatibleProvider:
    """Generic OpenAI-compatible chat-completions endpoint — covers OpenAI
    itself, Google/other OpenAI-compatible gateways, and local endpoints
    (Ollama, vLLM) per A2. A missing/placeholder key is fine for endpoints
    that don't check one (Ollama)."""

    def __init__(self, model: str, base_url: str, api_key: str | None):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or "not-required"

    def complete(self, prompt: str, timeout: int = 180) -> str:
        r = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}"},
            json={"model": self.model, "messages": [{"role": "user", "content": prompt}]},
            timeout=timeout,
        )
        r.raise_for_status()
        data = r.json()
        try:
            return data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"unexpected OpenAI-compatible response shape: {data!r}") from e
