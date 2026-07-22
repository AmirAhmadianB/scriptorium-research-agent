/** Sprint 6 Pass 3 — "this module's own directory," working under both
 * dev (tsx, genuine ESM, `import.meta.url` is real) and the packaged SEA
 * build (esbuild-bundled to CJS, where `import.meta.url` is statically
 * rewritten to nothing — see esbuild's own "empty-import-meta" warning —
 * but esbuild's CJS output defines real `__dirname`/`__filename` shims
 * resolved to the bundle's own location instead). `typeof __dirname` is
 * safe to probe even under real ESM: `typeof` never throws on an
 * undeclared identifier, unlike referencing it directly would. */
import { fileURLToPath } from "node:url";
import path from "node:path";

declare const __dirname: string | undefined;

export function moduleDir(importMetaUrl: string): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return path.dirname(fileURLToPath(importMetaUrl));
}
