---
name: test-models
description: Benchmark the candidate Claude models on this system's real tasks (extraction accuracy, summary fidelity, drafting quality) and report quality/latency/cost so routing in config/models.yaml stays evidence-based.
allowed-tools: Bash, Read
context: fork
---
1. `cd eval && npx tsx run-matrix.ts`
2. Read `eval/report.md` when it finishes.
3. Summarize: per task, which model won on quality, what the cheapest model within 5% of the best was, and the estimated cost per 1,000 runs.
4. Recommend concrete edits to `config/models.yaml` (task → model) with one-line justifications. Apply them only if the user confirms.
