import { describe, expect, it } from "vitest";
import { recencyCutoffIso } from "./papers.js";

describe("recencyCutoffIso", () => {
  it("subtracts 3 calendar months by default", () => {
    expect(recencyCutoffIso(new Date("2026-07-13T00:00:00Z"))).toBe("2026-04-13");
  });

  it("handles a month-length underflow (e.g. May 31 - 3mo has no day 31 in Feb)", () => {
    // JS Date rolls this over into March, which is the correct calendar
    // behavior (there is no Feb 31) — asserting it here so a future refactor
    // doesn't silently "fix" this into an off-by-one.
    expect(recencyCutoffIso(new Date("2026-05-31T00:00:00Z"))).toBe("2026-03-03");
  });

  it("supports a custom window", () => {
    expect(recencyCutoffIso(new Date("2026-07-13T00:00:00Z"), 1)).toBe("2026-06-13");
  });
});
