/** Sprint 2 Pass 1 (comment 2) regression test — guards the specific
 * composition GET /api/overview uses for the Literature Radar (rank a wide
 * pool toward the current focus, then slice to the displayed count), not
 * just rankByFocusRelevance in isolation (already covered by
 * search.test.ts). Before this pass, /api/overview's radar query never
 * called rankByFocusRelevance at all — this test would have caught that
 * regression by asserting the SAME contrasting-domain fixture flips which
 * paper leads the pool after slicing. */
import { describe, it, expect } from "vitest";
import { rankByFocusRelevance } from "./search.js";

const RADAR_DISPLAY_COUNT = 12;

const microscopyPaper = {
  title: "Reflection electron holography of buried interfaces",
  abstract: "We demonstrate phase retrieval via 4D-STEM on GAA transistors.",
  citedByCount: 3,
};
const econPaper = {
  title: "Nudge theory and default enrollment in retirement plans",
  abstract: "A field experiment on choice architecture and savings behavior.",
  citedByCount: 50,
};

function radarSlice<T extends { citedByCount: number | null }>(pool: T[], keywords: readonly string[]) {
  return rankByFocusRelevance(pool, keywords).slice(0, RADAR_DISPLAY_COUNT);
}

describe("Literature Radar composition (Sprint 2, comment 2)", () => {
  it("leads with the microscopy paper under a microscopy focus", () => {
    const radar = radarSlice([econPaper, microscopyPaper], ["4d-stem", "reflection electron holography"]);
    expect(radar[0]).toBe(microscopyPaper);
  });

  it("the SAME composition, given a disjoint econ focus, leads with the econ paper instead", () => {
    const radar = radarSlice([microscopyPaper, econPaper], ["nudge theory", "choice architecture"]);
    expect(radar[0]).toBe(econPaper);
  });
});
