/** Sprint 5 Pass 6 (comment 13) — the editable draft surface's API. Every
 * route here delegates to analyze/draft_editor.py / export_proposal.py so
 * the citation-numbering/reference-list logic stays in exactly one place
 * (proposal_orchestrator.py's _render_citations, called transitively) —
 * this file is pure plumbing, no citation logic of its own. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { runIngestModule, runIngestModuleStdin } from "../pythonRunner.js";

async function runDraftEditor(args: string[], timeoutMs = 5 * 60_000): Promise<any> {
  return runIngestModule(["scriptorium_ingest.analyze.draft_editor", ...args], { timeoutMs });
}

/** save/set-comment-status pass their payload over stdin (not a CLI arg —
 * editor content can exceed Windows' command-line length limit), same
 * convention as server.ts's runPythonStdin for the funding extraction call. */
function runDraftEditorStdin(args: string[], stdin: string, timeoutMs = 30_000): Promise<any> {
  return runIngestModuleStdin(["scriptorium_ingest.analyze.draft_editor", ...args], stdin, timeoutMs);
}

export default async function draftEditorRoutes(app: FastifyInstance) {
  /** Loads (creating on first open — the agent-generated text becomes
   * version 1) the editable working copy, its version history, any
   * feedback rounds, and the citation pool the editor needs to render a
   * live, correctly-numbered reference list. */
  app.get("/api/proposal/sessions/:id/drafts/:sectionKey", async (req, reply) => {
    const { id, sectionKey } = req.params as { id: string; sectionKey: string };
    try {
      return await runDraftEditor(["--session-id", id, "--section-key", sectionKey, "--get"]);
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Continuous autosave — updates the live working copy only, never
   * creates a version checkpoint (comment 13's distinction between "the
   * working copy" and "a version"). No LLM call. */
  app.post("/api/proposal/sessions/:id/drafts/:sectionKey/autosave", async (req, reply) => {
    const { id, sectionKey } = req.params as { id: string; sectionKey: string };
    const { contentJson, plainText } = (req.body ?? {}) as { contentJson?: unknown; plainText?: string };
    if (contentJson === undefined || plainText === undefined) {
      reply.code(400);
      return { error: "contentJson and plainText are required" };
    }
    try {
      return await runDraftEditorStdin(
        ["--session-id", id, "--section-key", sectionKey, "--save"],
        JSON.stringify({ contentJson, plainText }),
      );
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Researcher-initiated only (comment 13: "nothing drafts or edits
   * unprompted") — snapshots the current edit as a new checkpoint, diffs
   * it against the prior one, and asks the reviewer_critique model for
   * span-anchored comments. Never rewrites the draft itself. */
  app.post("/api/proposal/sessions/:id/drafts/:sectionKey/request-feedback", async (req, reply) => {
    const { id, sectionKey } = req.params as { id: string; sectionKey: string };
    try {
      return await runDraftEditor(["--session-id", id, "--section-key", sectionKey, "--request-feedback"]);
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Accept/reject/ignore ONE comment — pure bookkeeping, no LLM call, no
   * side effect on the draft text itself (accepting a suggestion is a
   * SEPARATE, explicit edit the researcher makes via the editor, not
   * something this route applies automatically). */
  app.post("/api/proposal/sessions/:id/drafts/:sectionKey/feedback/:feedbackId/comments/:commentId", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { feedbackId, commentId } = req.params as { feedbackId: string; commentId: string };
    const { status } = (req.body ?? {}) as { status?: string };
    if (!status) {
      reply.code(400);
      return { error: "status is required" };
    }
    try {
      return await runDraftEditorStdin(
        ["--session-id", id, "--set-comment-status"],
        JSON.stringify({ feedbackId: Number(feedbackId), commentId: Number(commentId), status }),
      );
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Export — one shared compile_document() feeds both formats, so a
   * .docx and a .pdf of the same session can never show different text or
   * a different reference list. Writes to a throwaway temp file (binary
   * content can't safely round-trip through captured stdout as text) and
   * streams it back, then cleans up. */
  app.get("/api/proposal/sessions/:id/export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { format = "docx" } = req.query as { format?: string };
    if (format !== "docx" && format !== "pdf") {
      reply.code(400);
      return { error: "format must be docx or pdf" };
    }
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scriptorium-export-"));
    const outPath = path.join(tmpDir, `proposal-${id}.${format}`);
    try {
      await runIngestModule(
        ["scriptorium_ingest.analyze.export_proposal", "--session-id", id, "--format", format, "--out", outPath],
        { timeoutMs: 60_000 },
      );
      const buf = await readFile(outPath);
      reply.header("Content-Disposition", `attachment; filename="proposal-${id}.${format}"`);
      reply.type(format === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf");
      return buf;
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
