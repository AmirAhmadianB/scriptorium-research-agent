/** Research Focus keyword-entry UI (dashboard-revision-brief.docx, Pass 1.2).
 * First of two ways to set the profile (document upload is Pass 1.3); both
 * write to the same profile via the same store (apps/api/src/profile).
 *
 * DRAFT/ACTIVE status is computed CLIENT-SIDE from the shared threshold
 * (statusForKeywordCount) so the badge flips the instant a keyword is
 * added/removed — no round trip needed to see it. The actual commit to the
 * server is debounced, matching the "live editing, no reload" framing of
 * Change 1 without a network call on every keystroke.
 *
 * No other dashboard element reads from this profile yet — that's Pass
 * 1.5's job, one consumer at a time. This pass only builds the editor. */
import React, { useEffect, useMemo, useState } from "react";
import {
  ProfileKeywordInput, KEYWORD_MIN_FOR_ACTIVE, statusForKeywordCount,
  type ResearchProfile, type KeywordProvenance,
} from "@scriptorium/shared";
import DocumentUpload from "./DocumentUpload.js";
import { emitFocusChanged } from "./focusEvents.js";

type EditableKeyword = { value: string; provenance: KeywordProvenance };

const SAVE_DEBOUNCE_MS = 600;

export default function ResearchFocus() {
  const [loaded, setLoaded] = useState(false);
  const [keywords, setKeywords] = useState<EditableKeyword[]>([]);
  const [focusSynthesis, setFocusSynthesis] = useState<string | null>(null);
  const [draftInput, setDraftInput] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saved" | "error">("idle");

  useEffect(() => {
    fetch("/api/research-profile")
      .then(r => r.json())
      .then((p: ResearchProfile) => {
        setKeywords(p.keywords.map(k => ({ value: k.value, provenance: k.provenance })));
        setFocusSynthesis(p.focusSynthesis);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const status = useMemo(() => statusForKeywordCount(keywords.length), [keywords.length]);

  // Debounced auto-save after the initial load, whenever the local list changes.
  useEffect(() => {
    if (!loaded) return;
    setSaveState("pending");
    const handle = setTimeout(() => {
      fetch("/api/research-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, focusSynthesis }),
      })
        .then(r => { if (!r.ok) throw new Error("save failed"); return r.json(); })
        .then(() => { setSaveState("saved"); emitFocusChanged(); })
        .catch(() => setSaveState("error"));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keywords, loaded]);

  function addKeyword() {
    const trimmed = draftInput.trim();
    const parsed = ProfileKeywordInput.safeParse({ value: trimmed, provenance: "manual" });
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? "Invalid keyword");
      return;
    }
    if (keywords.some(k => k.value.toLowerCase() === parsed.data.value.toLowerCase())) {
      setDraftError("That keyword is already in the list");
      return;
    }
    setKeywords(prev => [...prev, { value: parsed.data.value, provenance: "manual" }]);
    setDraftInput("");
    setDraftError(null);
  }

  function removeKeyword(index: number) {
    setKeywords(prev => prev.filter((_, i) => i !== index));
  }

  function moveKeyword(index: number, dir: -1 | 1) {
    setKeywords(prev => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function updateKeywordValue(index: number, value: string) {
    setKeywords(prev => prev.map((k, i) => (i === index ? { ...k, value } : k)));
  }

  // Pass 1.3: merge a confirmed document-derived proposal into the same
  // profile a manual edit would touch — same store, same debounced commit.
  function mergeDerivedProposal(candidateKeywords: string[], synthesis: string) {
    setKeywords(prev => {
      const existing = new Set(prev.map(k => k.value.toLowerCase()));
      const additions = candidateKeywords
        .filter(k => k.trim() && !existing.has(k.trim().toLowerCase()))
        .map(value => ({ value: value.trim(), provenance: "derived" as const }));
      return [...prev, ...additions];
    });
    if (synthesis) setFocusSynthesis(synthesis);
  }

  if (!loaded) {
    return (
      <section className="panel focus-editor">
        <h2>Research Focus</h2>
        <p className="hint">Loading…</p>
      </section>
    );
  }

  return (
    <section className="panel focus-editor">
      <h2>Research Focus</h2>
      <p className="hint">
        Define the domain by typing keywords below — this is the profile every other feature
        will read from once wired. (Defining it by uploading documents instead comes next.)
      </p>

      <div className="focus-status">
        <span className={"badge " + (status === "ACTIVE" ? "active" : "draft")}>{status}</span>
        <span className="mono">{keywords.length} / {KEYWORD_MIN_FOR_ACTIVE} minimum keywords</span>
        <span className="save-state mono">
          {saveState === "pending" && "saving…"}
          {saveState === "saved" && "saved"}
          {saveState === "error" && "save failed — will retry on next edit"}
        </span>
      </div>

      <ul className="keyword-list">
        {keywords.length === 0 && <li className="empty">No keywords yet — add your first one below.</li>}
        {keywords.map((k, i) => (
          <li key={i} className={k.provenance === "derived" ? "derived" : ""}>
            <input
              value={k.value}
              onChange={e => updateKeywordValue(i, e.target.value)}
              aria-label={`Keyword ${i + 1}`}
            />
            <span className="provenance mono">{k.provenance}</span>
            <button onClick={() => moveKeyword(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button onClick={() => moveKeyword(i, 1)} disabled={i === keywords.length - 1} aria-label="Move down">↓</button>
            <button onClick={() => removeKeyword(i)} aria-label="Remove">✕</button>
          </li>
        ))}
      </ul>

      <div className="keyword-add">
        <input
          value={draftInput}
          onChange={e => { setDraftInput(e.target.value); setDraftError(null); }}
          onKeyDown={e => { if (e.key === "Enter") addKeyword(); }}
          placeholder="Add a keyword…"
          aria-label="New keyword"
        />
        <button onClick={addKeyword}>Add</button>
      </div>
      {draftError && <p className="error">{draftError}</p>}

      {focusSynthesis && (
        <div className="focus-synthesis">
          <p className="proposal-label">Focus synthesis</p>
          <p>{focusSynthesis}</p>
        </div>
      )}

      <hr className="divider" />
      <p className="proposal-label">Or define it by uploading documents (articles, a thesis, reports)</p>
      <DocumentUpload onConfirm={mergeDerivedProposal} />
    </section>
  );
}
