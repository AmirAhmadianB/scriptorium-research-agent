/** Read/write config/focus.yaml — the control-plane file that drives every
 *  scan, trend brief, and funding match. The dashboard can now edit it
 *  directly (not just the /focus skill); every write still lands in
 *  agent_runs so there's an audit trail regardless of where the change
 *  came from. */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { parseDocument } from "yaml";
import { db } from "../db/client.js";
import * as s from "../db/schema.js";
import { configDir } from "../dataDir.js";

const FOCUS_PATH = path.join(configDir, "focus.yaml");

type Focus = {
  goal: string;
  fields: string[];
  keywords: { include: string[]; exclude: string[] };
  venues_of_interest: string[];
  seed_authors: string[];
  horizon_years: number;
  departments: string[];
};

type FocusPatch = { goal?: string; keywords?: { include?: string[]; exclude?: string[] } };

function readDoc() {
  return parseDocument(readFileSync(FOCUS_PATH, "utf8"));
}

function readFocus(): Focus {
  return readDoc().toJSON() as Focus;
}

/** Mutates only the given keys, preserving comments/ordering on the rest
 * (the same expectation the /focus skill's own instructions set). */
function writeFocus(patch: FocusPatch): { before: Focus; after: Focus } {
  const doc = readDoc();
  const before = doc.toJSON() as Focus;
  if (patch.goal !== undefined) doc.set("goal", patch.goal);
  if (patch.keywords?.include !== undefined) doc.setIn(["keywords", "include"], patch.keywords.include);
  if (patch.keywords?.exclude !== undefined) doc.setIn(["keywords", "exclude"], patch.keywords.exclude);
  writeFileSync(FOCUS_PATH, String(doc));
  return { before, after: doc.toJSON() as Focus };
}

export default async function focusRoutes(app: FastifyInstance) {
  app.get("/api/focus", async () => readFocus());

  app.post("/api/focus", async (req) => {
    const patch = (req.body ?? {}) as FocusPatch;
    const { before, after } = writeFocus(patch);
    await db.insert(s.agentRuns).values({
      kind: "focus_update",
      summary: {
        source: "dashboard",
        goal_changed: before.goal !== after.goal,
        keywords_include: after.keywords.include,
        keywords_exclude: after.keywords.exclude,
      },
    });
    return after;
  });
}
