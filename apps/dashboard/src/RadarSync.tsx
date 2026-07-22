/** Sprint 4 (C1) — Literature Radar staleness banner + explicit refresh.
 * Deliberately its own component: it needs to react to focus changes
 * (onFocusChanged) independently of App.tsx's overview refetch, and its
 * own "a run is active" state is what disables the button — not global
 * app state. No auto-refresh on a focus edit: the banner just appears;
 * only an explicit click ever calls POST /api/radar/refresh. */
import React, { useEffect, useState } from "react";
import { onFocusChanged, emitDataChanged } from "./focusEvents.js";

type RadarStatus = {
  currentFocusVersion: number; lastRunFocusVersion: number | null;
  lastRunAt: string | null; stale: boolean; refreshing: boolean;
};

export default function RadarSync() {
  const [status, setStatus] = useState<RadarStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadStatus() {
    fetch("/api/radar/status").then(r => r.json()).then(setStatus).catch(() => {});
  }
  useEffect(() => {
    loadStatus();
    return onFocusChanged(loadStatus);
  }, []);

  async function refresh() {
    if (refreshing || status?.refreshing) return; // second click during an active run: no-op
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/api/radar/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not refresh the radar"); return; }
      setStatus(data);
      // New papers may now exist for the current focus — App.tsx's
      // /api/overview refetch is what makes them show up without a reload.
      emitDataChanged();
    } catch {
      setError("Could not reach the server");
    } finally {
      setRefreshing(false);
    }
  }

  if (!status || !status.stale) return null;

  return (
    <div className="panel span12 radar-stale-banner">
      <p className="hint">
        <b>Research Focus changed since this radar was generated</b> (focus v{status.currentFocusVersion},
        last radar run used v{status.lastRunFocusVersion ?? "—"}). Results below may not reflect your
        current focus.
      </p>
      <button onClick={refresh} disabled={refreshing || status.refreshing}>
        {refreshing || status.refreshing ? "Updating radar…" : "Update radar"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
