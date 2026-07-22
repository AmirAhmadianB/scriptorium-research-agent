/** Sprint 6 Pass 1 spec item ("a debug bundle export (logs + config,
 * secrets redacted) for support"), surfaced in Settings per Pass 4. A
 * plain downloadable text file, not a real .zip — this project already
 * avoids adding dependencies where a simpler format does the job
 * (Sprint 5's PDF export chose reportlab over a LibreOffice/COM dependency
 * on the same reasoning), and a support attachment has no reason to be a
 * binary archive. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import { mode } from "../runtime.js";
import { dataDir, configDir, paths } from "../dataDir.js";
import { recentLogLines } from "../logging.js";

/** Config files never contain a provider API key by design (A2: keys live
 * only in the OS credential store, via services/ingest/.../provider_config.py's
 * keyring calls) — this is a defensive second layer, not the primary
 * safeguard, in case a future edit ever puts something sensitive in a YAML
 * comment or value by mistake. */
function redact(text: string): string {
  return text.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(\S+)/gi, "$1[redacted]");
}

function readRedacted(filePath: string): string {
  try {
    return redact(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return "(not present)";
  }
}

export default async function debugBundleRoutes(app: FastifyInstance) {
  app.get("/api/debug-bundle", async (_req, reply) => {
    const configFiles = ["focus.yaml", "sources.yaml", "funding.yaml", "models.yaml"]
      .map(name => `--- config/${name} ---\n${readRedacted(path.join(configDir, name))}`)
      .join("\n\n");

    const bundle = `Scriptorium debug bundle
Generated: ${new Date().toISOString()}
Mode: ${mode}
Platform: ${process.platform} ${os.release()}
Node: ${process.version}
Data dir: ${dataDir}
DB path: ${paths.db}

=== Recent log lines ===
${recentLogLines()}

=== Providers (redacted — never contains a raw key; see providers.json's own keyRef indirection) ===
${readRedacted(path.join(dataDir, "providers.json"))}

=== Config ===
${configFiles}
`;

    reply.header("Content-Disposition", `attachment; filename="scriptorium-debug-${Date.now()}.txt"`);
    reply.type("text/plain");
    return bundle;
  });
}
