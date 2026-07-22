import { describe, it, expect, vi } from "vitest";
import { profileProvider } from "./provider.js";
import { consumerRegistry } from "./registry.js";
import type { ResearchProfile } from "@scriptorium/shared";

describe("profile provider + registry", () => {
  it("emits exactly one 'change' event per commit", async () => {
    const listener = vi.fn();
    profileProvider.on("change", listener);
    try {
      await profileProvider.commit({
        professorId: "prof-provider-test",
        keywords: [{ value: "test-keyword", provenance: "manual" }],
      });
    } finally {
      profileProvider.off("change", listener);
    }
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as ResearchProfile).professorId).toBe("prof-provider-test");
  });

  it("registry propagates the change to a registered (throwaway) test consumer", async () => {
    const received: string[] = [];
    const consumer = {
      name: "temp-test-consumer",
      select: (p: ResearchProfile) => p.professorId,
      apply: (professorId: string) => { received.push(professorId); },
    };
    consumerRegistry.register(consumer);
    try {
      await profileProvider.commit({
        professorId: "prof-registry-test",
        keywords: [{ value: "x", provenance: "manual" }],
      });
    } finally {
      consumerRegistry.unregister("temp-test-consumer");
    }
    expect(received).toEqual(["prof-registry-test"]);
  });
});
