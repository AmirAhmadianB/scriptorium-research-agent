/** Sprint 4 (C2) — custom funding opportunities by upload. Two-step flow,
 * same shape as research-profile.ts's /derive + POST /api/research-profile
 * pattern already established: this route only PARSES + EXTRACTS and
 * returns an editable preview (nothing saved yet); the researcher's
 * confirmed/edited fields are what actually gets persisted, via the
 * EXISTING POST /api/funding route (extended, not duplicated — see its
 * own comment). Files are saved durably under data/uploads/funding/ (not
 * a temp dir that gets cleaned up) so "the original file remains
 * retrievable from the record" holds after the process restarts. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { paths } from "../dataDir.js";
import { runIngestModule } from "../pythonRunner.js";

const UPLOAD_DIR = paths.uploads;
const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx"]);

export default async function fundingUploadRoutes(app: FastifyInstance) {
  /** Parse + LLM-extract only — nothing written to funding_opportunities
   * yet. Returns the extracted fields (editable preview) plus a
   * sourceFileUrl the confirm step (POST /api/funding) passes straight
   * through unchanged. */
  app.post("/api/funding/extract-upload", async (req, reply) => {
    let filePart: { filename: string; buffer: Buffer } | null = null;
    let sponsorHint = "";
    // req.parts() (not .files()) — this route needs BOTH the file part and
    // a plain text field (sponsorHint) in the same multipart body; .files()
    // only yields file-typed parts and would silently drop the field.
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const ext = path.extname(part.filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          await part.toBuffer();
          reply.code(400);
          return { error: `Unsupported file type ${ext || "(none)"} — supported: .pdf, .docx` };
        }
        filePart = { filename: part.filename, buffer: await part.toBuffer() };
      } else if (part.fieldname === "sponsorHint") {
        sponsorHint = String(part.value ?? "");
      }
    }
    if (!filePart) {
      reply.code(400);
      return { error: "No file uploaded" };
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const ext = path.extname(filePart.filename).toLowerCase();
    const digest = createHash("sha1").update(filePart.buffer).digest("hex").slice(0, 16);
    const storedName = `${Date.now()}-${digest}${ext}`;
    await writeFile(path.join(UPLOAD_DIR, storedName), filePart.buffer);
    const sourceFileUrl = `/api/funding/uploads/${storedName}`;

    try {
      const extracted = await runIngestModule([
        "scriptorium_ingest.funding.crawl_funding",
        "--extract-file", path.join(UPLOAD_DIR, storedName), "--sponsor-hint", sponsorHint,
      ]);
      return {
        sourceFileUrl, originalFilename: filePart.filename,
        program: extracted.program ?? null, sponsor: extracted.sponsor ?? sponsorHint ?? null,
        deadline: extracted.deadline ?? null, deadlineUncertain: !!extracted.deadline_uncertain,
        amount: extracted.amount ?? null, duration: extracted.duration ?? null,
        eligibility: extracted.eligibility ?? null, keywords: extracted.keywords ?? [],
        priorities: extracted.priorities ?? null, requirements: extracted.requirements ?? null,
        proposalTemplate: extracted.proposal_structure ?? null,
        submissionFormat: extracted.submission_format ?? null,
      };
    } catch (e: any) {
      // Extraction failing is not fatal to the upload — the researcher can
      // still fill the preview form manually (spec: "the preview doubles
      // as a manual-entry form when no file is uploaded"; a failed-to-
      // extract upload degrades to that same empty-form case, file kept).
      reply.code(200);
      return {
        sourceFileUrl, originalFilename: filePart.filename,
        program: null, sponsor: sponsorHint || null, deadline: null, deadlineUncertain: false,
        amount: null, duration: null, eligibility: null, keywords: [],
        priorities: null, requirements: null, proposalTemplate: null, submissionFormat: null,
        extractionError: e?.message ?? String(e),
      };
    }
  });

  /** "the original file remains retrievable from the record" — a plain
   * read-and-send, no new static-file-serving dependency for one route. */
  app.get("/api/funding/uploads/:filename", async (req, reply) => {
    const { filename } = req.params as { filename: string };
    // No path traversal: only a bare filename we ourselves generated
    // (timestamp-digest.ext) is ever valid; reject anything with a
    // separator before it ever touches the filesystem.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      reply.code(400);
      return { error: "invalid filename" };
    }
    try {
      const buf = await readFile(path.join(UPLOAD_DIR, filename));
      const ext = path.extname(filename).toLowerCase();
      reply.type(ext === ".pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return buf;
    } catch {
      reply.code(404);
      return { error: "file not found" };
    }
  });
}
