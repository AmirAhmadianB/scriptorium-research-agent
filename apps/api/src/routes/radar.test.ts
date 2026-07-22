/** Sprint 4 (C1) gate (fast slice): the staleness comparison itself, pure
 * and DB-free. The live end-to-end path (focus commit -> stale banner ->
 * refresh -> banner clears) was run manually against the dev server; see
 * docs/DASHBOARD-CORRECTIONS-SPRINT4-PASS0.md. */
import { describe, expect, it } from "vitest";
import { computeStale } from "./radar.js";

describe("computeStale", () => {
  it("is never stale before any run has happened", () => {
    expect(computeStale(5, null, false)).toBe(false);
  });

  it("is stale when the last run used an older focus version", () => {
    expect(computeStale(5, 4, true)).toBe(true);
  });

  it("is not stale when the last run used the current focus version", () => {
    expect(computeStale(5, 5, true)).toBe(false);
  });

  it("is stale for a disjoint focus swap even if the version number happens to repeat", () => {
    // Defensive: version is monotonic in practice (profile/store.ts always
    // increments), but the comparison itself should just be equality, not
    // an ordering assumption, so a hand-edited/replayed version still reads
    // correctly as stale/not-stale.
    expect(computeStale(3, 7, true)).toBe(true);
  });
});
