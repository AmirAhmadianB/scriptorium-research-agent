/** Pass 2.1 — Corpus tab folder selector.
 *
 * File-access model (per Pass 0): this dashboard is pure web (no Electron/
 * desktop shell — desktop/windows/launch.ps1 just opens the Vite dev URL in
 * the default browser), but the API server IS a local backend with real
 * filesystem access on the researcher's own machine. A browser has no way
 * to hand a backend an arbitrary absolute path (no native folder dialog
 * without Electron, and a typed path is fragile — wrong OS separators, no
 * existence check until submit). So the mechanism used here is: the
 * browser's native directory picker (`<input type=file webkitdirectory>`,
 * supported cross-browser) lets the researcher pick a folder locally: we
 * then upload its files (same multipart pattern as Pass 1.3's document
 * upload) into the EXISTING pdf_folder library-inbox convention
 * (services/ingest/library-inbox/<professorId>/, config/sources.yaml) —
 * reusing the already-built connector rather than inventing a parallel one.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { paths } from "../dataDir.js";
import { runIngestModuleSync } from "../pythonRunner.js";
// @fastify/multipart is already registered once globally by
// routes/research-profile.ts — registering it a second time here would
// throw ("multipart/form-data parser already present"), so this route
// relies on that existing registration instead.

function professorLibraryDir(professorId: string): string {
  return path.join(paths.libraryInbox, professorId);
}

async function listLibrary(professorId: string) {
  const dir = professorLibraryDir(professorId);
  try {
    const files = await readdir(dir);
    const pdfs = files.filter(f => f.toLowerCase().endsWith(".pdf"));
    const sized = await Promise.all(pdfs.map(async f => {
      const st = await stat(path.join(dir, f));
      return { name: f, sizeBytes: st.size };
    }));
    return { folderPath: dir, fileCount: sized.length, files: sized };
  } catch {
    return { folderPath: dir, fileCount: 0, files: [] };
  }
}

export default async function corpusLibraryRoutes(app: FastifyInstance) {
  app.get("/api/corpus/library", async (req) => {
    const { professorId = "default" } = req.query as { professorId?: string };
    return listLibrary(professorId);
  });

  app.post("/api/corpus/library", async (req, reply) => {
    const professorId = "default"; // no professor-switcher UI yet (Change-1 scope note applies here too)
    const dir = professorLibraryDir(professorId);
    await mkdir(dir, { recursive: true });

    let savedCount = 0;
    const rejected: string[] = [];
    let sawAnyFile = false;
    for await (const part of req.files()) {
      sawAnyFile = true;
      const name = part.filename;
      if (!name.toLowerCase().endsWith(".pdf")) {
        rejected.push(name);
        await part.toBuffer();
        continue;
      }
      const buf = await part.toBuffer();
      // Flatten any subfolder structure from the picked directory —
      // just the filename, deduped by overwrite (re-selecting the same
      // folder is idempotent, matching the Gate's "handle re-selection").
      await writeFile(path.join(dir, path.basename(name)), buf);
      savedCount++;
    }

    if (!sawAnyFile) {
      reply.code(400);
      return { error: "No files were uploaded — the selected folder may be empty.", savedCount: 0, rejected: [] };
    }
    if (savedCount === 0) {
      reply.code(400);
      return {
        error: `No PDF files found among ${rejected.length} selected file(s) — only .pdf is supported.`,
        savedCount: 0, rejected,
      };
    }

    const registered = runIngestModuleSync(["scriptorium_ingest.library.watch_folder"]);

    const library = await listLibrary(professorId);
    return { savedCount, rejected, registered, ...library };
  });

  /** Pass 2.3 Gate: "removing one removes it from retrieval." Digest the
   * file BEFORE deleting it (same sha1 convention library/watch_folder.py
   * used to create the papers row), so the Python-side cleanup can find
   * the matching paper/chunks/synthesis to update — then delete the file
   * itself only after that DB cleanup succeeds. */
  app.delete("/api/corpus/library", async (req, reply) => {
    const { filename } = (req.body ?? {}) as { filename?: string };
    if (!filename) {
      reply.code(400);
      return { error: "filename is required" };
    }
    const professorId = "default";
    const filePath = path.join(professorLibraryDir(professorId), path.basename(filename));
    let digest: string;
    try {
      const buf = await readFile(filePath);
      digest = createHash("sha1").update(buf).digest("hex");
    } catch {
      reply.code(404);
      return { error: `File not found: ${filename}` };
    }

    const removal = runIngestModuleSync([
      "scriptorium_ingest.analyze.corpus_ingest", "--professor", professorId, "--remove-digest", digest,
    ]) as { error?: string };
    if (removal.error) {
      reply.code(500);
      return removal;
    }

    await rm(filePath, { force: true });
    const library = await listLibrary(professorId);
    return { removal, ...library };
  });
}
