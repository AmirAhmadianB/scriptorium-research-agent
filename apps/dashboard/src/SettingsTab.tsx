/** Sprint 6 Pass 2 (A2) — the Settings panel: "today's implicit direct
 * connection becomes explicit on screen." Add/edit/remove providers, live-
 * validate before or after saving, pick the active one, switch takes
 * effect on the next agent call (no restart — the Python side re-reads
 * providers.json on every call, nothing here or there is cached). */
import React, { useEffect, useState } from "react";
import ProviderSetupForm from "./ProviderSetupForm.js";

type Provider = { name: string; kind: string; model: string; baseUrl: string | null; hasKey: boolean };
type Connection = { label: string; mode: "dev" | "packaged" };
type State = { connection: Connection; active: string | null; providers: Provider[] };

export default function SettingsTab() {
  const [state, setState] = useState<State | null>(null);
  const [adding, setAdding] = useState(false);
  const [validating, setValidating] = useState<string | null>(null); // provider name mid-validate
  const [validation, setValidation] = useState<Record<string, { ok: boolean; error: string | null }>>({});
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch("/api/providers").then(r => r.json()).then(setState).catch(() => setError("Could not reach the server"));
  }
  useEffect(load, []);

  async function validateSaved(name: string) {
    setValidating(name);
    try {
      const res = await fetch("/api/providers/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      const data = await res.json();
      setValidation(v => ({ ...v, [name]: data }));
    } catch {
      setValidation(v => ({ ...v, [name]: { ok: false, error: "Could not reach the server" } }));
    } finally {
      setValidating(null);
    }
  }

  async function activate(name: string) {
    setError(null);
    const res = await fetch(`/api/providers/${encodeURIComponent(name)}/activate`, { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.error) { setError(data.error ?? "Could not activate this provider"); return; }
    load();
  }

  async function deactivate() {
    setError(null);
    await fetch("/api/providers/deactivate", { method: "POST" });
    load();
  }

  async function remove(name: string) {
    setError(null);
    const res = await fetch(`/api/providers/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || data.error) { setError(data.error ?? "Could not remove this provider"); return; }
    load();
  }

  if (!state) return <p className="hint">Loading…</p>;

  return (
    <div className="panel">
      <h2>Settings</h2>

      <p className="proposal-label">Current connection</p>
      <p className="hint mono">{state.connection.label}</p>
      {state.connection.mode === "dev" && (
        <p className="hint">
          Dev mode: agent calls ride the local Claude Code CLI subscription by default. Adding and
          activating a provider below overrides that for testing — same switch packaged installs use.
        </p>
      )}

      <p className="proposal-label" style={{ marginTop: 16 }}>Configured providers</p>
      {state.providers.length === 0 && !adding && (
        <p className="hint">No providers configured yet.</p>
      )}
      <ul className="papers">
        {state.providers.map(p => {
          const v = validation[p.name];
          return (
            <li key={p.name}>
              <span className="title">
                {p.name} {state.active === p.name && <span className="mono">(active)</span>}
              </span>
              <span className="meta">
                {p.kind} · {p.model}{p.baseUrl ? ` · ${p.baseUrl}` : ""} · {p.hasKey ? "key stored" : "no key"}
              </span>
              <div className="upload-controls" style={{ marginTop: 6 }}>
                {state.active !== p.name
                  ? <button onClick={() => activate(p.name)}>Activate</button>
                  : <button onClick={deactivate}>Deactivate</button>}
                <button onClick={() => validateSaved(p.name)} disabled={validating === p.name}>
                  {validating === p.name ? "Testing…" : "Test connection"}
                </button>
                <button className="link-btn" onClick={() => remove(p.name)}>Remove</button>
                {v && (
                  <span className={v.ok ? "hint" : "error"}>
                    {v.ok ? "✓ connection OK" : `✗ ${v.error}`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {!adding && <button style={{ marginTop: 12 }} onClick={() => setAdding(true)}>Add a provider</button>}

      {adding && (
        <div style={{ marginTop: 12 }}>
          <p className="proposal-label">Add a provider</p>
          <ProviderSetupForm
            onSaved={() => { setAdding(false); load(); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {error && !adding && <p className="error">{error}</p>}

      <p className="proposal-label" style={{ marginTop: 16 }}>Support</p>
      <p className="hint">
        A debug bundle includes recent logs and configuration (secrets redacted — provider keys are
        never included, they live in the OS credential store) for troubleshooting.
      </p>
      <a href="/api/debug-bundle" download>
        <button>Download debug bundle</button>
      </a>
    </div>
  );
}
