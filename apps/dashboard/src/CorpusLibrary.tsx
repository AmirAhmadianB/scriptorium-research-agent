/** Pass 2.1 — Corpus tab folder selector. See routes/corpus-library.ts for
 * the file-access-model rationale (browser directory picker -> upload,
 * since this dashboard has no Electron/native-dialog shell). Pass 2.2 adds
 * the analyze/synthesis/ask-the-corpus sections below the picker. */
import React, { useEffect, useRef, useState } from "react";

type LibraryFile = { name: string; sizeBytes: number };
type LibraryStatus = { folderPath: string; fileCount: number; files: LibraryFile[] };
type IngestResult = LibraryStatus & { savedCount: number; rejected: string[]; registered: any; error?: string };

type AnalysisStatus = {
  total: number; analyzed: number; chunked: number; pending: number;
  corpusTotal: number; corpusAnalyzed: number; corpusChunked: number; corpusPending: number;
  synthesis: { synthesisText: string; paperCount: number; updatedAt: string } | null;
};
type AskSource = { paperId: number; paperTitle: string | null; sectionHead: string | null; snippet: string; score: number };
type AskAnswer = { answer: string | null; supported: boolean; notFoundInCorpus: boolean; sources: AskSource[]; reason?: string };

// webkitdirectory isn't in the standard HTMLInputElement typing.
type DirInputProps = React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>
  & { webkitdirectory?: string; directory?: string };

export default function CorpusLibrary() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [selected, setSelected] = useState<File[]>([]);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [askQuery, setAskQuery] = useState("");
  const [askAnswer, setAskAnswer] = useState<AskAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function removeFile(name: string) {
    setRemoving(name);
    try {
      const res = await fetch("/api/corpus/library", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name }),
      });
      const data = await res.json();
      if (res.ok) { setStatus(data); refreshStatus(); }
    } finally {
      setRemoving(null);
    }
  }

  function refreshStatus() {
    fetch("/api/corpus/library").then(r => r.json()).then(setStatus).catch(() => {});
    fetch("/api/corpus/analysis-status").then(r => r.json()).then(setAnalysisStatus).catch(() => {});
  }
  useEffect(refreshStatus, []);

  async function runAnalysis() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch("/api/corpus/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json();
      if (!res.ok) { setAnalyzeError(data.error ?? "Analysis failed"); return; }
      refreshStatus();
    } catch {
      setAnalyzeError("Analysis failed — could not reach the server");
    } finally {
      setAnalyzing(false);
    }
  }

  async function runBackfill() {
    setBackfilling(true);
    setBackfillError(null);
    try {
      // A full-corpus backfill can legitimately take a long time (LLM call
      // per paper) — cap each click to a modest batch so the UI stays
      // responsive; click again to continue where it left off (resumable).
      const res = await fetch("/api/corpus/backfill-analysis", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 10 }),
      });
      const data = await res.json();
      if (!res.ok) { setBackfillError(data.error ?? "Backfill failed"); return; }
      refreshStatus();
    } catch {
      setBackfillError("Backfill failed — could not reach the server");
    } finally {
      setBackfilling(false);
    }
  }

  async function runAsk() {
    if (!askQuery.trim()) return;
    setAsking(true);
    setAskError(null);
    setAskAnswer(null);
    try {
      const res = await fetch(`/api/corpus/ask?q=${encodeURIComponent(askQuery)}`);
      const data = await res.json();
      if (!res.ok) { setAskError(data.error ?? "Search failed"); return; }
      setAskAnswer(data);
    } catch {
      setAskError("Search failed — could not reach the server");
    } finally {
      setAsking(false);
    }
  }

  function onFolderChosen(files: FileList | null) {
    setResult(null);
    setError(null);
    const all = files ? Array.from(files) : [];
    setSelected(all);
    const firstPath = (all[0] as any)?.webkitRelativePath as string | undefined;
    setFolderName(firstPath ? firstPath.split("/")[0] : all.length > 0 ? "(selected files)" : null);
    if (all.length === 0) setError("The selected folder is empty — nothing to ingest.");
  }

  const pdfCount = selected.filter(f => f.name.toLowerCase().endsWith(".pdf")).length;
  const nonPdfCount = selected.length - pdfCount;

  async function ingest() {
    if (selected.length === 0) return;
    setIngesting(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      for (const f of selected) body.append("files", f, f.name);
      const res = await fetch("/api/corpus/library", { method: "POST", body });
      const data: IngestResult = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Ingestion failed");
        return;
      }
      setResult(data);
      setStatus(data);
    } catch {
      setError("Ingestion failed — could not reach the server");
    } finally {
      setIngesting(false);
    }
  }

  const dirProps: DirInputProps = { webkitdirectory: "", directory: "" };

  return (
    <div className="corpus-library">
      <h2>Corpus</h2>
      <p className="hint">
        Point the agentic system at a folder of reference PDFs so it can read them.
        Selecting a folder again re-syncs it (existing files are safely overwritten, not duplicated).
      </p>

      <div className="library-status">
        {status && status.fileCount > 0 ? (
          <>
            <p className="mono">Currently ingested: {status.fileCount} PDF{status.fileCount === 1 ? "" : "s"} in <code>{status.folderPath}</code></p>
            <ul className="library-files">
              {status.files.map(f => (
                <li key={f.name}>
                  <span className="mono">{f.name}</span>
                  <button className="link-btn" onClick={() => removeFile(f.name)} disabled={removing === f.name}>
                    {removing === f.name ? "removing…" : "remove"}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="hint">No PDFs ingested yet.</p>
        )}
      </div>

      <div className="upload-controls">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          {...dirProps}
          onChange={e => onFolderChosen(e.target.files)}
          aria-label="Select a folder of PDFs to ingest"
        />
        <button onClick={ingest} disabled={selected.length === 0 || ingesting || pdfCount === 0}>
          {ingesting ? "Ingesting…" : "Ingest folder"}
        </button>
      </div>

      {folderName && selected.length > 0 && (
        <p className="hint mono">
          Selected "{folderName}": {selected.length} file{selected.length === 1 ? "" : "s"}
          {" "}({pdfCount} PDF{pdfCount === 1 ? "" : "s"}{nonPdfCount > 0 ? `, ${nonPdfCount} non-PDF will be skipped` : ""})
        </p>
      )}

      {error && <p className="error">{error}</p>}

      {result && (
        <div className="ingest-result">
          <p className="hint">
            Saved {result.savedCount} PDF{result.savedCount === 1 ? "" : "s"}.
            {result.rejected.length > 0 && ` Skipped ${result.rejected.length} non-PDF file(s): ${result.rejected.join(", ")}.`}
            {" "}Registered with the corpus: {result.registered?.new ?? 0} new paper{result.registered?.new === 1 ? "" : "s"}.
          </p>
        </div>
      )}

      <hr className="divider" />
      <p className="proposal-label">Deep analysis (Pass 2.2)</p>
      {analysisStatus && (
        <p className="hint mono">
          {analysisStatus.analyzed} of {analysisStatus.total} paper{analysisStatus.total === 1 ? "" : "s"} deep-read
          {analysisStatus.pending > 0 ? ` — ${analysisStatus.pending} pending` : ""}
          {analysisStatus.synthesis && ` · corpus synthesis last updated over ${analysisStatus.synthesis.paperCount} papers`}
        </p>
      )}
      <button onClick={runAnalysis} disabled={analyzing || !analysisStatus || analysisStatus.pending === 0}>
        {analyzing ? "Analyzing…" : "Analyze corpus"}
      </button>
      {analyzeError && <p className="error">{analyzeError}</p>}

      <p className="proposal-label" style={{ marginTop: 14 }}>Full corpus backfill (Sprint 2 — includes scanned literature, not just uploads)</p>
      {analysisStatus && (
        <p className="hint mono">
          {analysisStatus.corpusAnalyzed} analyzed / {analysisStatus.corpusChunked} chunked of {analysisStatus.corpusTotal} fetchable papers
          {analysisStatus.corpusPending > 0 ? ` — ${analysisStatus.corpusPending} pending` : " — up to date"}
        </p>
      )}
      <button onClick={runBackfill} disabled={backfilling || !analysisStatus || analysisStatus.corpusPending === 0}>
        {backfilling ? "Backfilling (10 papers)…" : "Backfill next 10 papers"}
      </button>
      {backfillError && <p className="error">{backfillError}</p>}

      {analysisStatus?.synthesis && (
        <div className="focus-synthesis">
          <p className="proposal-label">Corpus synthesis</p>
          <p>{analysisStatus.synthesis.synthesisText}</p>
        </div>
      )}

      <hr className="divider" />
      <p className="proposal-label">Ask the corpus (grounded, with source attribution)</p>
      <div className="upload-controls">
        <input
          value={askQuery}
          onChange={e => setAskQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") runAsk(); }}
          placeholder="e.g. What methods are used for phase retrieval?"
          aria-label="Ask the corpus"
        />
        <button onClick={runAsk} disabled={asking || !askQuery.trim()}>{asking ? "Searching…" : "Ask"}</button>
      </div>
      {askError && <p className="error">{askError}</p>}
      {askAnswer && (
        <div className="ask-answer">
          {askAnswer.notFoundInCorpus ? (
            <p className="hint">
              {askAnswer.reason ?? askAnswer.answer ?? "Not found in the corpus — the retrieved evidence didn't actually answer this question."}
            </p>
          ) : (
            <>
              <p>{askAnswer.answer}</p>
              {askAnswer.sources.length > 0 && (
                <>
                  <p className="proposal-label">Sources</p>
                  <ul className="ask-results">
                    {askAnswer.sources.map(s => (
                      <li key={`${s.paperId}-${s.sectionHead}`}>
                        <p className="hint mono">{s.paperTitle ?? `paper #${s.paperId}`}{s.sectionHead ? ` · ${s.sectionHead}` : ""} · score {s.score.toFixed(2)}</p>
                        <p>{s.snippet.slice(0, 300)}{s.snippet.length > 300 ? "…" : ""}</p>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
