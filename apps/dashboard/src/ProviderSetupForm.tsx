/** Sprint 6 Pass 2/4 — the "add a provider" form, extracted out of
 * SettingsTab.tsx so the first-run wizard (Pass 4) can reuse the exact
 * same add/validate/save logic instead of a second, parallel
 * implementation that could drift from it. */
import React, { useState } from "react";

const EMPTY_FORM = { name: "", kind: "anthropic", model: "", baseUrl: "", apiKey: "" };

export default function ProviderSetupForm({ onSaved, onCancel }: { onSaved: () => void; onCancel?: () => void }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function validateDraft() {
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: form.kind, model: form.model,
          baseUrl: form.kind === "openai_compatible" ? form.baseUrl : undefined,
          apiKey: form.apiKey || undefined,
        }),
      });
      setValidation(await res.json());
    } catch {
      setValidation({ ok: false, error: "Could not reach the server" });
    } finally {
      setValidating(false);
    }
  }

  async function save() {
    if (!form.name.trim() || !form.model.trim()) {
      setError("Name and model are required");
      return;
    }
    if (form.kind === "openai_compatible" && !form.baseUrl.trim()) {
      setError("Base URL is required for an OpenAI-compatible endpoint");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/providers", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name, kind: form.kind, model: form.model,
          baseUrl: form.kind === "openai_compatible" ? form.baseUrl : undefined,
          apiKey: form.apiKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) { setError(data.error ?? "Could not save this provider"); return; }
      // Newly-added providers aren't active by default (Sprint 6 Pass 2's
      // own rule — activation is a separate, explicit step) — the wizard's
      // whole point is a working setup, so activate it here.
      await fetch(`/api/providers/${encodeURIComponent(form.name)}/activate`, { method: "POST" });
      onSaved();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="proposal-session">
      <div className="upload-controls">
        <input placeholder="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
        <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value }))} aria-label="Provider kind">
          <option value="anthropic">Anthropic</option>
          <option value="openai_compatible">OpenAI-compatible (OpenAI, Ollama, vLLM, …)</option>
        </select>
        <input placeholder="Model (e.g. claude-sonnet-4-6, gpt-4o, qwen2.5:3b)" value={form.model}
          onChange={e => setForm(f => ({ ...f, model: e.target.value }))} />
      </div>
      {form.kind === "openai_compatible" && (
        <input placeholder="Base URL (e.g. http://localhost:11434/v1)" value={form.baseUrl}
          onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} style={{ width: "100%", marginTop: 8 }} />
      )}
      <input type="password" placeholder="API key" value={form.apiKey}
        onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} style={{ width: "100%", marginTop: 8 }} />
      <p className="hint">
        Stored in the OS credential store (Windows Credential Manager), never in a plaintext config file.
      </p>
      {error && <p className="error">{error}</p>}
      {validation && (
        <p className={validation.ok ? "hint" : "error"}>
          {validation.ok ? "✓ connection OK" : `✗ ${validation.error}`}
        </p>
      )}
      <div className="upload-controls" style={{ marginTop: 8 }}>
        <button onClick={validateDraft} disabled={validating}>{validating ? "Testing…" : "Test connection"}</button>
        <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save provider"}</button>
        {onCancel && <button className="link-btn" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  );
}
