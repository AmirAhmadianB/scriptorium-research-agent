/** Pass 1.5a Gate — search ranks toward the current Research Focus, in any
 * domain, with no code change. Fixtures span two contrasting domains
 * (electron microscopy vs. behavioral economics) so a passing test can't
 * be hiding a hardcoded discipline. */
import { describe, it, expect } from "vitest";
import { rankByFocusRelevance } from "./search.js";

const microscopyPaper = {
  title: "Reflection electron holography of buried interfaces",
  abstract: "We demonstrate phase retrieval via 4D-STEM on GAA transistors.",
  citedByCount: 3,
};
const econPaper = {
  title: "Nudge theory and default enrollment in retirement plans",
  abstract: "A field experiment on choice architecture and savings behavior.",
  citedByCount: 50, // higher citations, but wrong domain — must not win over a focus match
};

describe("search consumer: rankByFocusRelevance (Pass 1.5a)", () => {
  it("with no focus set, falls back to citation-count order (unchanged behavior)", () => {
    const ranked = rankByFocusRelevance([microscopyPaper, econPaper], []);
    expect(ranked.map(p => p.title)).toEqual([econPaper.title, microscopyPaper.title]);
  });

  it("boosts a lower-cited paper matching the current microscopy focus above a higher-cited off-domain paper", () => {
    const ranked = rankByFocusRelevance(
      [econPaper, microscopyPaper],
      ["4d-stem", "reflection electron holography"],
    );
    expect(ranked[0]).toBe(microscopyPaper);
  });

  it("the SAME ranking function, given a completely different domain's focus, boosts the econ paper instead — no code change", () => {
    const ranked = rankByFocusRelevance(
      [microscopyPaper, econPaper],
      ["nudge theory", "choice architecture"],
    );
    expect(ranked[0]).toBe(econPaper);
  });
});
