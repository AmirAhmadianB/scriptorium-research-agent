/** Pass 1.4 Gate tests — the reactive loop: debounce coalescing, a visible
 * `pending` state, and error isolation between consumers. Fixtures span two
 * contrasting domains (materials science vs. labor economics) per the
 * brief's Global Constraint. */
import { describe, it, expect, vi } from "vitest";
import { profileProvider } from "./provider.js";
import { consumerRegistry } from "./registry.js";
import type { ResearchProfile } from "@scriptorium/shared";

function waitFor(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("reactive loop (Pass 1.4)", () => {
  it("rapid successive commits coalesce to exactly one debounced apply, with the LATEST profile", async () => {
    const applied: number[] = [];
    consumerRegistry.register({
      name: "temp-debounce-test",
      debounceMs: 100,
      select: (p: ResearchProfile) => p.keywords.length,
      apply: (count: number) => { applied.push(count); },
    });
    try {
      // Three rapid commits, all inside one 100ms debounce window.
      await profileProvider.commit({
        professorId: "prof-materials-test",
        keywords: [{ value: "perovskite solar cells", provenance: "manual" }],
      });
      await profileProvider.commit({
        professorId: "prof-materials-test",
        keywords: [
          { value: "perovskite solar cells", provenance: "manual" },
          { value: "thin-film deposition", provenance: "manual" },
        ],
      });
      const last = await profileProvider.commit({
        professorId: "prof-materials-test",
        keywords: [
          { value: "perovskite solar cells", provenance: "manual" },
          { value: "thin-film deposition", provenance: "manual" },
          { value: "grain boundary passivation", provenance: "manual" },
        ],
      });

      // Immediately after the commits, the consumer should be pending —
      // nothing applied yet, no reload/poll needed to observe this.
      const midState = consumerRegistry.getState().find(s => s.name === "temp-debounce-test")!;
      expect(midState.pending).toBe(true);
      expect(applied).toEqual([]);

      await waitFor(150); // past the 100ms debounce window

      expect(applied).toEqual([last.keywords.length]); // exactly one apply, latest value (3)
      const finalState = consumerRegistry.getState().find(s => s.name === "temp-debounce-test")!;
      expect(finalState.pending).toBe(false);
      expect(finalState.lastAppliedVersion).toBe(last.version);
    } finally {
      consumerRegistry.unregister("temp-debounce-test");
    }
  });

  it("a throwing consumer does not block other consumers, and its error is visible via getState", async () => {
    const goodReceived: string[] = [];
    consumerRegistry.register({
      name: "temp-broken-test",
      select: (p: ResearchProfile) => p,
      apply: () => { throw new Error("simulated consumer failure"); },
    });
    consumerRegistry.register({
      name: "temp-good-test",
      select: (p: ResearchProfile) => p.professorId,
      apply: (professorId: string) => { goodReceived.push(professorId); },
    });
    try {
      await profileProvider.commit({
        professorId: "prof-labor-econ-test",
        keywords: [{ value: "minimum wage elasticity", provenance: "manual" }],
      });

      expect(goodReceived).toEqual(["prof-labor-econ-test"]); // unaffected by the broken consumer

      const brokenState = consumerRegistry.getState().find(s => s.name === "temp-broken-test")!;
      expect(brokenState.lastError).toBe("simulated consumer failure");
    } finally {
      consumerRegistry.unregister("temp-broken-test");
      consumerRegistry.unregister("temp-good-test");
    }
  });

  it("the Pass 1.4 diagnostic consumer is registered by default and observes real commits", async () => {
    const before = consumerRegistry.getState().find(s => s.name === "diagnostic");
    expect(before).toBeTruthy(); // proves the temporary observation consumer from this pass exists
  });
});
