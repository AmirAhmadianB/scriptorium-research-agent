/** Sprint 2 Pass 3 (comment 7) — crawl-source registry UI. Generic over
 * `purpose` so it's reusable across tabs (mounted on Funding for
 * purpose="funding" and on Literature radar for purpose="literature"),
 * not a funding-specific component with the list bolted on. */
import React, { useEffect, useState } from "react";
import { emitDataChanged } from "./focusEvents.js";

type Source = {
  id: number; url: string; label: string; purpose: string; scope: string | null;
  enabled: boolean; lastCrawledAt: string | null; lastStatus: string;
  lastResultCount: number | null; lastError: string | null;
};

export default function CrawlSourceRegistry({ purpose }: { purpose: "funding" | "literature" }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [crawlingId, setCrawlingId] = useState<number | "all" | null>(null);
  const [crawlMessage, setCrawlMessage] = useState<string | null>(null);

  function refresh() {
    fetch(`/api/crawl-sources?purpose=${purpose}`).then(r => r.json()).then(setSources).catch(() => {});
  }
  useEffect(refresh, [purpose]);

  async function addSource() {
    if (!newUrl.trim() || !newLabel.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/crawl-sources", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: newUrl.trim(), label: newLabel.trim(), purpose }),
      });
      const data = await res.json();
      if (!res.ok) { setAddError(data.error ?? "Could not add source"); return; }
      setNewUrl(""); setNewLabel("");
      refresh();
      emitDataChanged();
    } catch {
      setAddError("Could not reach the server");
    } finally {
      setAdding(false);
    }
  }

  async function toggleEnabled(source: Source) {
    await fetch(`/api/crawl-sources/${source.id}/enabled`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !source.enabled }),
    });
    refresh();
  }

  async function removeSource(id: number) {
    await fetch(`/api/crawl-sources/${id}`, { method: "DELETE" });
    refresh();
  }

  async function crawlOne(id: number) {
    setCrawlingId(id);
    setCrawlMessage(null);
    try {
      const res = await fetch(`/api/crawl-sources/${id}/crawl-now`, { method: "POST" });
      const data = await res.json();
      setCrawlMessage(res.ok ? `Crawled — ${JSON.stringify(data)}`.slice(0, 200) : (data.error ?? "Crawl failed"));
      refresh();
      emitDataChanged();
    } finally {
      setCrawlingId(null);
    }
  }

  async function crawlAll() {
    setCrawlingId("all");
    setCrawlMessage(null);
    try {
      const res = await fetch("/api/crawl-sources/crawl-now", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose }),
      });
      const data = await res.json();
      setCrawlMessage(res.ok ? `Crawled all — ${JSON.stringify(data).slice(0, 200)}` : (data.error ?? "Crawl failed"));
      refresh();
      emitDataChanged();
    } finally {
      setCrawlingId(null);
    }
  }

  return (
    <div className="crawl-registry">
      <div className="velocity-header">
        <p className="proposal-label">Crawled sources ({purpose})</p>
        <button className="link-btn" onClick={crawlAll} disabled={crawlingId !== null}>
          {crawlingId === "all" ? "crawling…" : "crawl all now"}
        </button>
      </div>
      <table className="velocity-table">
        <thead><tr><th>Label</th><th>URL</th><th>Enabled</th><th>Last crawled</th><th>Status</th><th>Results</th><th></th></tr></thead>
        <tbody>
          {sources.map(src => (
            <tr key={src.id}>
              <td>{src.label}</td>
              <td className="mono"><a href={src.url} target="_blank" rel="noreferrer">{src.url.slice(0, 40)}{src.url.length > 40 ? "…" : ""}</a></td>
              <td>
                <label>
                  <input type="checkbox" checked={src.enabled} onChange={() => toggleEnabled(src)} /> {src.enabled ? "on" : "off"}
                </label>
              </td>
              <td className="mono">{src.lastCrawledAt ? new Date(src.lastCrawledAt).toLocaleString() : "never"}</td>
              <td className={src.lastStatus === "error" ? "error" : ""}>{src.lastStatus}{src.lastError ? `: ${src.lastError.slice(0, 60)}` : ""}</td>
              <td className="mono">{src.lastResultCount ?? "—"}</td>
              <td>
                <button className="link-btn" onClick={() => crawlOne(src.id)} disabled={crawlingId !== null}>
                  {crawlingId === src.id ? "…" : "crawl now"}
                </button>
                {" "}
                <button className="link-btn" onClick={() => removeSource(src.id)}>remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {crawlMessage && <p className="hint mono">{crawlMessage}</p>}

      <div className="upload-controls" style={{ marginTop: 10 }}>
        <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label" aria-label="New source label" />
        <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://…" aria-label="New source URL" />
        <button onClick={addSource} disabled={adding || !newUrl.trim() || !newLabel.trim()}>
          {adding ? "Testing + adding…" : "Add source"}
        </button>
      </div>
      {addError && <p className="error">{addError}</p>}
    </div>
  );
}
