/** Pass 3.1 — Proposal Writing tab (Change 3) scaffolding. Human-in-the-
 * loop by construction: nothing in this component fires on mount or on
 * selecting an opportunity — a session (and therefore any context-
 * gathering) is created ONLY when the researcher clicks "Start working on
 * this opportunity". See routes/proposal.ts for the orchestrator/agent-
 * contract design. Pass 3.2 adds gap brainstorming; Pass 3.3 adds
 * step-by-step drafting — both operate on the session this pass creates. */
import React, { useEffect, useState } from "react";
import CustomOpportunityUpload from "./CustomOpportunityUpload.js";
import DraftEditor from "./editor/DraftEditor.js";
import { extractCitationKeysInOrder } from "./editor/citationUtils.js";

type Funding = { id: number; program: string; sponsor: string; deadline: string | null; amount: string | null };

// Sprint 4 (C3) — researcher-suggested gaps carry the same shape as
// agent-proposed ones, plus `source` and (for researcher-suggested ones) a
// grounding report showing what the corpus/graph actually support.
type GroundingReport = {
  supportingPapers: { title: string; score: number; snippet: string }[];
  adjacentWork: { content: string; label: string }[];
  overlapFlag: boolean; overlapExplanation: string;
};
type Gap = {
  id: number; gap: string; citedSources: string[]; rationale: string; researcherAnswer: boolean | null;
  edited?: boolean; source?: "agent" | "researcher"; referenceNotes?: string | null;
  groundingReport?: GroundingReport;
};
type DraftSection = { sectionKey: string; label: string; text: string; revisionCount: number };
// Sprint 2 Pass 4 (comment 9): the section list is per-opportunity now —
// the funder's own proposal structure when Pass 4 extracted one, a generic
// fallback (flagged isFallback) when it didn't. No more hardcoded constant.
type SectionPlan = { order: string[]; labels: Record<string, string>; isFallback: boolean; evaluationCriteria: string[] };
// Sprint 2 Pass 5 (comment 11): draftSections carry raw [[Title]] markers;
// `rendered` is the IEEE-numbered version recomputed fresh after every
// draft/revision — always display THIS, never draftSections[].text directly.
type Reference = { n: number; title: string; ieee: string };
type Rendered = { sections: DraftSection[]; references: Reference[]; unresolvedCitations: string[] };
// Sprint 3 Pass 4 — RD-Agent extraction: propose/draft/critique loop.
type CritiqueIteration = {
  iteration: number; scores: { novelty: number; funderScopeFit: number; testableAims: number };
  overallScore: number; rationale: string; revisionSuggestions: string;
};
type LoopResult = {
  sectionKey: string; iterations: CritiqueIteration[]; terminationReason: "converged" | "cap_reached";
  costSummary: { call_count: number; fallback_count: number; estimated_total_tokens: number;
    total_duration_seconds: number; estimated_cost_usd: number; cost_model: string };
  finalDraft: { text: string; sectionPlan: SectionPlan; rendered: Rendered };
};

type Session = {
  id: number; fundingOpportunityId: number; status: string;
  context: {
    funding: { opportunity: Funding };
    literature: { recentPapers: { id: number; title: string; year: number | null; venue: string | null }[] };
    corpus: { synthesis: string | null; relevantChunks: { paperTitle: string; sectionHead: string | null; snippet: string; score: number }[] };
    researchFocus: { keywords: string[]; focusSynthesis: string | null };
  } | null;
  state: { gaps: Gap[]; draftSections: DraftSection[]; sectionPlan?: SectionPlan; rendered?: Rendered } | null;
  createdAt: string;
};

export default function ProposalTab({ fundingOpportunities }: { fundingOpportunities: Funding[] }) {
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brainstorming, setBrainstorming] = useState(false);
  const [pendingAnswers, setPendingAnswers] = useState<Record<number, boolean>>({});
  const [editingGapId, setEditingGapId] = useState<number | null>(null);
  const [editedGapTexts, setEditedGapTexts] = useState<Record<number, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [gapStatement, setGapStatement] = useState("");
  const [gapReferenceNotes, setGapReferenceNotes] = useState("");
  const [suggestingGap, setSuggestingGap] = useState(false);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [loopRunning, setLoopRunning] = useState<string | null>(null);
  const [loopResults, setLoopResults] = useState<Record<string, LoopResult>>({});

  function loadSessions() {
    fetch("/api/proposal/sessions").then(r => r.json()).then(setSessions).catch(() => {});
  }
  useEffect(loadSessions, []);

  async function start() {
    if (!selectedId) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/proposal/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fundingOpportunityId: selectedId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not start a session"); return; }
      setActiveSession(data);
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setStarting(false);
    }
  }

  async function brainstormGaps() {
    if (!activeSession) return;
    setBrainstorming(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${activeSession.id}/brainstorm-gaps`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not brainstorm gaps"); return; }
      setActiveSession(prev => prev && { ...prev, status: data.status, state: { ...prev.state!, gaps: data.gaps } });
      setPendingAnswers({});
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBrainstorming(false);
    }
  }

  /** Sprint 4 (C3) — usable independent of whether brainstorm-gaps has run:
   * a researcher can suggest their own gap before, after, or instead of
   * clicking "Brainstorm gaps". The response's `gap` record (with its
   * groundingReport) gets appended to the SAME gaps list so it renders
   * through the identical confirm/edit/reject UI below. */
  async function suggestGap() {
    if (!activeSession || !gapStatement.trim()) return;
    setSuggestingGap(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${activeSession.id}/suggest-gap`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statement: gapStatement, referenceNotes: gapReferenceNotes || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not ground this gap"); return; }
      setActiveSession(prev => prev && {
        ...prev, status: data.status,
        state: { ...prev.state!, gaps: [...(prev.state?.gaps ?? []), data.gap] },
      });
      setGapStatement("");
      setGapReferenceNotes("");
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setSuggestingGap(false);
    }
  }

  async function confirmGaps() {
    if (!activeSession) return;
    // Sprint 2 Pass 5 (comment 10): "confirm, edit, or reject" — an edited
    // text (if the researcher opened the editor for that gap) rides along
    // with its suitability answer in the same call.
    const answers = Object.entries(pendingAnswers).map(([id, suitable]) => ({
      id: Number(id), suitable, editedGap: editedGapTexts[Number(id)]?.trim() || undefined,
    }));
    if (answers.length === 0) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${activeSession.id}/confirm-gaps`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not confirm gaps"); return; }
      setActiveSession(prev => prev && {
        ...prev, status: data.status,
        state: { ...prev.state!, gaps: data.gaps, sectionPlan: data.sectionPlan ?? prev.state?.sectionPlan },
      });
      setEditingGapId(null);
      setEditedGapTexts({});
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setConfirming(false);
    }
  }

  async function draftSection(sectionKey: string, feedback?: string) {
    if (!activeSession) return;
    setDrafting(sectionKey);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${activeSession.id}/draft-section`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionKey, feedback }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not draft this section"); return; }
      setActiveSession(prev => {
        if (!prev) return prev;
        const plan: SectionPlan | undefined = data.sectionPlan ?? prev.state?.sectionPlan;
        const sections = (prev.state!.draftSections ?? []).filter(s => s.sectionKey !== sectionKey);
        sections.push({ sectionKey, label: plan?.labels[sectionKey] ?? sectionKey, text: data.text, revisionCount: 0 });
        const rendered: Rendered | undefined = data.rendered ?? prev.state?.rendered;
        return { ...prev, status: data.status, state: { ...prev.state!, draftSections: sections, sectionPlan: plan, rendered } };
      });
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setDrafting(null);
    }
  }

  /** Sprint 3 Pass 4 — RD-Agent extraction: the propose/draft/critique loop.
   * Still fully opt-in (a distinct button, never fired by anything above);
   * runs up to a few rounds of draft+critique automatically, then hands
   * the result back through the SAME draft-section state shape — the
   * existing "give feedback / revise" flow below still works afterward,
   * so this only automates the first refinement rounds, never replaces
   * the researcher's own review. */
  async function runAutoCritiqueLoop(sectionKey: string) {
    if (!activeSession) return;
    setLoopRunning(sectionKey);
    setError(null);
    try {
      const res = await fetch(`/api/proposal/sessions/${activeSession.id}/auto-critique-loop`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionKey, maxIterations: 2, convergenceThreshold: 8.0 }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Could not run the critique loop"); return; }
      setLoopResults(prev => ({ ...prev, [sectionKey]: data }));
      setActiveSession(prev => {
        if (!prev) return prev;
        const plan: SectionPlan | undefined = data.finalDraft?.sectionPlan ?? prev.state?.sectionPlan;
        const sections = (prev.state!.draftSections ?? []).filter(s => s.sectionKey !== sectionKey);
        sections.push({ sectionKey, label: plan?.labels[sectionKey] ?? sectionKey,
          text: data.finalDraft?.text ?? "", revisionCount: 0 });
        const rendered: Rendered | undefined = data.finalDraft?.rendered ?? prev.state?.rendered;
        return { ...prev, status: "drafting", state: { ...prev.state!, draftSections: sections, sectionPlan: plan, rendered } };
      });
      loadSessions();
    } catch {
      setError("Could not reach the server");
    } finally {
      setLoopRunning(null);
    }
  }

  return (
    <div className="proposal-tab">
      <h2>Proposal</h2>
      <p className="hint">
        Correlates the literature radar, your corpus, and a chosen funding opportunity to help
        you write a proposal. Nothing happens — no brainstorming, no drafting — until you
        explicitly start a session for a specific opportunity below.
      </p>

      <div className="upload-controls">
        <select
          value={selectedId}
          onChange={e => setSelectedId(e.target.value ? Number(e.target.value) : "")}
          aria-label="Choose a funding opportunity"
        >
          <option value="">Choose a funding opportunity…</option>
          {fundingOpportunities.map(f => (
            <option key={f.id} value={f.id}>{f.program} — {f.sponsor}</option>
          ))}
        </select>
        <button onClick={start} disabled={!selectedId || starting}>
          {starting ? "Starting…" : "Start working on this opportunity"}
        </button>
      </div>
      {/* Sprint 4 (C2): "reachable from the Funding tab" (already true via
       * FundingTab.tsx) AND directly here — a researcher targeting an
       * opportunity the radar never surfaced shouldn't have to leave this
       * tab to add it. Saves via emitDataChanged(), which App.tsx's
       * overview refetch (feeding fundingOpportunities below) already
       * listens for — no extra plumbing needed for the new option to
       * appear in the selector above. */}
      <CustomOpportunityUpload />
      {error && <p className="error">{error}</p>}

      {activeSession && (
        <div className="proposal-session">
          <p className="hint mono">
            Session #{activeSession.id} · status: {activeSession.status} · opportunity: {activeSession.context?.funding.opportunity.program}
          </p>
          <p className="proposal-label">Correlated context (orchestrator is idle — nothing further has run yet)</p>
          <ul>
            <li>Research Focus: {activeSession.context?.researchFocus.keywords.join(", ") || "(none set)"}</li>
            <li>Literature radar: {activeSession.context?.literature.recentPapers.length ?? 0} papers considered</li>
            <li>Corpus synthesis: {activeSession.context?.corpus.synthesis ? "available" : "none yet"}</li>
            <li>Corpus evidence gathered: {activeSession.context?.corpus.relevantChunks.length ?? 0} grounded passages</li>
          </ul>

          {(!activeSession.state?.gaps || activeSession.state.gaps.length === 0) && (
            <button onClick={brainstormGaps} disabled={brainstorming}>
              {brainstorming ? "Brainstorming…" : "Brainstorm gaps"}
            </button>
          )}

          {/* Sprint 4 (C3): available regardless of whether gaps already
           * exist — a researcher's own hypothesis isn't gated on the agent
           * having proposed anything first. */}
          <div className="proposal-suggest-gap">
            <p className="proposal-label">Or suggest your own research gap</p>
            <textarea
              value={gapStatement} onChange={e => setGapStatement(e.target.value)}
              placeholder="State the gap in your own words…" style={{ width: "100%", minHeight: 60 }}
              aria-label="Your proposed research gap"
            />
            <input
              value={gapReferenceNotes} onChange={e => setGapReferenceNotes(e.target.value)}
              placeholder="Optional reference notes (papers, prior discussions, etc.)…"
              style={{ width: "100%", marginTop: 6 }} aria-label="Reference notes"
            />
            <button onClick={suggestGap} disabled={suggestingGap || !gapStatement.trim()} style={{ marginTop: 6 }}>
              {suggestingGap ? "Grounding in the corpus…" : "Ground and add this gap"}
            </button>
          </div>

          {activeSession.state?.gaps && activeSession.state.gaps.length > 0 && (
            <div className="proposal-gaps">
              <p className="proposal-label">
                Candidate gaps — synthesized from the corpus, literature radar, and a broader
                open-scholarly-search survey; confirm, edit, or reject each one
              </p>
              <ul>
                {activeSession.state.gaps.map(g => (
                  <li key={g.id} className="gap-item">
                    {editingGapId === g.id ? (
                      <textarea
                        value={editedGapTexts[g.id] ?? g.gap}
                        onChange={e => setEditedGapTexts(p => ({ ...p, [g.id]: e.target.value }))}
                        style={{ width: "100%", minHeight: 60 }}
                        aria-label={`Edit gap ${g.id}`}
                      />
                    ) : (
                      <p>{editedGapTexts[g.id] ?? g.gap}{g.edited ? " (edited)" : ""}</p>
                    )}
                    <p className="hint mono">
                      {g.source === "researcher" ? "your suggestion" : "agent-proposed"} · cites: {g.citedSources.join("; ") || "(none — treat with suspicion)"}
                    </p>
                    {g.rationale && <p className="hint">{g.rationale}</p>}
                    {g.groundingReport && (
                      <div className="gap-grounding-report">
                        <p className="proposal-label">Grounding report</p>
                        {g.groundingReport.supportingPapers.length > 0 ? (
                          <ul>
                            {g.groundingReport.supportingPapers.map((p, i) => (
                              <li key={i}>"{p.title}" (match {(p.score * 100).toFixed(0)}%)</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="hint">No sufficiently relevant corpus passages found.</p>
                        )}
                        {g.groundingReport.adjacentWork.length > 0 && (
                          <p className="hint">
                            Adjacent work in the entity graph: {g.groundingReport.adjacentWork.map(a => a.content).join("; ")}
                          </p>
                        )}
                        {g.groundingReport.overlapFlag && (
                          <p className="error">
                            The corpus suggests this gap may already be substantially addressed:{" "}
                            {g.groundingReport.overlapExplanation}
                          </p>
                        )}
                      </div>
                    )}
                    {g.researcherAnswer === null ? (
                      <div className="gap-answer">
                        <label>
                          <input type="radio" name={`gap-${g.id}`} checked={pendingAnswers[g.id] === true}
                            onChange={() => setPendingAnswers(p => ({ ...p, [g.id]: true }))} /> Suitable
                        </label>
                        <label>
                          <input type="radio" name={`gap-${g.id}`} checked={pendingAnswers[g.id] === false}
                            onChange={() => setPendingAnswers(p => ({ ...p, [g.id]: false }))} /> Not suitable
                        </label>
                        <button className="link-btn" type="button"
                          onClick={() => setEditingGapId(editingGapId === g.id ? null : g.id)}>
                          {editingGapId === g.id ? "done editing" : "edit"}
                        </button>
                      </div>
                    ) : (
                      <p className="hint mono">you marked this: {g.researcherAnswer ? "suitable" : "not suitable"}</p>
                    )}
                  </li>
                ))}
              </ul>
              {activeSession.state.gaps.some(g => g.researcherAnswer === null) && (
                <button onClick={confirmGaps} disabled={confirming || Object.keys(pendingAnswers).length === 0}>
                  {confirming ? "Saving…" : "Confirm answers"}
                </button>
              )}
            </div>
          )}

          {(activeSession.status === "gaps_confirmed" || activeSession.status === "drafting") && (() => {
            const drafted = activeSession.state?.draftSections ?? [];
            const draftedKeys = new Set(drafted.map(s => s.sectionKey));
            const plan = activeSession.state?.sectionPlan;
            const order = plan?.order ?? [];
            const labels = plan?.labels ?? {};
            const nextKey = order.find(k => !draftedKeys.has(k));
            return (
              <div className="proposal-draft">
                <hr className="divider" />
                <p className="proposal-label">Draft, section by section — one at a time, on request only</p>
                {plan?.isFallback && (
                  <p className="hint">
                    This funder didn't specify a proposal structure — using a generic section outline.
                  </p>
                )}
                {plan && !plan.isFallback && plan.evaluationCriteria.length > 0 && (
                  <p className="hint">Funder's stated evaluation criteria: {plan.evaluationCriteria.join("; ")}</p>
                )}
                <ul>
                  {order.filter(k => draftedKeys.has(k)).map(k => {
                    const sec = drafted.find(s => s.sectionKey === k)!;
                    // Sprint 5 Pass 6 (comment 13): the editor is now THE
                    // way to view/edit a drafted section — it loads its
                    // own working copy (seeded from this agent text the
                    // FIRST time it's opened, then the researcher's edits
                    // take over) and owns its own citation rendering, so
                    // this no longer reads `rendered`/`shown` directly.
                    // "auto-critique & refine" still regenerates the AGENT
                    // text in state.draftSections — genuinely useful
                    // BEFORE the researcher starts hand-editing (a
                    // section already opened in the editor keeps the
                    // researcher's edits; non-destructive authorship by
                    // construction, not by an extra confirmation step).
                    const priorKeys = extractCitationKeysInOrder(
                      order.slice(0, order.indexOf(k))
                        .map(pk => drafted.find(s => s.sectionKey === pk)?.text ?? "")
                        .join("\n\n"),
                    );
                    return (
                      <li key={k} className="draft-section">
                        <DraftEditor sessionId={activeSession.id} sectionKey={k} sectionLabel={sec.label}
                          priorSectionCitationKeys={priorKeys} />
                        <div className="upload-controls" style={{ marginTop: 6 }}>
                          <button className="link-btn" onClick={() => runAutoCritiqueLoop(k)} disabled={loopRunning === k}>
                            {loopRunning === k ? "Auto-critiquing…" : "ask the agent to regenerate this section"}
                          </button>
                        </div>
                        {loopResults[k] && (
                          <div className="hint" style={{ marginTop: 6 }}>
                            <p className="mono">
                              Auto-critique: {loopResults[k].terminationReason} after {loopResults[k].iterations.length} round(s)
                              · {loopResults[k].costSummary.call_count} LLM calls
                              · ~{loopResults[k].costSummary.estimated_total_tokens} tokens (estimate)
                              · {loopResults[k].costSummary.total_duration_seconds.toFixed(1)}s
                            </p>
                            {loopResults[k].iterations.map(it => (
                              <p key={it.iteration}>
                                Round {it.iteration + 1}: novelty {it.scores.novelty}/10, funder fit {it.scores.funderScopeFit}/10,
                                testable aims {it.scores.testableAims}/10 (overall {it.overallScore}/10) — {it.rationale}
                              </p>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {nextKey && (
                  <div className="upload-controls">
                    <button onClick={() => draftSection(nextKey)} disabled={drafting === nextKey}>
                      {drafting === nextKey ? "Drafting…" : `Draft next section: ${labels[nextKey] ?? nextKey}`}
                    </button>
                    <button className="link-btn" onClick={() => runAutoCritiqueLoop(nextKey)} disabled={loopRunning === nextKey}>
                      {loopRunning === nextKey ? "Auto-critiquing…" : "or: auto-critique & refine"}
                    </button>
                  </div>
                )}
                {!nextKey && <p className="hint">All sections drafted.</p>}
                {drafted.length > 0 && (
                  <div className="upload-controls" style={{ marginTop: 10 }}>
                    <span className="hint">Export the full proposal (all sections, in order, with a combined IEEE reference list):</span>
                    <a className="link-btn" href={`/api/proposal/sessions/${activeSession.id}/export?format=docx`}>Export .docx</a>
                    <a className="link-btn" href={`/api/proposal/sessions/${activeSession.id}/export?format=pdf`}>Export PDF</a>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {sessions.length > 0 && (
        <>
          <hr className="divider" />
          <p className="proposal-label">Past sessions</p>
          <ul className="runs">
            {sessions.map(sess => (
              <li key={sess.id}>
                <span className="mono">{new Date(sess.createdAt).toLocaleString()}</span>
                <b>{sess.status}</b>
                <button className="link-btn" onClick={() => setActiveSession(sess)}>view</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
