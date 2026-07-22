# Contributing to Scriptorium

Thanks for considering a contribution. This is an early-stage, single-maintainer
project — please open an issue to discuss non-trivial changes before sending a
pull request, so we don't duplicate effort or diverge from the roadmap in
`GOALS.md`.

## Dev setup

Prerequisites: Node.js 24, [pnpm](https://pnpm.io) 10, Python 3.13.

```bash
git clone https://github.com/AmirAhmadianB/scriptorium-research-agent.git
cd scriptorium-research-agent
cp .env.example .env          # fill in whichever keys you need for the area you're touching
pnpm install
pnpm db:push                  # creates data/scriptorium.db (gitignored, local only)
pnpm dev                      # runs the api + dashboard together
```

For the Python ingest workers:

```bash
cd services/ingest
python -m venv .venv && .venv\Scripts\activate   # (or `source .venv/bin/activate` on macOS/Linux)
pip install -r requirements.txt
pytest
```

## Before opening a PR

- `pnpm --filter @scriptorium/dashboard build` and `pnpm --filter @scriptorium/api test`
  should pass locally — CI runs both.
- `python -m compileall services/ingest/scriptorium_ingest` should succeed.
- Any `config/*.yaml` you touch must still parse as valid YAML.
- Keep secrets out of commits — never add real values to `.env.example`, and
  double-check `git status`/`git diff` before pushing.

## Branch & commit conventions

- Branch names: `feat/<short-description>`, `fix/<short-description>`,
  `docs/<short-description>`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`, `refactor: ...`. Scope in
  parentheses when it helps, e.g. `feat(api): add funding deadline endpoint`.
- Keep PRs focused — one logical change per PR is easier to review than a
  bundle of unrelated fixes.

## Adding a slash-command skill

Skills live under `.claude/skills/<name>/SKILL.md` and follow this shape:

```markdown
---
name: my-skill
description: One sentence — what it does and when to use it.
allowed-tools: Bash, Read, Grep   # whichever tools the skill actually needs
context: fork                     # or omit if it should run inline
---
Step-by-step instructions for the agent executing this skill.
```

Add it to the skill table in `README.md` once it's working, and to
`docs/MODEL-ROUTING.md` if it has a specific model preference.

## Adding a subagent

Subagents live under `.claude/agents/<name>.md` with YAML frontmatter
(`description`, `model`, and any tool restrictions) followed by the system
prompt for that agent. Look at an existing agent close to what you're building
(e.g. `.claude/agents/reference-librarian.md` for a corpus-hygiene-style agent,
`.claude/agents/literature-scout.md` for a discovery-style agent) as a
starting template, and respect the privacy/compliance invariants described in
`docs/COMPLIANCE.md` and `CLAUDE.md` — in particular, `professor_id` scoping
and `private: true` exclusion from cross-professor queries are non-negotiable
in any new agent that touches corpus data.

## Code of conduct

Participation in this project is governed by our
[Code of Conduct](CODE_OF_CONDUCT.md).
