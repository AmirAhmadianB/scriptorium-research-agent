/** Second way to set the Research Focus profile (Pass 1.3, dashboard-
 * revision-brief.docx): upload documents, the system proposes candidate
 * keywords + a focus synthesis, and NOTHING is applied until the researcher
 * reviews and explicitly confirms — this component only ever proposes; the
 * parent (ResearchFocus) is the one that merges into the committed profile,
 * through the exact same store as a manual keyword edit. */
import React, { useRef, useState } from "react";

type Proposal = { keywords: string[]; focusSynthesis: string; errors?: string[] };

const ACCEPTED_EXTENSIONS = ".pdf,.docx,.txt,.md";

export default function DocumentUpload({
  onConfirm,
}: {
  onConfirm: (keywords: string[], focusSynthesis: string) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedNames, setSelectedNames] = useState<string[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [synthesisDraft, setSynthesisDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onFilesChosen(files: FileList | null) {
    setSelectedNames(files ? Array.from(files).map(f => f.name) : []);
    setProposal(null);
    setError(null);
  }

  async function analyze() {
    const files = fileInputRef.current?.files;
    if (!files || files.length === 0) return;
    setAnalyzing(true);
    setError(null);
    setProposal(null);
    try {
      const body = new FormData();
      for (const file of Array.from(files)) body.append("files", file);
      const res = await fetch("/api/research-profile/derive", { method: "POST", body });
      const data: Proposal = await res.json();
      if (!res.ok) {
        setError(data.errors?.join("; ") ?? "Analysis failed");
        return;
      }
      setProposal(data);
      setAccepted(new Set(data.keywords));
      setSynthesisDraft(data.focusSynthesis ?? "");
    } catch {
      setError("Analysis failed — could not reach the server");
    } finally {
      setAnalyzing(false);
    }
  }

  function toggleAccepted(keyword: string) {
    setAccepted(prev => {
      const next = new Set(prev);
      if (next.has(keyword)) next.delete(keyword); else next.add(keyword);
      return next;
    });
  }

  function confirm() {
    if (!proposal) return;
    onConfirm(proposal.keywords.filter(k => accepted.has(k)), synthesisDraft.trim());
    discard();
  }

  function discard() {
    setProposal(null);
    setAccepted(new Set());
    setSynthesisDraft("");
    setSelectedNames([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="upload-block">
      <div className="upload-controls">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS}
          onChange={e => onFilesChosen(e.target.files)}
          aria-label="Upload documents to derive Research Focus"
        />
        <button onClick={analyze} disabled={selectedNames.length === 0 || analyzing}>
          {analyzing ? "Analyzing…" : "Analyze documents"}
        </button>
      </div>
      {selectedNames.length > 0 && !proposal && (
        <p className="hint mono">{selectedNames.join(", ")}</p>
      )}
      {error && <p className="error">{error}</p>}

      {proposal && (
        <div className="proposal">
          <p className="hint">
            Nothing has been applied yet — review below, then confirm to merge into your profile.
          </p>
          {proposal.errors && proposal.errors.length > 0 && (
            <p className="error">{proposal.errors.join("; ")}</p>
          )}

          <label className="proposal-label" htmlFor="synthesis-draft">Focus synthesis (edit freely)</label>
          <textarea
            id="synthesis-draft"
            value={synthesisDraft}
            onChange={e => setSynthesisDraft(e.target.value)}
            rows={4}
          />

          <p className="proposal-label">Candidate keywords (uncheck any you don't want)</p>
          <ul className="proposal-keywords">
            {proposal.keywords.map(k => (
              <li key={k}>
                <label>
                  <input
                    type="checkbox"
                    checked={accepted.has(k)}
                    onChange={() => toggleAccepted(k)}
                  />
                  {k}
                </label>
              </li>
            ))}
            {proposal.keywords.length === 0 && <li className="empty">No candidate keywords derived.</li>}
          </ul>

          <div className="proposal-actions">
            <button onClick={confirm} disabled={accepted.size === 0 && !synthesisDraft.trim()}>
              Confirm &amp; merge into profile
            </button>
            <button className="secondary" onClick={discard}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
