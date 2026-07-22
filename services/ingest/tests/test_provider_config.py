"""Sprint 6 Pass 2 (A2) gate (fast slice): provider CRUD, redaction, and
validation-input-shape logic — all pure/DB-free except for a real (throwaway)
providers.json under conftest.py's isolated SCRIPTORIUM_DATA_DIR, with
keyring monkeypatched to an in-memory dict rather than the real OS
credential store. The real OS credential store (Windows Credential Manager)
and a real Anthropic/OpenAI-compatible completion call were both exercised
manually against this machine's local Ollama endpoint — see
docs/SPRINT6-PASS2.md."""
from __future__ import annotations

import pytest

from scriptorium_ingest.llm import provider_config as pc


@pytest.fixture(autouse=True)
def _isolated_keyring(monkeypatch, tmp_path):
    """Fresh providers.json per test + an in-memory fake credential store,
    so no test run touches the real Windows Credential Manager or leaves
    cross-test state."""
    monkeypatch.setattr(pc, "PROVIDERS_JSON", tmp_path / "providers.json")
    store: dict[tuple[str, str], str] = {}

    class FakeKeyring:
        @staticmethod
        def set_password(service, key, value):
            store[(service, key)] = value

        @staticmethod
        def get_password(service, key):
            return store.get((service, key))

        @staticmethod
        def delete_password(service, key):
            if (service, key) not in store:
                raise pc.keyring.errors.PasswordDeleteError()
            del store[(service, key)]

    monkeypatch.setattr(pc, "keyring", FakeKeyring)
    # errors submodule is accessed as pc.keyring.errors.PasswordDeleteError
    # inside remove_provider(); attach the real errors module so that still
    # resolves against the fake.
    import keyring.errors
    monkeypatch.setattr(FakeKeyring, "errors", keyring.errors, raising=False)
    return store


class TestUpsertAndList:
    def test_new_claude_cli_provider_needs_no_key(self):
        result = pc.upsert_provider("dev-cli", "claude_cli", "claude-sonnet-4-6")
        assert result["hasKey"] is False

    def test_new_non_cli_provider_requires_a_key(self):
        with pytest.raises(pc.ProviderConfigError, match="API key is required"):
            pc.upsert_provider("no-key", "anthropic", "claude-sonnet-4-6")

    def test_new_anthropic_provider_with_key_succeeds_and_never_leaks_it(self):
        result = pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-real-secret")
        assert result["hasKey"] is True
        assert "keyRef" not in result
        assert "sk-real-secret" not in str(result)

    def test_openai_compatible_requires_base_url(self):
        with pytest.raises(pc.ProviderConfigError, match="baseUrl"):
            pc.upsert_provider("ollama", "openai_compatible", "qwen2.5:3b", api_key="unused")

    def test_rejects_unknown_kind(self):
        with pytest.raises(pc.ProviderConfigError, match="kind must be one of"):
            pc.upsert_provider("x", "made_up_kind", "some-model", api_key="k")

    def test_editing_an_existing_provider_without_a_new_key_keeps_the_old_one(self):
        pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-original")
        pc.upsert_provider("prod", "anthropic", "claude-opus-4-8")  # model change only, no apiKey
        raw = pc.get_provider_raw("prod")
        assert raw["model"] == "claude-opus-4-8"
        assert pc.get_key(raw["keyRef"]) == "sk-original"

    def test_list_never_includes_key_ref(self):
        pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-secret")
        listing = pc.list_providers()
        assert listing["providers"][0]["hasKey"] is True
        assert "keyRef" not in listing["providers"][0]


class TestActivateAndRemove:
    def test_activating_an_unknown_provider_fails(self):
        with pytest.raises(pc.ProviderConfigError, match="no provider named"):
            pc.set_active("nonexistent")

    def test_activate_then_deactivate(self):
        pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-secret")
        assert pc.set_active("prod") == {"active": "prod"}
        assert pc.active_provider_raw()["name"] == "prod"
        assert pc.set_active(None) == {"active": None}
        assert pc.active_provider_raw() is None

    def test_removing_the_active_provider_clears_active(self):
        pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-secret")
        pc.set_active("prod")
        pc.remove_provider("prod")
        assert pc._load()["active"] is None

    def test_removing_a_provider_deletes_its_stored_key(self, _isolated_keyring):
        pc.upsert_provider("prod", "anthropic", "claude-sonnet-4-6", api_key="sk-secret")
        raw = pc.get_provider_raw("prod")
        key_ref = raw["keyRef"]
        pc.remove_provider("prod")
        assert (pc.KEYRING_SERVICE, key_ref) not in _isolated_keyring

    def test_removing_unknown_provider_raises(self):
        with pytest.raises(pc.ProviderConfigError, match="no provider named"):
            pc.remove_provider("ghost")
