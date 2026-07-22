/** Pass 1.5f Gate — the focus digest follows the current Research Focus,
 * in any domain, with no code change. Fixtures span two contrasting
 * domains (electron microscopy vs. behavioral economics). */
import { describe, it, expect } from "vitest";
import { buildFocusDigest } from "./summaries.js";

const microscopyPaper = {
  title: "Reflection electron holography of buried interfaces",
  abstract: "We demonstrate phase retrieval via 4D-STEM on GAA transistors.",
};
const econPaper = {
  title: "Nudge theory and default enrollment in retirement plans",
  abstract: "A field experiment on choice architecture and savings behavior.",
};

describe("summaries consumer: buildFocusDigest (Pass 1.5f)", () => {
  it("with no focus set, reports corpus size only, no discipline assumed", () => {
    const digest = buildFocusDigest([microscopyPaper, econPaper], { keywords: [], focusSynthesis: null });
    expect(digest).toContain("2");
    expect(digest.toLowerCase()).not.toContain("electron");
    expect(digest.toLowerCase()).not.toContain("econ");
  });

  it("under a microscopy focus, counts only the microscopy paper as relevant", () => {
    const digest = buildFocusDigest(
      [microscopyPaper, econPaper],
      { keywords: ["4d-stem", "reflection electron holography"], focusSynthesis: null },
    );
    expect(digest).toContain("1 of 2");
    expect(digest).toContain(microscopyPaper.title);
  });

  it("the SAME function, given an econ focus instead, counts the econ paper — no code change", () => {
    const digest = buildFocusDigest(
      [microscopyPaper, econPaper],
      { keywords: ["nudge theory", "choice architecture"], focusSynthesis: null },
    );
    expect(digest).toContain("1 of 2");
    expect(digest).toContain(econPaper.title);
  });
});
