/** Sprint 2 Pass 4 (comment 4) — reads config/funding.yaml's
 * `default_scopes` so the Canada-scoping filter is configuration, not a
 * hardcoded country check (same pattern scheduler.ts already uses for
 * config/sources.yaml). Cached in-process; the file only changes by a
 * human editing it and restarting, same as every other config/*.yaml this
 * project reads. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { configDir } from "./dataDir.js";

const FUNDING_YAML = path.join(configDir, "funding.yaml");

let cachedDefaultScopes: string[] | null = null;

export function getDefaultFundingScopes(): string[] {
  if (cachedDefaultScopes) return cachedDefaultScopes;
  try {
    const cfg = parse(readFileSync(FUNDING_YAML, "utf8"));
    cachedDefaultScopes = cfg?.default_scopes ?? ["national", "provincial", "internal"];
  } catch {
    cachedDefaultScopes = ["national", "provincial", "internal"];
  }
  return cachedDefaultScopes;
}
