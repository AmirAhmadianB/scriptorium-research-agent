/** Headless orchestrator — runs the same skills/subagents Claude Code uses
 *  interactively, but from cron/CI (nightly scans, scheduled trend briefs).
 *
 *  The Agent SDK reads .claude/skills and .claude/agents from cwd, so this
 *  process gets the identical toolbox to a terminal session.
 *  Usage:  npx tsx src/orchestrator.ts "/scan"
 *          npx tsx src/orchestrator.ts "/trends last 2 years"
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const routing = parse(readFileSync(new URL("../../../config/models.yaml", import.meta.url), "utf8"));
const prompt = process.argv.slice(2).join(" ") || "/scan";

for await (const message of query({
  prompt,
  options: {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)), // repo root: sees .claude/*
    model: routing.default,
    maxTurns: 30,
    allowedTools: ["Bash", "Read", "Grep", "Write", "WebFetch"],
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content ?? []) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (message.type === "result") {
    console.log(`\n--- done: ${message.subtype} | cost $${message.total_cost_usd?.toFixed(4)} ---`);
  }
}
