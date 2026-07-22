/** Sprint 6 Pass 4 — first-run wizard: EULA, provider key (reuses
 * ProviderSetupForm — the exact same add/validate/save path Settings
 * uses, not a second implementation), data directory confirmation, corpus
 * folder (deferred to the Corpus tab, not duplicated here), and a privacy
 * summary (A8). Completing or skipping writes the one-time marker
 * (POST /api/setup/complete) so relaunch never shows this again. */
import React, { useEffect, useState } from "react";
import ProviderSetupForm from "./ProviderSetupForm.js";

type Step = "eula" | "provider" | "data-dir" | "corpus" | "privacy";
const STEPS: Step[] = ["eula", "provider", "data-dir", "corpus", "privacy"];

export default function FirstRunWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("eula");
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [dataDir, setDataDir] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/setup/status").then(r => r.json()).then(d => setDataDir(d.dataDir)).catch(() => {});
  }, []);

  function next() {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
  }

  async function finish() {
    await fetch("/api/setup/complete", { method: "POST" }).catch(() => {});
    onComplete();
  }

  return (
    <div className="shell" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="panel" style={{ maxWidth: 640, width: "100%" }}>
        <div className="wordmark" style={{ marginBottom: 16 }}>
          <span className="glyph" aria-hidden>✳</span> SCRIPTORIUM SETUP
        </div>

        {step === "eula" && (
          <>
            <h2>Before you start</h2>
            <p className="hint" style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border, #333)", padding: 8 }}>
              Scriptorium is provided as a free beta under a simple agreement: you use it as-is, at your own
              risk, for your own research work. It makes real calls to whichever LLM provider you configure
              (billed to your own account, per that provider's own pricing) and crawls public web pages on
              your behalf. No warranty is made about the accuracy of anything the app generates — treat
              drafted proposals, extracted funding details, and suggested research gaps as a starting point
              for your own judgment, not a final answer.
            </p>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
              <input type="checkbox" checked={eulaAccepted} onChange={e => setEulaAccepted(e.target.checked)} />
              I have read and agree to this
            </label>
            <div className="upload-controls" style={{ marginTop: 16 }}>
              <button onClick={next} disabled={!eulaAccepted}>Continue</button>
            </div>
          </>
        )}

        {step === "provider" && (
          <>
            <h2>Connect an LLM provider</h2>
            <p className="hint">
              Scriptorium's agent features (literature analysis, funding extraction, proposal drafting) need
              an LLM provider to call. Add one now — an Anthropic API key is the recommended path, but any
              OpenAI-compatible endpoint works too (including a local one like Ollama, at no cost).
            </p>
            {providerConfigured
              ? <p className="hint">✓ Provider connected and activated.</p>
              : <ProviderSetupForm onSaved={() => setProviderConfigured(true)} />}
            <div className="upload-controls" style={{ marginTop: 16 }}>
              <button onClick={next} disabled={!providerConfigured}>Continue</button>
              {!providerConfigured && (
                <button className="link-btn" onClick={next}>Skip for now (agent features won't work yet)</button>
              )}
            </div>
          </>
        )}

        {step === "data-dir" && (
          <>
            <h2>Where your data lives</h2>
            <p className="hint">
              Everything Scriptorium stores — your corpus database, research focus, drafts, and configuration —
              lives entirely on this computer, in:
            </p>
            <p className="hint mono">{dataDir ?? "…"}</p>
            <p className="hint">
              Nothing here is uploaded anywhere except as explicit excerpts inside your own LLM provider calls
              (see the privacy summary at the end of this setup).
            </p>
            <div className="upload-controls" style={{ marginTop: 16 }}>
              <button onClick={next}>Continue</button>
            </div>
          </>
        )}

        {step === "corpus" && (
          <>
            <h2>Your paper corpus (optional)</h2>
            <p className="hint">
              If you keep a folder of PDFs you want Scriptorium to read and cite, you can point it there from
              the Corpus tab any time after setup — there's no need to do that now.
            </p>
            <div className="upload-controls" style={{ marginTop: 16 }}>
              <button onClick={next}>Continue</button>
            </div>
          </>
        )}

        {step === "privacy" && (
          <>
            <h2>What leaves this laptop</h2>
            <p className="hint"><b>Does leave:</b> LLM API calls (with document excerpts) to whichever provider
              you configured in the previous step; crawler requests to public funding/literature sites; optional
              embedding or metrics provider calls if you enable one.</p>
            <p className="hint"><b>Never leaves:</b> your corpus files, the database, anything not explicitly
              part of a call above. No telemetry is collected in this release.</p>
            <div className="upload-controls" style={{ marginTop: 16 }}>
              <button onClick={finish}>Finish setup</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
