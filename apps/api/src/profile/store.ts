/** ResearchProfile store — validate, normalize, persist, read, version.
 * Pass 1.1 foundation only: this module has no consumers registered
 * against it yet (see profile/registry.ts) and no frontend wired to it
 * (see profile/provider.ts for the one access path + change event).
 *
 * Persistence is DB-backed (research_profiles / research_profile_keywords,
 * db/schema.ts) rather than config/focus.yaml — chosen so keywords can
 * carry per-item provenance and the profile can carry a version counter,
 * neither of which fits cleanly into the existing flat YAML control-plane
 * files. config/focus.yaml and routes/focus.ts are untouched by this pass.
 */
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import {
  ResearchProfile, ResearchProfileCommitInput,
  emptyProfile, normalizeKeywords, statusForKeywordCount,
} from "@scriptorium/shared";

const DEFAULT_PROFESSOR_ID = "default";

/** No professor-management UI exists yet (that's out of Change 1's scope
 * per the brief — professors are a Change-3-adjacent concern). A single
 * default professor is auto-provisioned on first use so the profile store
 * is exercisable today while staying genuinely per-professor: once a real
 * professor-management flow exists, every function here already takes an
 * explicit professorId and needs no rework. */
export async function ensureDefaultProfessor(): Promise<string> {
  const existing = await db.select().from(s.professors).limit(1);
  if (existing.length > 0) return existing[0].id;
  await db.insert(s.professors).values({
    id: DEFAULT_PROFESSOR_ID, name: "Default Researcher", department: "",
  });
  return DEFAULT_PROFESSOR_ID;
}

/** Resolves to a professorId that is GUARANTEED to have a `professors` row
 * (libSQL enforces the foreign key on research_profiles.professor_id by
 * default, unlike the raw sqlite3 driver Python uses elsewhere in this
 * repo — verified by this pass's own tests, which is what caught this).
 * An omitted id falls back to the single auto-provisioned default
 * professor; an explicit-but-unknown id gets a minimal professor row
 * created on the fly, since there's no professor-management flow yet for
 * either case to have created one in advance. */
async function resolveProfessorId(professorId?: string): Promise<string> {
  if (!professorId) return ensureDefaultProfessor();
  const [existing] = await db.select().from(s.professors)
    .where(eq(s.professors.id, professorId)).limit(1);
  if (existing) return professorId;
  await db.insert(s.professors).values({ id: professorId, name: professorId, department: "" });
  return professorId;
}

export async function getProfile(professorId?: string): Promise<ResearchProfile> {
  const pid = await resolveProfessorId(professorId);
  const [row] = await db.select().from(s.researchProfiles)
    .where(eq(s.researchProfiles.professorId, pid)).limit(1);
  if (!row) return emptyProfile(pid);

  const keywordRows = await db.select().from(s.researchProfileKeywords)
    .where(eq(s.researchProfileKeywords.profileId, row.id))
    .orderBy(s.researchProfileKeywords.position);

  const keywords = keywordRows.map(k => ({
    id: k.id,
    value: k.value,
    provenance: k.provenance as "manual" | "derived",
  }));

  return ResearchProfile.parse({
    professorId: pid,
    keywords,
    focusSynthesis: row.focusSynthesis,
    status: statusForKeywordCount(keywords.length),
    version: row.version,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  });
}

/** Validate + normalize + persist in one transaction-shaped call. Keywords
 * are replaced wholesale each commit (no partial-patch keyword API) —
 * simplest semantics for Pass 1.2's add/edit/remove/reorder UI, which
 * already holds the full list client-side before saving. */
export async function commitProfile(input: unknown): Promise<ResearchProfile> {
  const parsed = ResearchProfileCommitInput.parse(input);
  const pid = await resolveProfessorId(parsed.professorId);
  const normalized = normalizeKeywords(parsed.keywords);

  const [existing] = await db.select().from(s.researchProfiles)
    .where(eq(s.researchProfiles.professorId, pid)).limit(1);

  const now = new Date();
  let profileId: number;
  let nextVersion: number;

  if (existing) {
    nextVersion = existing.version + 1;
    await db.update(s.researchProfiles)
      .set({ focusSynthesis: parsed.focusSynthesis ?? null, version: nextVersion, updatedAt: now })
      .where(eq(s.researchProfiles.id, existing.id));
    profileId = existing.id;
    await db.delete(s.researchProfileKeywords).where(eq(s.researchProfileKeywords.profileId, profileId));
  } else {
    nextVersion = 1;
    const [inserted] = await db.insert(s.researchProfiles).values({
      professorId: pid,
      focusSynthesis: parsed.focusSynthesis ?? null,
      version: nextVersion,
      updatedAt: now,
    }).returning({ id: s.researchProfiles.id });
    profileId = inserted.id;
  }

  if (normalized.length > 0) {
    await db.insert(s.researchProfileKeywords).values(
      normalized.map((k, i) => ({ profileId, value: k.value, provenance: k.provenance, position: i })),
    );
  }

  // Audit trail, same convention as routes/focus.ts's focus_update runs.
  await db.insert(s.agentRuns).values({
    kind: "research_profile_update",
    summary: { professorId: pid, keywordCount: normalized.length, version: nextVersion },
  });

  return getProfile(pid);
}
