/** Sprint 5 Pass 6 (comment 13) — the Word-like editable draft surface.
 * Replaces ProposalTab.tsx's read-only <p> with a real document model
 * (TipTap/ProseMirror): headings, paragraphs, bold/italic, and atomic
 * citation nodes that survive editing. Autosaves continuously to the
 * working copy; "Request feedback" is the only researcher action that
 * calls the LLM, returning span-anchored comments the researcher accepts,
 * rejects, or ignores — nothing here ever rewrites the draft on its own. */
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { CitationNode, CitationNumberContext } from "./CitationNode.js";
import { textToDoc, docToText, computeNumbering, formatIEEE, citationKey, type JSONNode } from "./citationUtils.js";

type Comment = {
  id: number; quotedText: string; spanStart: number | null; spanEnd: number | null;
  unresolved: boolean; comment: string; category: string; suggestedText: string | null; status: string;
};
type FeedbackRound = { id: number; versionId: number; comments: Comment[]; createdAt: number };
type DraftPayload = {
  draft: { id: number; currentContentJson: JSONNode | null; currentPlainText: string | null; currentVersionNumber: number };
  versions: { versionNumber: number; authorType: string; createdAt: number }[];
  feedbackRounds: FeedbackRound[];
  citablePool: Record<string, any>;
};

const CATEGORY_LABEL: Record<string, string> = {
  clarity: "Clarity", rigor: "Rigor", funder_alignment: "Funder alignment", citation_support: "Citation support",
};

export default function DraftEditor({ sessionId, sectionKey, sectionLabel, priorSectionCitationKeys }: {
  sessionId: number; sectionKey: string; sectionLabel: string; priorSectionCitationKeys: string[];
}) {
  const [payload, setPayload] = useState<DraftPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [requestingFeedback, setRequestingFeedback] = useState(false);
  const [numbers, setNumbers] = useState<Map<string, number>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    extensions: [StarterKit, CitationNode],
    content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    onUpdate: ({ editor: ed }) => {
      const doc = ed.getJSON() as JSONNode;
      setNumbers(computeNumbering(doc, priorSectionCitationKeys));
      scheduleAutosave(doc);
    },
  });

  function scheduleAutosave(doc: JSONNode) {
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const plainText = docToText(doc);
        const res = await fetch(`/api/proposal/sessions/${sessionId}/drafts/${sectionKey}/autosave`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contentJson: doc, plainText }),
        });
        // A failed save must never report "Saved" — a researcher trusting
        // that label while their edit silently didn't persist is worse
        // than an obviously-broken editor (found live: a 400 from bad
        // Unicode in stored text was previously masked exactly this way).
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSaveError(body.error ?? `save failed (HTTP ${res.status})`);
          setSaveState("error");
          return;
        }
        setSaveError(null);
        setSaveState("saved");
      } catch {
        setSaveError("could not reach the server");
        setSaveState("error");
      }
    }, 1500);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/proposal/sessions/${sessionId}/drafts/${sectionKey}`)
      .then(r => r.json())
      .then((data: DraftPayload) => {
        if (cancelled) return;
        setPayload(data);
        const text = data.draft.currentPlainText ?? "";
        // Never trust currentContentJson blindly — if it doesn't actually
        // round-trip back to currentPlainText (a desync from, e.g., a
        // partial/aborted save, or a client bug), currentPlainText is the
        // more fundamental source of truth (it's what citation resolution,
        // diffing, and export all read), so re-derive the doc from it
        // rather than silently rendering stale/empty rich content.
        const storedDoc = data.draft.currentContentJson as JSONNode | null;
        const doc = storedDoc && docToText(storedDoc) === text ? storedDoc : textToDoc(text, data.citablePool);
        editor?.commands.setContent(doc as any, { emitUpdate: false });
        setNumbers(computeNumbering(doc as JSONNode, priorSectionCitationKeys));
      })
      .catch(() => setError("Could not load this draft"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sectionKey, editor]);

  async function requestFeedback() {
    setRequestingFeedback(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${sessionId}/drafts/${sectionKey}/request-feedback`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not get feedback"); return; }
      setPayload(prev => prev && {
        ...prev,
        draft: { ...prev.draft, currentVersionNumber: data.versionNumber },
        feedbackRounds: [...prev.feedbackRounds, { id: data.feedbackId, versionId: data.versionId, comments: data.comments, createdAt: Date.now() / 1000 }],
      });
    } catch {
      setError("Could not reach the server");
    } finally {
      setRequestingFeedback(false);
    }
  }

  async function refetchDraft() {
    try {
      const res = await fetch(`/api/proposal/sessions/${sessionId}/drafts/${sectionKey}`);
      const data: DraftPayload = await res.json();
      if (res.ok) setPayload(data);
    } catch { /* leave payload as-is; the next successful action will resync */ }
  }

  async function setCommentStatus(feedbackId: number, commentId: number, status: string) {
    // Optimistic update first (instant feedback), but verified against the
    // server response — if the request failed for ANY reason (a rejected
    // status, a dropped connection, a dev-server restart mid-flight), a
    // full refetch resyncs to the authoritative state instead of silently
    // leaving the UI stale with no indication anything went wrong.
    setPayload(prev => prev && {
      ...prev,
      feedbackRounds: prev.feedbackRounds.map(fr => fr.id !== feedbackId ? fr : {
        ...fr, comments: fr.comments.map(c => c.id === commentId ? { ...c, status } : c),
      }),
    });
    try {
      const res = await fetch(`/api/proposal/sessions/${sessionId}/drafts/${sectionKey}/feedback/${feedbackId}/comments/${commentId}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
      });
      if (!res.ok) await refetchDraft();
    } catch {
      await refetchDraft();
    }
  }

  function insertSuggestion(comment: Comment) {
    if (!editor || !comment.suggestedText) return;
    const currentText = docToText(editor.getJSON() as JSONNode);
    const idx = currentText.indexOf(comment.quotedText);
    if (idx === -1) return; // the span no longer exists verbatim (already edited) — nothing safe to replace
    const replaced = currentText.slice(0, idx) + comment.suggestedText + currentText.slice(idx + comment.quotedText.length);
    const doc = textToDoc(replaced, payload?.citablePool ?? {});
    editor.commands.setContent(doc as any, { emitUpdate: true });
  }

  const referenceList = useMemo(() => {
    if (!payload) return [];
    return [...numbers.entries()]
      .filter(([key]) => !priorSectionCitationKeys.includes(key))
      .sort((a, b) => a[1] - b[1])
      .map(([key, n]) => ({ n, key, ieee: formatIEEE(n, payload.citablePool[key]) }));
  }, [numbers, payload, priorSectionCitationKeys]);

  const latestFeedback = payload?.feedbackRounds[payload.feedbackRounds.length - 1];
  const pendingComments = latestFeedback?.comments.filter(c => c.status === "pending") ?? [];

  if (loading) return <p className="hint">Loading editor…</p>;

  return (
    <div className="draft-editor">
      <div className="draft-editor-toolbar">
        <p className="proposal-label" style={{ margin: 0 }}>{sectionLabel}</p>
        <span className={"hint mono" + (saveState === "error" ? " error" : "")}>
          {saveState === "saving" ? "Saving…"
            : saveState === "saved" ? "Saved"
            : saveState === "error" ? `Not saved — ${saveError ?? "unknown error"}`
            : ""}
          {payload && ` · version ${payload.draft.currentVersionNumber}`}
        </span>
        <button onClick={requestFeedback} disabled={requestingFeedback}>
          {requestingFeedback ? "Requesting feedback…" : "Request feedback"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {saveState === "error" && (
        <p className="error" style={{ margin: "0 20px" }}>
          Your last edit did not save — keep this text visible/copy it elsewhere before navigating away.
        </p>
      )}

      <CitationNumberContext.Provider value={numbers}>
        <div className="tiptap-surface">
          <EditorContent editor={editor} />
        </div>
      </CitationNumberContext.Provider>

      {referenceList.length > 0 && (
        <div className="proposal-references">
          <p className="proposal-label">References (IEEE, live)</p>
          <ol>
            {referenceList.map(r => <li key={r.key} value={r.n}>{r.ieee.replace(/^\[\d+\]\s*/, "")}</li>)}
          </ol>
        </div>
      )}

      {latestFeedback && (
        <div className="draft-feedback-panel">
          <p className="proposal-label">
            Feedback — round {payload!.feedbackRounds.length}
            {pendingComments.length > 0 && ` (${pendingComments.length} pending)`}
          </p>
          {latestFeedback.comments.length === 0 && <p className="hint">No issues raised — this section looked solid.</p>}
          {latestFeedback.comments.map(c => (
            <div key={c.id} className={"feedback-comment" + (c.status !== "pending" ? " feedback-resolved" : "")}>
              <p className="hint mono">
                {CATEGORY_LABEL[c.category] ?? c.category}
                {c.unresolved && " · span not found in current text"}
              </p>
              <p className="feedback-quote">"{c.quotedText}"</p>
              <p>{c.comment}</p>
              {c.suggestedText && (
                <div className="hint" style={{ marginTop: 4 }}>
                  <b>Suggested:</b> {c.suggestedText}
                </div>
              )}
              {c.status === "pending" ? (
                <div className="upload-controls" style={{ marginTop: 6 }}>
                  {c.suggestedText && (
                    <button className="link-btn" onClick={() => insertSuggestion(c)}>insert suggestion</button>
                  )}
                  <button className="link-btn" onClick={() => setCommentStatus(latestFeedback.id, c.id, "accepted")}>accept</button>
                  <button className="link-btn" onClick={() => setCommentStatus(latestFeedback.id, c.id, "rejected")}>reject</button>
                  <button className="link-btn" onClick={() => setCommentStatus(latestFeedback.id, c.id, "ignored")}>ignore</button>
                </div>
              ) : (
                <p className="hint mono">you marked this: {c.status}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
