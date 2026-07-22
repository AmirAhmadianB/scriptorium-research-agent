/** Read/commit the Research Focus profile (dashboard-revision-brief.docx,
 *  Change 1), and derive keyword/synthesis proposals from uploaded
 *  documents (Pass 1.3) — the second of the two ways to set the profile.
 *  The derive route only PROPOSES; nothing is applied until the frontend
 *  calls the existing commit route with the researcher's edited/confirmed
 *  keywords, same as a manual edit. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { consumerRegistry, getDiagnosticLog } from "../profile/registry.js"; // side-effect import also wires registry to provider's change event
import { profileProvider } from "../profile/provider.js";
import { runIngestModule } from "../pythonRunner.js";

const SUPPORTED_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

async function runFocusExtractor(filePaths: string[]): Promise<unknown> {
  try {
    return await runIngestModule(
      ["scriptorium_ingest.analyze.focus_extractor", ...filePaths], { timeoutMs: 3 * 60_000 },
    );
  } catch (e: any) {
    return { keywords: [], focusSynthesis: "", errors: [e?.message ?? String(e)] };
  }
}

export default async function researchProfileRoutes(app: FastifyInstance) {
  // @fastify/multipart is registered once, globally, in server.ts — NOT
  // here. Registering it inside this plugin function would only attach
  // its content-type parser to this plugin's own encapsulated scope
  // (Fastify's default plugin isolation), leaving sibling route files
  // like corpus-library.ts with no parser and a 415 on every upload —
  // hit exactly this bug live in Pass 2.1's Gate before moving the
  // registration to server.ts's root instance.
  app.get("/api/research-profile", async (req) => {
    const { professorId } = req.query as { professorId?: string };
    return profileProvider.getCurrent(professorId);
  });

  app.post("/api/research-profile", async (req, reply) => {
    try {
      return await profileProvider.commit(req.body);
    } catch (err) {
      reply.code(400);
      return { error: err instanceof Error ? err.message : "Invalid research profile input" };
    }
  });

  /** Pass 1.4 diagnostic: live view into the reactive loop — which
   * consumers are registered, whether each is mid-debounce (`pending`),
   * and (for the temporary diagnostic consumer) the actual profiles it
   * has applied. Not a feature endpoint; exists so the reactive loop is
   * observable from outside the process (tests, this pass's live Gate). */
  app.get("/api/research-profile/_consumers", async () => ({
    consumers: consumerRegistry.getState(),
    diagnosticLog: getDiagnosticLog(),
  }));

  /** Propose keywords + a focus synthesis from uploaded documents. Read-only
   *  with respect to the profile — applying the result is a separate,
   *  explicit POST /api/research-profile once the researcher confirms. */
  app.post("/api/research-profile/derive", async (req, reply) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "scriptorium-upload-"));
    try {
      const savedPaths: string[] = [];
      const rejected: string[] = [];
      for await (const part of req.files()) {
        const ext = path.extname(part.filename).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
          rejected.push(part.filename);
          await part.toBuffer(); // drain the part even if we're not keeping it
          continue;
        }
        const buf = await part.toBuffer();
        const dest = path.join(tmpDir, `${savedPaths.length}${ext}`);
        await writeFile(dest, buf);
        savedPaths.push(dest);
      }

      if (savedPaths.length === 0) {
        reply.code(400);
        return {
          keywords: [], focusSynthesis: "",
          errors: rejected.length
            ? [`Unsupported file type(s): ${rejected.join(", ")} — supported: .pdf, .docx, .txt, .md`]
            : ["No files uploaded"],
        };
      }

      const result = await runFocusExtractor(savedPaths);
      if (rejected.length && typeof result === "object" && result !== null) {
        const r = result as { errors?: string[] };
        r.errors = [...(r.errors ?? []), `Skipped unsupported file(s): ${rejected.join(", ")}`];
      }
      return result;
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
}
