import React, { useEffect, useState } from "react";
import ResearchFocus from "./ResearchFocus.js";
import VelocityChart from "./VelocityChart.js";
import CorpusLibrary from "./CorpusLibrary.js";
import ProposalTab from "./ProposalTab.js";
import CrawlSourceRegistry from "./CrawlSourceRegistry.js";
import FundingTab from "./FundingTab.js";
import RadarSync from "./RadarSync.js";
import SettingsTab from "./SettingsTab.js";
import FirstRunWizard from "./FirstRunWizard.js";
import { onFocusChanged, onDataChanged } from "./focusEvents.js";

/* ------------------------------------------------------------------ types */
type Paper = { id: number; title: string; venue: string | null; year: number | null;
  publishedDate: string | null; citedByCount: number; source: string };
type Funding = { id: number; program: string; sponsor: string; deadline: string | null;
  amount: string | null; scope: string; url: string; matchScore: number | null; liveMatchScore?: number };
type Run = { id: number; kind: string; startedAt: string; summary: any };
type Overview = { papers: Paper[]; funding: Funding[]; runs: Run[] };

/* --------------------------------------------- mock fallback (pre-DB demo) */
const MOCK: Overview = {
  papers: [
    { id: 1, title: "Sub-ångström surface reconstruction via reflection ptychography", venue: "Ultramicroscopy", year: 2026, publishedDate: nextDays(-12), citedByCount: 4, source: "openalex" },
    { id: 2, title: "Event-driven hybrid pixel detectors for low-dose 4D-STEM", venue: "arXiv cond-mat.mtrl-sci", year: 2026, publishedDate: nextDays(-30), citedByCount: 0, source: "arxiv" },
    { id: 3, title: "Phase retrieval under partial coherence: a unified estimator", venue: "Phys. Rev. Applied", year: 2025, publishedDate: nextDays(-45), citedByCount: 18, source: "openalex" },
    { id: 4, title: "In-line holography of buried interfaces in GAA transistors", venue: "Nat. Commun.", year: 2025, publishedDate: nextDays(-60), citedByCount: 31, source: "semantic_scholar" },
  ],
  funding: [
    { id: 1, program: "Alliance Grants", sponsor: "NSERC", deadline: nextDays(21), amount: "$20k–$1M/yr", scope: "national", url: "#", matchScore: 84 },
    { id: 2, program: "Exploration", sponsor: "New Frontiers in Research Fund", deadline: nextDays(64), amount: "up to $125k/yr × 2", scope: "national", url: "#", matchScore: 71 },
    { id: 3, program: "Innovation Fund", sponsor: "Canada Foundation for Innovation", deadline: nextDays(140), amount: "40% of infrastructure", scope: "national", url: "#", matchScore: 62 },
    { id: 4, program: "Accelerate", sponsor: "Mitacs", deadline: null, amount: "$15k+/intern", scope: "national", url: "#", matchScore: 58 },
  ],
  runs: [
    { id: 1, kind: "literature_scan", startedAt: new Date().toISOString(), summary: { new_total: 23 } },
    { id: 2, kind: "funding_scan", startedAt: new Date(Date.now() - 36e5).toISOString(), summary: { new: 2, changed: 1 } },
  ],
};
function nextDays(n: number) { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 10); }

/* ------------------------------------------------------------------- app */
export default function App() {
  const [data, setData] = useState<Overview>(MOCK);
  const [live, setLive] = useState(false);
  const [tab, setTab] = useState<"focus" | "radar" | "funding" | "corpus" | "proposal" | "runs" | "settings">("radar");
  // null = not checked yet (render nothing, avoid a flash of the dashboard
  // before we know); true/false once /api/setup/status answers.
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/setup/status").then(r => r.json()).then(d => setSetupComplete(d.completed))
      // No API reachable yet (still booting, or dev mode's mock-data state) —
      // don't block the whole dashboard on the wizard check failing.
      .catch(() => setSetupComplete(true));
  }, []);

  useEffect(() => {
    function loadOverview() {
      fetch("/api/overview").then(r => r.json())
        .then(d => { if (d?.papers) { setData(d); setLive(true); } })
        .catch(() => {/* stay on mock; the empty state below explains itself */});
    }
    loadOverview();
    // Sprint 2 Pass 1 (comment 2): /api/overview's `papers` is now
    // focus-ranked server-side (see server.ts), but that's only useful if
    // the client actually re-fetches after an edit — this is that refetch.
    const offFocus = onFocusChanged(loadOverview);
    // Sprint 2 Pass 3: same reasoning — a crawl-source add/crawl-now can
    // insert new funding_opportunities rows; refetch so they show up
    // without a page reload.
    const offData = onDataChanged(loadOverview);
    return () => { offFocus(); offData(); };
  }, []);

  const daysTo = (iso: string | null) =>
    iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5) : null;

  if (setupComplete === false) {
    return <FirstRunWizard onComplete={() => setSetupComplete(true)} />;
  }
  if (setupComplete === null) {
    return null; // avoid a flash of the dashboard before the check resolves
  }

  return (
    <div className="shell">
      {/* ------------------------------------------------ instrument rail */}
      <aside className="rail">
        <div className="wordmark">
          <span className="glyph" aria-hidden>✳</span> SCRIPTORIUM
        </div>
        <nav>
          {(["focus", "radar", "funding", "corpus", "proposal", "runs", "settings"] as const).map(t => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {{ focus: "Research Focus", radar: "Literature radar", funding: "Funding", corpus: "Corpus", proposal: "Proposal", runs: "Agent runs", settings: "Settings" }[t]}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <div className={"pulse" + (live ? " alive" : "")} />
          <span>{live ? "connected to API" : "demo data — start the API"}</span>
          <code>/scan · /trends · /funding</code>
        </div>
      </aside>

      {/* --------------------------------------------------------- ledger */}
      <main className="ledger">
        {/* Sprint 2 Pass 1 (comment 1): the cross-page focus banner is
         * removed, not fixed-in-place — Research Focus state lives ONLY on
         * the Research Focus tab now. Do not reintroduce a global summary
         * here; that's explicitly out of scope per the correction brief. */}

        {tab === "focus" && <ResearchFocus />}

        {tab === "radar" && (
          <section className="grid">
            <RadarSync />
            <div className="panel span7">
              <h2>New in the field</h2>
              <p className="hint">Published in the last 3 months (or with a future/in-press date).</p>
              {data.papers.length === 0 && (
                <p className="hint">No recently-published papers yet — try "Update radar" above.</p>
              )}
              <ul className="papers">
                {data.papers.map(p => (
                  <li key={p.id}>
                    <span className="title">{p.title}</span>
                    <span className="meta">{p.venue ?? "—"} · {p.publishedDate ?? p.year ?? "—"} ·
                      <span className="mono"> {p.citedByCount} cit.</span></span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="panel span5">
              <h2>Closing soon</h2>
              <ul className="deadlines">
                {data.funding.filter(f => { const d = daysTo(f.deadline); return d !== null && d <= 45; })
                  .map(f => {
                    const d = daysTo(f.deadline)!;
                    return (
                      <li key={f.id} className={d <= 30 ? "urgent" : ""}>
                        <span className="days mono">{d}d</span>
                        <span><b>{f.program}</b><br /><small>{f.sponsor} · {f.amount}</small></span>
                      </li>
                    );
                  })}
              </ul>
            </div>
            <VelocityChart />
            <div className="panel span12">
              <CrawlSourceRegistry purpose="literature" />
            </div>
          </section>
        )}

        {tab === "funding" && (
          <section className="panel">
            <FundingTab />
          </section>
        )}

        {tab === "corpus" && (
          <section className="panel">
            <CorpusLibrary />
            <p className="hint" style={{ marginTop: 16 }}>
              Full-text scan of external sources (OpenAlex, arXiv, Semantic Scholar)
              runs separately via <code>pnpm scan</code> or <code>/scan</code>.
            </p>
          </section>
        )}

        {tab === "proposal" && (
          <section className="panel">
            <ProposalTab fundingOpportunities={data.funding} />
          </section>
        )}

        {tab === "runs" && (
          <section className="panel">
            <h2>Agent runs</h2>
            <ul className="runs">
              {data.runs.map(r => (
                <li key={r.id}>
                  <span className="mono">{new Date(r.startedAt).toLocaleString()}</span>
                  <b>{r.kind}</b>
                  <code>{JSON.stringify(r.summary)}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {tab === "settings" && <SettingsTab />}
      </main>
    </div>
  );
}
