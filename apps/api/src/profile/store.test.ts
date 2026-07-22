/** Pass 1.1 Gate tests for the profile store. Fixtures deliberately span
 * two contrasting domains (condensed-matter physics vs. epidemiology) per
 * the brief's Global Constraint, so a passing suite can't be hiding a
 * hardcoded discipline anywhere in this layer. */
import { describe, it, expect } from "vitest";
import { commitProfile, getProfile } from "./store.js";

describe("profile store", () => {
  it("round-trips a normalized profile (trim, case-fold, dedupe, manual-wins-collision)", async () => {
    const profile = await commitProfile({
      professorId: "prof-physics-test",
      keywords: [
        { value: "  Skyrmion Imaging  ", provenance: "manual" },
        { value: "skyrmion imaging", provenance: "derived" }, // dup after trim+case-fold
        { value: "4D-STEM", provenance: "manual" },
      ],
      focusSynthesis: "Condensed matter physics: skyrmion dynamics via 4D-STEM.",
    });

    expect(profile.keywords).toHaveLength(2);
    expect(profile.keywords.map(k => k.value)).toEqual(["Skyrmion Imaging", "4D-STEM"]);
    expect(profile.keywords[0].provenance).toBe("manual"); // manual wins over derived on collision
    expect(profile.focusSynthesis).toBe("Condensed matter physics: skyrmion dynamics via 4D-STEM.");
    expect(profile.version).toBe(1);

    const reread = await getProfile("prof-physics-test");
    expect(reread).toEqual(profile);
  });

  it("flips DRAFT to ACTIVE at exactly five keywords — contrasting domain (epidemiology)", async () => {
    const draft = await commitProfile({
      professorId: "prof-epi-test",
      keywords: [
        { value: "epidemiology", provenance: "manual" },
        { value: "vaccine hesitancy", provenance: "manual" },
        { value: "public health messaging", provenance: "manual" },
        { value: "social determinants", provenance: "manual" },
      ],
    });
    expect(draft.status).toBe("DRAFT");

    const active = await commitProfile({
      professorId: "prof-epi-test",
      keywords: [
        ...draft.keywords.map(k => ({ value: k.value, provenance: k.provenance })),
        { value: "outbreak modeling", provenance: "manual" },
      ],
    });
    expect(active.status).toBe("ACTIVE");
    expect(active.version).toBe(2);
  });

  it("bumps version on every commit", async () => {
    const first = await commitProfile({
      professorId: "prof-version-test",
      keywords: [{ value: "a", provenance: "manual" }],
    });
    expect(first.version).toBe(1);
    const second = await commitProfile({
      professorId: "prof-version-test",
      keywords: [{ value: "a", provenance: "manual" }, { value: "b", provenance: "manual" }],
    });
    expect(second.version).toBe(2);
  });

  it("returns a neutral empty DRAFT profile for a professor who never committed", async () => {
    const profile = await getProfile("prof-never-committed-test");
    expect(profile.status).toBe("DRAFT");
    expect(profile.keywords).toEqual([]);
    expect(profile.version).toBe(0);
  });

  it("rejects invalid input via the shared schema (empty keyword)", async () => {
    await expect(commitProfile({
      professorId: "prof-invalid-test",
      keywords: [{ value: "   ", provenance: "manual" }],
    })).rejects.toThrow();
  });
});
