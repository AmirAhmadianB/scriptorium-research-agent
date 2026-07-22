/** Pass 2.2 — the API can't run ONNX/fastembed itself, so a query
 * embedding is computed by shelling out to the same Python embed.py used
 * for ingestion (services/ingest/scriptorium_ingest/analyze/embed.py),
 * guaranteeing the query and the corpus vectors always come from the
 * identical model/backend. Same execFile-a-Python-worker convention as
 * routes/scan.ts and routes/corpus-library.ts. */
import { runIngestModule } from "./pythonRunner.js";

export async function embedQuery(text: string): Promise<number[]> {
  const parsed = await runIngestModule(["scriptorium_ingest.analyze.embed", text], { timeoutMs: 30_000 });
  if (!Array.isArray(parsed.embedding)) throw new Error("embed CLI response missing 'embedding' array");
  return parsed.embedding;
}
