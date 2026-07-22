/** Sprint 6 Pass 2 (A2) — the Settings panel's API. Pure plumbing onto
 * scriptorium_ingest.llm.provider_config, same convention as every other
 * route file here (routes/draft-editor.ts, funding-upload.ts): all
 * provider logic (redaction, keyring, live-validation calls) lives in
 * exactly one place on the Python side, this file has none of its own.
 * A raw API key only ever travels over stdin into the Python process
 * (upsert/validate), never as a CLI arg or in a GET query string. */
import type { FastifyInstance } from "fastify";
import { runIngestModule, runIngestModuleSync, runIngestModuleStdin } from "../pythonRunner.js";

export default async function providersRoutes(app: FastifyInstance) {
  /** Current connection (dev CLI label or the active provider) + the full
   * configured-providers list, redacted (never a keyRef, only hasKey). */
  app.get("/api/providers", async () => {
    const [connection, listing] = await Promise.all([
      runIngestModule(["scriptorium_ingest.llm.provider_config", "connection"], { timeoutMs: 15_000 }),
      runIngestModule(["scriptorium_ingest.llm.provider_config", "list"], { timeoutMs: 15_000 }),
    ]);
    return { connection, ...listing };
  });

  /** Add or edit a provider. Omitting apiKey on an edit keeps the
   * previously-stored key (provider_config.py's own rule) — this route
   * doesn't need to know or enforce that, just pass the body through. */
  app.post("/api/providers", async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string; kind?: string; model?: string };
    if (!body.name || !body.kind || !body.model) {
      reply.code(400);
      return { error: "name, kind, and model are required" };
    }
    try {
      return await runIngestModuleStdin(
        ["scriptorium_ingest.llm.provider_config", "upsert"], JSON.stringify(body),
      );
    } catch (e: any) {
      reply.code(400);
      return { error: e?.message ?? String(e) };
    }
  });

  /** Live validation — a real minimal completion call, not a shape check.
   * Body is either a not-yet-saved draft ({kind, model, baseUrl, apiKey})
   * or {name} to re-check an already-saved provider without re-entering
   * its key (the dashboard never has the keyRef to pass back in). */
  app.post("/api/providers/validate", async (req, reply) => {
    try {
      return await runIngestModuleStdin(
        ["scriptorium_ingest.llm.provider_config", "validate"], JSON.stringify(req.body ?? {}), 25_000,
      );
    } catch (e: any) {
      reply.code(500);
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /** Switch the active provider — takes effect on the NEXT agent call, no
   * restart, since every call re-reads providers.json via
   * provider_config.active_provider_raw() rather than caching it. */
  app.post("/api/providers/:name/activate", async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = runIngestModuleSync(
      ["scriptorium_ingest.llm.provider_config", "activate", "--name", name],
    ) as { error?: string };
    if (result.error) reply.code(400);
    return result;
  });

  app.post("/api/providers/deactivate", async () => {
    // Sprint 6 Pass 1 (A0): "Dev mode keeps the CLI as its default
    // transport" — deactivating always falls back to it in dev, or to
    // degraded mode in packaged, per llm/dispatch.py's own rule.
    return runIngestModuleSync(["scriptorium_ingest.llm.provider_config", "activate", "--name", "none"]);
  });

  app.delete("/api/providers/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const result = runIngestModuleSync(
      ["scriptorium_ingest.llm.provider_config", "remove", "--name", name],
    ) as { error?: string };
    if (result.error) reply.code(404);
    return result;
  });
}
