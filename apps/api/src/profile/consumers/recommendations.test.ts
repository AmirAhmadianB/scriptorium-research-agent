/** Pass 1.5b Gate — funding relevance follows the current Research Focus,
 * in any domain, with no code change. Fixtures span two contrasting
 * domains (electron microscopy vs. behavioral economics). */
import { describe, it, expect } from "vitest";
import { scoreFundingRelevance } from "./recommendations.js";

const microscopyGrant = {
  program: "Advanced Electron Microscopy Instrumentation Grant",
  eligibility: "Open to groups working on 4D-STEM or electron holography.",
  keywords: ["4D-STEM", "reflection electron holography", "semiconductor metrology"],
};
const econGrant = {
  program: "Behavioral Insights in Public Policy Award",
  eligibility: "Open to researchers studying choice architecture and nudges.",
  keywords: ["nudge theory", "choice architecture", "public policy"],
};

describe("recommendations consumer: scoreFundingRelevance (Pass 1.5b)", () => {
  it("with no focus set, scores 0 (no discipline assumed)", () => {
    expect(scoreFundingRelevance(microscopyGrant, [])).toBe(0);
  });

  it("scores the microscopy grant higher under a microscopy focus", () => {
    const focus = ["4d-stem", "reflection electron holography"];
    expect(scoreFundingRelevance(microscopyGrant, focus))
      .toBeGreaterThan(scoreFundingRelevance(econGrant, focus));
  });

  it("the SAME function, given an econ focus instead, flips which grant scores higher — no code change", () => {
    const focus = ["nudge theory", "choice architecture"];
    expect(scoreFundingRelevance(econGrant, focus))
      .toBeGreaterThan(scoreFundingRelevance(microscopyGrant, focus));
  });
});
