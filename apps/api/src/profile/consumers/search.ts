/** Pass 1.5a — "search" consumer. Corpus search (GET /api/corpus) used to
 * rank purely by citation count, with no notion of the researcher's current
 * domain — not a hardcoded discipline literal, but not field-adaptive
 * either. This consumer keeps a live-updated snapshot of the current
 * Research Focus keywords (updated via the reactive loop, not re-read from
 * the DB per request) so the corpus route can boost results that match the
 * researcher's actual focus, in ANY domain, immediately after a profile
 * edit. */
import type { ProfileConsumer } from "../registry.js";

let currentFocusKeywords: string[] = [];

export const searchConsumer: ProfileConsumer<string[]> = {
  name: "search",
  select: (profile) => profile.keywords.map(k => k.value.toLowerCase()),
  apply: (keywords) => { currentFocusKeywords = keywords; },
};

export function getSearchFocusKeywords(): readonly string[] {
  return currentFocusKeywords;
}

interface SearchablePaper {
  title: string | null;
  abstract: string | null;
  citedByCount: number | null;
}

/** Pure so it's unit-testable without a DB or HTTP layer. Papers whose
 * title/abstract mention at least one current focus keyword sort first
 * (most matching keywords wins ties), falling back to citation count
 * within each group — same tiebreak the route used before this pass. */
export function rankByFocusRelevance<T extends SearchablePaper>(
  papers: T[], focusKeywords: readonly string[],
): T[] {
  const score = (p: T) => {
    if (focusKeywords.length === 0) return 0; // no focus set -> pure citation-count order below

    const haystack = `${p.title ?? ""} ${p.abstract ?? ""}`.toLowerCase();
    return focusKeywords.reduce((n, kw) => n + (haystack.includes(kw) ? 1 : 0), 0);
  };
  return [...papers].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return (b.citedByCount ?? 0) - (a.citedByCount ?? 0);
  });
}
