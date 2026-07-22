/** Sprint 2 Pass 4 (comments 4,5,6,9) — the Funding tab's own component,
 * split out of App.tsx's inline table because this pass adds real state:
 * a dedicated fetch (not the /overview pool, which is scope-filtered and
 * capped at 12 for the dashboard front page), an includeAll scope toggle,
 * per-opportunity extracted-field detail (comment 5), and a manual-add
 * form that writes through the SAME POST /api/funding a crawled opportunity
 * would (comment 6) — see server.ts's route doc for why that's one code
 * path, not two. */
import React, { useEffect, useState } from "react";
import CrawlSourceRegistry from "./CrawlSourceRegistry.js";
import CustomOpportunityUpload from "./CustomOpportunityUpload.js";
import { emitDataChanged, onDataChanged, onFocusChanged } from "./focusEvents.js";

type ProposalSection = { name: string; guidance: string | null; page_limit: string | null };
type ProposalTemplate = { sections: ProposalSection[]; evaluation_criteria: string[] } | null;

type Funding = {
  id: number; program: string; sponsor: string; url: string;
  deadline: string | null; deadlineUncertain: boolean | null;
  amount: string | null; duration: string | null; eligibility: string | null;
  keywords: string[] | null; scope: string | null; source: string | null;
  priorities: string | null; requirements: string | null; proposalTemplate: ProposalTemplate;
  matchScore: number | null; liveMatchScore?: number; isDefaultScope: boolean;
};

const MISSING = <span className="hint mono">missing</span>;

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <p>
      <b>{label}:</b> {value?.trim() ? value : MISSING}
    </p>
  );
}

export default function FundingTab() {
  const [rows, setRows] = useState<Funding[]>([]);
  const [includeAll, setIncludeAll] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [form, setForm] = useState({
    program: "", sponsor: "", url: "", deadline: "", amount: "", duration: "",
    eligibility: "", scope: "national", guidelinesText: "",
  });

  function load() {
    fetch(`/api/funding${includeAll ? "?includeAll=true" : ""}`)
      .then(r => r.json()).then(setRows).catch(() => {});
  }
  useEffect(load, [includeAll]);
  useEffect(() => {
    const offFocus = onFocusChanged(load);
    const offData = onDataChanged(load);
    return () => { offFocus(); offData(); };
  }, [includeAll]);

  const daysTo = (iso: string | null) =>
    iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5) : null;

  async function submitAdd() {
    if (!form.program.trim() || !form.sponsor.trim() || !form.url.trim()) {
      setAddError("program, sponsor, and url are required");
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch("/api/funding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          program: form.program, sponsor: form.sponsor, url: form.url,
          deadline: form.deadline || null, amount: form.amount || null,
          duration: form.duration || null, eligibility: form.eligibility || null,
          scope: form.scope, guidelinesText: form.guidelinesText || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setAddError(data.error ?? "Could not add opportunity"); return; }
      setForm({ program: "", sponsor: "", url: "", deadline: "", amount: "", duration: "",
        eligibility: "", scope: "national", guidelinesText: "" });
      setShowAddForm(false);
      load();
      emitDataChanged();
    } catch {
      setAddError("Could not reach the server");
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <div className="upload-controls" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Open opportunities</h2>
        <div className="upload-controls">
          <label className="hint">
            <input type="checkbox" checked={includeAll} onChange={e => setIncludeAll(e.target.checked)} />
            {" "}Show all scopes (default: {`{`}national, provincial, internal{`}`} — configured in config/funding.yaml)
          </label>
          <button onClick={() => setShowAddForm(s => !s)}>{showAddForm ? "Cancel" : "Add opportunity"}</button>
          {/* Sprint 4 (C2): a separate entry point for the upload flow —
           * distinct from the existing paste-text manual-add above, since
           * they have different input shapes (file vs. pasted text), but
           * both write through the same POST /api/funding underneath. */}
          <CustomOpportunityUpload onSaved={load} />
        </div>
      </div>

      {showAddForm && (
        <div className="proposal-session" style={{ marginTop: 8, marginBottom: 8 }}>
          <p className="proposal-label">Add a funding opportunity manually</p>
          <p className="hint">
            Behaves identically to a crawled entry downstream (match scoring, scope filtering, proposal
            drafting). Paste the funder's guidelines text to extract priorities/requirements/proposal
            structure the same way the crawler does.
          </p>
          <div className="upload-controls">
            <input placeholder="Program *" value={form.program} onChange={e => setForm(f => ({ ...f, program: e.target.value }))} />
            <input placeholder="Sponsor *" value={form.sponsor} onChange={e => setForm(f => ({ ...f, sponsor: e.target.value }))} />
            <input placeholder="URL *" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
          </div>
          <div className="upload-controls">
            <input placeholder="Deadline (YYYY-MM-DD)" value={form.deadline} onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))} />
            <input placeholder="Amount" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
            <input placeholder="Duration" value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} />
            <select value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))} aria-label="Scope">
              {["national", "provincial", "internal", "international", "foundation"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <input placeholder="Eligibility" value={form.eligibility}
            onChange={e => setForm(f => ({ ...f, eligibility: e.target.value }))} style={{ width: "100%", marginTop: 8 }} />
          <textarea placeholder="Paste the funder's guidelines text here (optional, enables extraction)…"
            value={form.guidelinesText} onChange={e => setForm(f => ({ ...f, guidelinesText: e.target.value }))}
            style={{ width: "100%", minHeight: 80, marginTop: 8 }} />
          {addError && <p className="error">{addError}</p>}
          <button onClick={submitAdd} disabled={adding} style={{ marginTop: 8 }}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      )}

      <table>
        <thead><tr><th>Program</th><th>Sponsor</th><th>Deadline</th><th>Amount</th><th>Scope</th><th>Fit</th><th /></tr></thead>
        <tbody>
          {rows.map(f => {
            const d = daysTo(f.deadline);
            const isOpen = expanded === f.id;
            return (
              <React.Fragment key={f.id}>
                <tr className={f.isDefaultScope ? "" : "hint"}>
                  <td><a href={f.url}>{f.program}</a></td>
                  <td>{f.sponsor}</td>
                  <td className={"mono" + (d !== null && d <= 30 ? " red" : "")}>
                    {f.deadline ?? "rolling"}{d !== null ? ` (${d}d)` : ""}
                    {f.deadlineUncertain ? " *" : ""}
                  </td>
                  <td>{f.amount ?? "—"}</td>
                  <td className="mono">{f.scope ?? "national"}{!f.isDefaultScope ? " (out of scope)" : ""}</td>
                  <td className="mono" title="Live relevance to your current Research Focus">
                    {f.liveMatchScore != null ? f.liveMatchScore + "%" : (f.matchScore != null ? f.matchScore + "%" : "—")}
                  </td>
                  <td><button className="link-btn" onClick={() => setExpanded(isOpen ? null : f.id)}>{isOpen ? "hide" : "details"}</button></td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={7}>
                      <div className="proposal-gaps">
                        <p className="hint mono">source: {f.source ?? "crawl"}</p>
                        <Field label="Eligibility" value={f.eligibility} />
                        <Field label="Priorities (funder's own stated focus)" value={f.priorities} />
                        <Field label="Requirements (beyond eligibility)" value={f.requirements} />
                        <p><b>Keywords:</b> {f.keywords?.length ? f.keywords.join(", ") : MISSING}</p>
                        <p><b>Proposal structure:</b></p>
                        {f.proposalTemplate?.sections?.length ? (
                          <ul>
                            {f.proposalTemplate.sections.map((sec, i) => (
                              <li key={i}>
                                <b>{sec.name}</b>{sec.page_limit ? ` (${sec.page_limit})` : ""}
                                {sec.guidance ? <> — {sec.guidance}</> : null}
                              </li>
                            ))}
                            {f.proposalTemplate.evaluation_criteria?.length > 0 && (
                              <li className="hint">Evaluation criteria: {f.proposalTemplate.evaluation_criteria.join("; ")}</li>
                            )}
                          </ul>
                        ) : (
                          <p className="hint">
                            {MISSING} — the funder's page didn't specify a structure; drafting will use a
                            generic fallback outline for this opportunity.
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <hr className="divider" />
      <CrawlSourceRegistry purpose="funding" />
    </>
  );
}
