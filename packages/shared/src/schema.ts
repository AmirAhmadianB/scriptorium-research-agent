/** ResearchProfile — the single shared schema for Scriptorium's global
 * research-focus context (see dashboard-revision-brief.docx, Change 1).
 *
 * This is the ONE definition consumed by both the API (validation +
 * persistence, apps/api/src/profile/store.ts) and the dashboard (inline
 * form validation, Pass 1.2+) — the brief's Pass 1.2 Gate requires
 * "validation matches the shared schema exactly", so this module has no
 * per-app duplicate. Keep it free of any backend-only or frontend-only
 * dependency (no Drizzle, no React) so both sides can import it cheaply.
 *
 * No discipline/domain literal belongs anywhere in this file — the whole
 * point of Change 1 is that fields, examples, and defaults here are
 * generic across research fields.
 */
import { z } from "zod";

/** Below this many keywords the profile is DRAFT; at or above, ACTIVE.
 * Governs feature reactivation the same way regardless of whether the
 * keywords arrived by typing (Pass 1.2) or document upload (Pass 1.3). */
export const KEYWORD_MIN_FOR_ACTIVE = 5;

export const KeywordProvenance = z.enum(["manual", "derived"]);
export type KeywordProvenance = z.infer<typeof KeywordProvenance>;

export const ProfileKeywordInput = z.object({
  value: z.string().trim().min(1, "Keyword cannot be empty").max(80, "Keyword is too long (max 80 characters)"),
  provenance: KeywordProvenance,
});
export type ProfileKeywordInput = z.infer<typeof ProfileKeywordInput>;

export const ProfileKeyword = ProfileKeywordInput.extend({
  id: z.number().int().positive(),
});
export type ProfileKeyword = z.infer<typeof ProfileKeyword>;

/** What a client sends to commit a new profile state. All keywords are
 * replaced wholesale on commit (simpler + matches "reorder" in Pass 1.2 —
 * order is just array order, no separate position field to keep in sync). */
export const ResearchProfileCommitInput = z.object({
  professorId: z.string().trim().min(1).optional(),
  keywords: z.array(ProfileKeywordInput).max(200, "Too many keywords (max 200)"),
  focusSynthesis: z.string().trim().max(4000, "Focus synthesis is too long (max 4000 characters)").nullable().optional(),
});
export type ResearchProfileCommitInput = z.infer<typeof ResearchProfileCommitInput>;

export const ProfileStatus = z.enum(["DRAFT", "ACTIVE"]);
export type ProfileStatus = z.infer<typeof ProfileStatus>;

/** The read shape: what the provider/consumers see. */
export const ResearchProfile = z.object({
  professorId: z.string(),
  keywords: z.array(ProfileKeyword),
  focusSynthesis: z.string().nullable(),
  status: ProfileStatus,
  version: z.number().int().nonnegative(),
  updatedAt: z.string().nullable(), // ISO 8601, or null for a never-committed default profile
});
export type ResearchProfile = z.infer<typeof ResearchProfile>;

export function statusForKeywordCount(count: number): ProfileStatus {
  return count >= KEYWORD_MIN_FOR_ACTIVE ? "ACTIVE" : "DRAFT";
}

/** Neutral, empty profile for a professor who has never set one — the
 * DRAFT default every feature/consumer must degrade to gracefully. */
export function emptyProfile(professorId: string): ResearchProfile {
  return {
    professorId,
    keywords: [],
    focusSynthesis: null,
    status: "DRAFT",
    version: 0,
    updatedAt: null,
  };
}

/** Normalize a raw list of keyword inputs: trim, drop empties, case-fold
 * for de-dup comparison while preserving first-seen casing for display.
 * A manual entry wins over a derived one on collision (a user typing a
 * keyword that a document upload also suggested should read as theirs). */
export function normalizeKeywords(raw: ProfileKeywordInput[]): ProfileKeywordInput[] {
  const seen = new Map<string, ProfileKeywordInput>();
  for (const k of raw) {
    const value = k.value.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { value, provenance: k.provenance });
    } else if (existing.provenance === "derived" && k.provenance === "manual") {
      seen.set(key, { value, provenance: "manual" });
    }
  }
  return [...seen.values()];
}
