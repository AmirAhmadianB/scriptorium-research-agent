/** Model matrix — evidence for config/models.yaml routing decisions.
 *
 *  For every model in `candidates_for_matrix` × every task in tasks.yaml:
 *    run → score → time → estimate cost → write eval/report.md
 *
 *  Scoring: exact_json = per-field match vs gold (normalized strings);
 *           judge      = eval_judge model applies the task's rubric.
 *
 *  Calls go through the local Claude Code CLI (claudeComplete below) rather
 *  than @anthropic-ai/sdk, so this rides the operator's Claude subscription
 *  instead of needing a separate billed ANTHROPIC_API_KEY — same pattern as
 *  services/ingest/scriptorium_ingest/claude_cli.py on the Python side.
 *  Run:  npx tsx run-matrix.ts
 *  Optional env overrides for a single run without editing models.yaml:
 *    EVAL_SKIP_MODELS=claude-fable-5   (comma-separated, e.g. when rate-limited)
 *    EVAL_JUDGE_MODEL=claude-opus-4-8  (substitute the configured eval_judge model)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const routing = parse(readFileSync("../config/models.yaml", "utf8"));
const { tasks } = parse(readFileSync("tasks.yaml", "utf8")) as { tasks: any[] };
const SKIP = new Set((process.env.EVAL_SKIP_MODELS ?? "").split(",").map(s => s.trim()).filter(Boolean));
const MODELS: string[] = routing.candidates_for_matrix.filter((m: string) => !SKIP.has(m));
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || routing.tasks.eval_judge.model;

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Windows npm installs `claude` as a .cmd shim; spawning it directly without
// a shell fails to resolve it, but shell:true naively concatenates argv into
// a string without escaping (Node's own deprecation warning) — which silently
// drops empty-string args like `--tools ""`. Route through cmd.exe's own PATH
// resolution instead, as a real argv array, same fix as the Python side
// (services/ingest/scriptorium_ingest/claude_cli.py).
const CLAUDE_CMD = process.platform === "win32" ? ["cmd", "/c", "claude"] : ["claude"];

/** Headless `claude -p` call; prompt via stdin (no argv length limit).
 * Retries on transient exit-1s, which happen when another Claude Code
 * process (e.g. this very session) is active on the machine at the same
 * moment — confirmed transient, not deterministic, on the Python side. */
async function claudeComplete(prompt: string, model: string, attempts = 4): Promise<{ text: string; inTok: number; outTok: number }> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const [cmd, ...cmdArgs] = CLAUDE_CMD;
    const r = spawnSync(cmd, [...cmdArgs, "--model", model, "-p", "--output-format", "json", "--tools", ""], {
      input: prompt, encoding: "utf-8", maxBuffer: 1024 * 1024 * 20,
    });
    if (r.status === 0) {
      const data = JSON.parse(r.stdout);
      if (!data.is_error) {
        const u = data.usage ?? {};
        return { text: data.result as string, inTok: u.input_tokens ?? 0, outTok: u.output_tokens ?? 0 };
      }
      lastErr = new Error(`claude CLI error: ${JSON.stringify(data.result ?? data).slice(0, 500)}`);
    } else {
      lastErr = new Error(`claude CLI exited ${r.status}: stderr=${(r.stderr ?? "").slice(0, 500)} stdout=${(r.stdout ?? "").slice(0, 500)}`);
    }
    if (i < attempts - 1) await sleep(Math.min(30000, 3000 * 2 ** i));
  }
  throw lastErr;
}

// $/MTok (input, output) — refresh from https://docs.claude.com/en/docs/about-claude/pricing
const PRICE: Record<string, [number, number]> = {
  "claude-fable-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5-20251001": [1, 5],
};

const norm = (s: unknown) =>
  String(s ?? "").toLowerCase().replace(/[\s\u2013\u2014-]+/g, " ").trim();

function scoreExactJson(raw: string, goldFile: string): { score: number; note: string } {
  const gold = JSON.parse(readFileSync(goldFile, "utf8"));
  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/^```(json)?|```$/gm, "").trim());
  } catch {
    return { score: 0, note: "invalid JSON" };
  }
  const pairs: [any, any][] = Array.isArray(gold)
    ? gold.map((g: any, i: number) => [g, parsed?.[i]])
    : [[gold, parsed]];
  let hit = 0, total = 0, misses: string[] = [];
  for (const [g, p] of pairs)
    for (const k of Object.keys(g)) {
      total++;
      if (typeof g[k] === "boolean" ? p?.[k] === g[k]
        : norm(p?.[k]).includes(norm(g[k])) || norm(g[k]).includes(norm(p?.[k])))
        hit++;
      else misses.push(k);
    }
  return { score: Math.round((hit / total) * 100) / 10, note: misses.length ? `missed: ${[...new Set(misses)].join(",")}` : "clean" };
}

async function scoreJudge(raw: string, rubric: string): Promise<{ score: number; note: string }> {
  const { text } = await claudeComplete(`${rubric}\n\nCandidate text:\n---\n${raw}\n---`, JUDGE_MODEL);
  try {
    const j = JSON.parse(text.replace(/^```(json)?|```$/gm, "").trim());
    return { score: Math.round((j.total / 40) * 100) / 10, note: j.weakest ?? "" };
  } catch { return { score: 0, note: "judge output unparsable" }; }
}

const rows: string[] = [];
for (const task of tasks) {
  const input = readFileSync(task.input_file, "utf8");
  const prompt = task.prompt.replace("{input}", input);
  for (const model of MODELS) {
    const t0 = Date.now();
    let raw = "", inTok = 0, outTok = 0, err = "";
    try {
      const r = await claudeComplete(prompt, model);
      raw = r.text; inTok = r.inTok; outTok = r.outTok;
    } catch (e: any) { err = e?.message ?? String(e); }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    const { score, note } = err
      ? { score: 0, note: `ERROR ${err.slice(0, 60)}` }
      : task.kind === "exact_json"
        ? scoreExactJson(raw, task.gold_file)
        : await scoreJudge(raw, task.rubric);

    const [pi, po] = PRICE[model] ?? [0, 0];
    const cost = ((inTok * pi + outTok * po) / 1e6).toFixed(4);
    rows.push(`| ${task.id} | ${model} | **${score}/10** | ${secs}s | $${cost} | ${note} |`);
    console.log(`${task.id} × ${model}: ${score}/10 (${secs}s, $${cost}) ${note}`);
  }
}

const report = `# Model matrix — ${new Date().toISOString().slice(0, 10)}

Verify PRICE table against current pricing before trusting the cost column.

| task | model | quality | latency | cost/run | note |
|---|---|---|---|---|---|
${rows.join("\n")}

## How to read this
For each task: take the cheapest model within ~0.5 points of the best, unless
the task is user-facing prose (proposal-paragraph), where quality wins.
Update \`config/models.yaml\` accordingly, or run \`/test-models\` in Claude
Code and let it propose the edit.
`;
writeFileSync("report.md", report);
console.log("\nwrote eval/report.md");
