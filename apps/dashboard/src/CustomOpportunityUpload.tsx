/** Sprint 4 (C2) — "Add custom opportunity" by file upload, shared between
 * the Proposal tab and the Funding tab (spec: reachable from both). Two
 * steps, same shape as the Research Focus derive-from-upload flow: upload
 * + extract produces an EDITABLE preview (nothing saved yet); a separate
 * confirm writes through the same POST /api/funding a crawled or pasted-
 * text opportunity already uses (source: "user_upload" is the only
 * difference), so it behaves identically downstream. The preview form is
 * also just... a form: no file uploaded at all still works as pure
 * manual entry, per the spec's "doubles as a manual-entry form" line. */
import React, { useState } from "react";
import { emitDataChanged } from "./focusEvents.js";

type ProposalSection = { name: string; guidance: string | null; page_limit: string | null };
type ProposalTemplate = { sections: ProposalSection[]; evaluation_criteria: string[] } | null;

type ExtractedPreview = {
  sourceFileUrl?: string; originalFilename?: string;
  program: string | null; sponsor: string | null; deadline: string | null; deadlineUncertain: boolean;
  amount: string | null; duration: string | null; eligibility: string | null; keywords: string[];
  priorities: string | null; requirements: string | null; proposalTemplate: ProposalTemplate;
  submissionFormat: string | null; extractionError?: string;
};

const EMPTY_PREVIEW: ExtractedPreview = {
  program: null, sponsor: null, deadline: null, deadlineUncertain: false, amount: null, duration: null,
  eligibility: null, keywords: [], priorities: null, requirements: null, proposalTemplate: null, submissionFormat: null,
};

export default function CustomOpportunityUpload({ onSaved }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [sponsorHint, setSponsorHint] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [preview, setPreview] = useState<ExtractedPreview | null>(null);
  const [scope, setScope] = useState("internal");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function extract() {
    setExtracting(true);
    setError(null);
    try {
      if (file) {
        const body = new FormData();
        body.append("file", file);
        body.append("sponsorHint", sponsorHint);
        const res = await fetch("/api/funding/extract-upload", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) { setError(data.error ?? "Could not extract from the file"); return; }
        setPreview(data);
      } else {
        // Spec: "the preview doubles as a manual-entry form when no file
        // is uploaded" — no extraction call at all, just an empty editable form.
        setPreview({ ...EMPTY_PREVIEW, sponsor: sponsorHint || null });
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setExtracting(false);
    }
  }

  async function save() {
    if (!preview || !preview.program?.trim() || !preview.sponsor?.trim()) {
      setError("Program and sponsor are required before saving");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/funding", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          program: preview.program, sponsor: preview.sponsor, url: preview.sourceFileUrl,
          deadline: preview.deadline || null, amount: preview.amount || null, duration: preview.duration || null,
          eligibility: preview.eligibility || null, scope,
          priorities: preview.priorities || null, requirements: preview.requirements || null,
          proposalTemplate: preview.proposalTemplate || null, submissionFormat: preview.submissionFormat || null,
          sourceFileUrl: preview.sourceFileUrl || null, source: "user_upload",
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not save this opportunity"); return; }
      setOpen(false); setFile(null); setSponsorHint(""); setPreview(null); setScope("internal");
      emitDataChanged();
      onSaved?.();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return <button onClick={() => setOpen(true)}>Add custom opportunity</button>;
  }

  return (
    <div className="proposal-session" style={{ marginTop: 8, marginBottom: 8 }}>
      <p className="proposal-label">Add a custom funding opportunity</p>
      <p className="hint">
        Upload the call as a PDF or Word document — internal competitions, direct invitations, or any
        sponsor outside the funding radar's coverage. Extraction will sometimes be wrong; review and edit
        the preview below before saving.
      </p>

      {!preview && (
        <>
          <div className="upload-controls">
            <input type="file" accept=".pdf,.docx" aria-label="Call document"
              onChange={e => setFile(e.target.files?.[0] ?? null)} />
            <input placeholder="Sponsor hint (optional, helps extraction)" value={sponsorHint}
              onChange={e => setSponsorHint(e.target.value)} />
          </div>
          {error && <p className="error">{error}</p>}
          <div className="upload-controls" style={{ marginTop: 8 }}>
            <button onClick={extract} disabled={extracting}>
              {extracting ? "Extracting…" : file ? "Extract" : "Skip upload — enter manually"}
            </button>
            <button className="link-btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}

      {preview && (
        <>
          {preview.extractionError && (
            <p className="error">Extraction failed ({preview.extractionError}) — the file was saved; fill the fields in manually.</p>
          )}
          <div className="upload-controls">
            <input placeholder="Program *" value={preview.program ?? ""} onChange={e => setPreview(p => p && { ...p, program: e.target.value })} />
            <input placeholder="Sponsor *" value={preview.sponsor ?? ""} onChange={e => setPreview(p => p && { ...p, sponsor: e.target.value })} />
            <select value={scope} onChange={e => setScope(e.target.value)} aria-label="Scope">
              {["national", "provincial", "internal", "international", "foundation"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="upload-controls">
            <input placeholder="Deadline (YYYY-MM-DD)" value={preview.deadline ?? ""} onChange={e => setPreview(p => p && { ...p, deadline: e.target.value })} />
            <input placeholder="Amount" value={preview.amount ?? ""} onChange={e => setPreview(p => p && { ...p, amount: e.target.value })} />
            <input placeholder="Duration" value={preview.duration ?? ""} onChange={e => setPreview(p => p && { ...p, duration: e.target.value })} />
          </div>
          <input placeholder="Eligibility" value={preview.eligibility ?? ""}
            onChange={e => setPreview(p => p && { ...p, eligibility: e.target.value })} style={{ width: "100%", marginTop: 8 }} />
          <textarea placeholder="Priorities (the funder's own stated focus)" value={preview.priorities ?? ""}
            onChange={e => setPreview(p => p && { ...p, priorities: e.target.value })} style={{ width: "100%", minHeight: 50, marginTop: 8 }} />
          <textarea placeholder="Requirements (beyond eligibility)" value={preview.requirements ?? ""}
            onChange={e => setPreview(p => p && { ...p, requirements: e.target.value })} style={{ width: "100%", minHeight: 50, marginTop: 8 }} />
          <input placeholder="Submission format" value={preview.submissionFormat ?? ""}
            onChange={e => setPreview(p => p && { ...p, submissionFormat: e.target.value })} style={{ width: "100%", marginTop: 8 }} />
          {preview.proposalTemplate?.sections?.length ? (
            <div className="hint" style={{ marginTop: 8 }}>
              <p><b>Extracted proposal structure</b> (edit by re-extracting; not directly editable here):</p>
              <ul>
                {preview.proposalTemplate.sections.map((sec, i) => (
                  <li key={i}>{sec.name}{sec.page_limit ? ` (${sec.page_limit})` : ""}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="hint" style={{ marginTop: 8 }}>
              No proposal structure extracted — drafting will use a generic fallback outline.
            </p>
          )}
          {preview.sourceFileUrl && (
            <p className="hint mono" style={{ marginTop: 8 }}>
              Original file: <a href={preview.sourceFileUrl} target="_blank" rel="noreferrer">{preview.originalFilename ?? preview.sourceFileUrl}</a>
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <div className="upload-controls" style={{ marginTop: 8 }}>
            <button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save opportunity"}</button>
            <button className="link-btn" onClick={() => { setPreview(null); }}>back</button>
            <button className="link-btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
