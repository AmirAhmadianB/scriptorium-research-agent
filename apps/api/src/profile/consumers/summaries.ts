/** Pass 1.5f — "summaries" consumer. No corpus-level summary existed before
 * this pass (only the per-paper structured_summary from Pass 1.5d's agent
 * behaviour). This adds a live "focus digest": a short, field-adaptive
 * summary of how much of the corpus relates to the CURRENT Research Focus,
 * in any domain, recomputed on every request — same reactive-loop shape as
 * search (1.5a) and recommendations (1.5b), deliberately extractive (no
 * live LLM call) so it stays cheap enough to recompute per request. */
import type { ProfileConsumer } from "../registry.js";

interface FocusSnapshot { keywords: string[]; focusSynthesis: string | null }

let current: FocusSnapshot = { keywords: [], focusSynthesis: null };

export const summariesConsumer: ProfileConsumer<FocusSnapshot> = {
  name: "summaries",
  select: (profile) => ({
    keywords: profile.keywords.map(k => k.value.toLowerCase()),
    focusSynthesis: profile.focusSynthesis ?? null,
  }),
  apply: (snapshot) => { current = snapshot; },
};

export function getSummariesFocusSnapshot(): FocusSnapshot {
  return current;
}

interface DigestPaper { title: string | null; abstract: string | null }

export function buildFocusDigest(papers: DigestPaper[], focus: FocusSnapshot): string {
  if (focus.keywords.length === 0) {
    return papers.length === 0
      ? "No Research Focus set yet, and no papers in the corpus yet."
      : `No Research Focus set yet — corpus has ${papers.length} paper${papers.length === 1 ? "" : "s"} indexed.`;
  }
  const matches = papers.filter(p => {
    const haystack = `${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
    return focus.keywords.some(k => haystack.includes(k));
  });
  const topTitles = matches.slice(0, 3).map(p => p.title).filter(Boolean);
  const base = `${matches.length} of ${papers.length} corpus paper${papers.length === 1 ? "" : "s"} `
    + `relate to your current focus (${focus.keywords.slice(0, 5).join(", ")}).`;
  return topTitles.length > 0 ? `${base} Most relevant: ${topTitles.join("; ")}.` : base;
}
