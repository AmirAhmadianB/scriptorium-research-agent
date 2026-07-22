"""Sprint 6 Pass 2 (A2) — provider selection and credential storage.

Non-secret provider metadata (name, kind, base URL, model) lives in a plain
JSON file in the data dir — same "no Docker, local files" convention as
everything else here. The actual API key never touches that file, or any
other file on disk: it's stored in and read from the OS credential store
(Windows Credential Manager / macOS Keychain / Linux Secret Service) via
the stdlib-adjacent `keyring` package, keyed by a per-provider reference
name this file generates and stores in providers.json instead of the key
itself.

CLI entrypoint (`python -m scriptorium_ingest.llm.provider_config <cmd>`) is
what apps/api/src/routes/providers.ts calls — the Settings panel never
touches keyring directly; every key enters and leaves this process only,
over stdin (never argv, which can land in shell history/process lists)."""
from __future__ import annotations

import json
import sys
import uuid

import httpx
import keyring

from ..config import DATA_DIR

KEYRING_SERVICE = "scriptorium"
PROVIDERS_JSON = DATA_DIR / "providers.json"
VALID_KINDS = {"claude_cli", "anthropic", "openai_compatible"}


class ProviderConfigError(ValueError):
    pass


def _load() -> dict:
    if not PROVIDERS_JSON.exists():
        return {"active": None, "providers": []}
    with open(PROVIDERS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(state: dict) -> None:
    PROVIDERS_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(PROVIDERS_JSON, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def _redact(p: dict) -> dict:
    """Never send a keyRef-shaped internal detail to the dashboard as if it
    were meaningful — the UI only needs to know a key IS configured."""
    return {**{k: v for k, v in p.items() if k != "keyRef"}, "hasKey": bool(p.get("keyRef"))}


def list_providers() -> dict:
    state = _load()
    return {"active": state["active"], "providers": [_redact(p) for p in state["providers"]]}


def get_provider_raw(name: str) -> dict | None:
    return next((p for p in _load()["providers"] if p["name"] == name), None)


def active_provider_raw() -> dict | None:
    state = _load()
    if not state["active"]:
        return None
    return get_provider_raw(state["active"])


def get_key(key_ref: str) -> str:
    key = keyring.get_password(KEYRING_SERVICE, key_ref)
    if not key:
        raise ProviderConfigError(f"No key stored for keyRef {key_ref!r} — was it removed outside the app?")
    return key


def upsert_provider(name: str, kind: str, model: str, base_url: str | None = None,
                     api_key: str | None = None) -> dict:
    if kind not in VALID_KINDS:
        raise ProviderConfigError(f"kind must be one of {sorted(VALID_KINDS)}, got {kind!r}")
    if kind == "openai_compatible" and not base_url:
        raise ProviderConfigError("baseUrl is required for kind=openai_compatible")
    if not name or not model:
        raise ProviderConfigError("name and model are required")

    state = _load()
    existing = next((p for p in state["providers"] if p["name"] == name), None)
    key_ref = (existing or {}).get("keyRef") or f"{name}-{uuid.uuid4().hex[:8]}"
    if api_key:
        keyring.set_password(KEYRING_SERVICE, key_ref, api_key)
    elif not existing and kind != "claude_cli":
        raise ProviderConfigError(f"an API key is required to add a new {kind} provider")

    entry = {"name": name, "kind": kind, "model": model, "baseUrl": base_url,
              "keyRef": key_ref if (api_key or (existing and existing.get("keyRef"))) else None}
    state["providers"] = [p for p in state["providers"] if p["name"] != name] + [entry]
    _save(state)
    return _redact(entry)


def remove_provider(name: str) -> dict:
    state = _load()
    entry = next((p for p in state["providers"] if p["name"] == name), None)
    if entry is None:
        raise ProviderConfigError(f"no provider named {name!r}")
    if entry.get("keyRef"):
        try:
            keyring.delete_password(KEYRING_SERVICE, entry["keyRef"])
        except keyring.errors.PasswordDeleteError:
            pass  # already gone from the credential store; not a failure to report
    state["providers"] = [p for p in state["providers"] if p["name"] != name]
    if state["active"] == name:
        state["active"] = None
    _save(state)
    return {"removed": True}


def set_active(name: str | None) -> dict:
    state = _load()
    if name is not None and not any(p["name"] == name for p in state["providers"]):
        raise ProviderConfigError(f"no provider named {name!r}")
    state["active"] = name
    _save(state)
    return {"active": name}


def validate_config(kind: str, model: str, base_url: str | None, api_key: str | None,
                     key_ref: str | None, timeout: int = 20) -> dict:
    """A real, live minimal completion call — never a fake "looks right"
    check — against either a not-yet-saved draft (api_key given directly)
    or an already-saved provider (key_ref, looked up via keyring)."""
    key = api_key or (get_key(key_ref) if key_ref else None)
    try:
        if kind == "anthropic":
            import anthropic
            client = anthropic.Anthropic(api_key=key, timeout=timeout)
            client.messages.create(model=model, max_tokens=8, messages=[{"role": "user", "content": "hi"}])
        elif kind == "openai_compatible":
            r = httpx.post(
                f"{base_url.rstrip('/')}/chat/completions",
                headers={"Authorization": f"Bearer {key or 'unused'}"},
                json={"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 8},
                timeout=timeout,
            )
            r.raise_for_status()
        else:
            return {"ok": False, "error": f"kind {kind!r} has nothing to validate against"}
        return {"ok": True, "error": None}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def validate_saved(name: str, timeout: int = 20) -> dict:
    """Re-validate an already-saved provider by name — the dashboard never
    sees a keyRef to pass back in, so re-checking an existing entry (as
    opposed to a not-yet-saved draft) goes through this instead."""
    raw = get_provider_raw(name)
    if raw is None:
        return {"ok": False, "error": f"no provider named {name!r}"}
    return validate_config(raw["kind"], raw["model"], raw.get("baseUrl"), None, raw.get("keyRef"), timeout)


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["list", "upsert", "remove", "activate", "validate", "connection"])
    ap.add_argument("--name", default=None)
    args = ap.parse_args()

    try:
        if args.cmd == "list":
            print(json.dumps(list_providers()))
        elif args.cmd == "connection":
            from .dispatch import current_connection_label
            from ..config import MODE
            print(json.dumps({"label": current_connection_label(), "mode": MODE}))
        elif args.cmd == "upsert":
            payload = json.loads(sys.stdin.read())
            print(json.dumps(upsert_provider(
                payload["name"], payload["kind"], payload["model"],
                payload.get("baseUrl"), payload.get("apiKey"),
            )))
        elif args.cmd == "remove":
            print(json.dumps(remove_provider(args.name)))
        elif args.cmd == "activate":
            print(json.dumps(set_active(None if args.name in (None, "null", "none") else args.name)))
        elif args.cmd == "validate":
            payload = json.loads(sys.stdin.read())
            if payload.get("name"):
                print(json.dumps(validate_saved(payload["name"])))
            else:
                print(json.dumps(validate_config(
                    payload["kind"], payload["model"], payload.get("baseUrl"),
                    payload.get("apiKey"), payload.get("keyRef"),
                )))
    except ProviderConfigError as e:
        # Exit 0 deliberately: this is a normal validation-rejection
        # response, not a process crash — apps/api/src/pythonRunner.ts's
        # sync helper only returns parsed JSON on a clean exit, so a
        # nonzero exit here would bury this structured {"error": ...} body
        # under a generic "Command failed" message instead of surfacing it
        # to the dashboard.
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
