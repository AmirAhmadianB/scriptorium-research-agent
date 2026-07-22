# Model routing — why each task runs where it runs

Principle: route by (ambiguity × audience), not by prestige. A funding page
has low ambiguity and no human audience → cheapest capable model. A proposal
paragraph has high ambiguity and a hostile human audience (referee #2) →
frontier model.

Current defaults (config/models.yaml):
- **Haiku 4.5** — crawl extraction, relevance triage, metadata cleanup.
  These are schema-filling jobs; the eval's structured-extraction tasks
  measure exactly this, and Haiku's error mode (missed field) is cheap to
  catch downstream, unlike a drafting error.
- **Sonnet 4.6** — summaries, trend briefs, funding-match rationales,
  librarian judgment calls. Needs synthesis but reads like notes, not prose
  a program officer grades.
- **Fable 5** — deep paper analysis, proposal & manuscript drafting,
  referee critique, and the eval judge. The judge is deliberately the
  strongest model so weaker models can't grade themselves kindly.

Keep it evidence-based: `/test-models` (eval/run-matrix.ts) sweeps every
candidate over the three benchmark tasks and reports quality/latency/cost.
Re-run after every model release or price change; the decision rule is in
the report footer (cheapest within ~0.5 quality points wins, except
user-facing prose). Add department-specific fixtures over time — a
humanities proposal paragraph stresses different muscles than a physics one.
