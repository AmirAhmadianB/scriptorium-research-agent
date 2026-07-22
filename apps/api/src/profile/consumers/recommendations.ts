/** Pass 1.5b — "recommendations" consumer. Funding-opportunity matchScore
 * used to be computed once per crawl (services/ingest funding/crawl_funding.py)
 * against config/focus.yaml's hardcoded keyword list, then stored — so
 * editing the Research Focus never changed anything until the next crawl.
 * This consumer keeps a live snapshot of the current focus keywords so
 * GET /api/funding can recompute relevance on every request against
 * whatever the researcher's focus is RIGHT NOW, in any domain. */
import type { ProfileConsumer } from "../registry.js";

let currentFocusKeywords: string[] = [];

export const recommendationsConsumer: ProfileConsumer<string[]> = {
  name: "recommendations",
  select: (profile) => profile.keywords.map(k => k.value.toLowerCase()),
  apply: (keywords) => { currentFocusKeywords = keywords; },
};

export function getRecommendationsFocusKeywords(): readonly string[] {
  return currentFocusKeywords;
}

interface ScorableOpportunity {
  program: string;
  eligibility: string | null;
  keywords: string[] | null;
}

const GENERIC_TERMS = ["research", "innovation", "science", "partnership", "collaboration"];

/** Same lexical-prior shape as the Python crawler's _match_score (ported,
 * not duplicated logic invented fresh) so a researcher doesn't see two
 * different scoring philosophies depending on whether a card was crawled
 * before or after their most recent focus edit. Pure + exported for unit
 * testing without a DB or HTTP layer. Returns 0-100 to match the schema's
 * `match_score_pct` column. */
export function scoreFundingRelevance(
  opp: ScorableOpportunity, focusKeywords: readonly string[],
): number {
  if (focusKeywords.length === 0) return 0;
  const haystack = [opp.program, opp.eligibility ?? "", ...(opp.keywords ?? [])]
    .join(" ").toLowerCase();
  const fieldTerms = focusKeywords.map(k => k.split(" /")[0]);
  const hits = fieldTerms.reduce((n, k) => n + (haystack.includes(k) ? 1 : 0), 0);
  const breadth = GENERIC_TERMS.reduce((n, g) => n + (haystack.includes(g) ? 1 : 0), 0);
  return Math.round(Math.min(1, hits * 0.3 + breadth * 0.05) * 100);
}
