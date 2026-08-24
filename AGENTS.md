# AGENTS.md

Codebase-specific guidance for agents working in `can-bang`.

## Commands

- `make install` — install from the lockfile
- `make check` — typecheck + format + tests with **≥85% line coverage**
- `make quality-gates` — check + build
- `make demo` — run MVP / 0.2 / 0.3 demos against a live instance
- `make backup` / `make restore BACKUP=<dir>` — snapshot / restore data

## Delivery process

Follow [docs/process.md](docs/process.md): freeze the acceptance contract,
decompose Release → Phase → Feature → Issue with plain-language acceptance +
Gherkin + boundary contracts, implement in slices, and never claim evidence
you did not run.

At the end of every phase/release, run the review process:
`make review` for the evidence packet, then follow
[docs/review-process.md](docs/review-process.md) and append never-repeat rules
to [docs/lessons.md](docs/lessons.md). A review that produces no artifacts did
not happen. Rules carry a level — task, project, or global — and are promoted
when they recur or generalize; record promotions in the lessons promotion log.
The system is multi-user aware: levels also include **account** (every project
of one account) and **global** (every account on the instance); a global rule
is published to every account rather than kept in one account's scope.

## Protocol surface

The emulated product contract lives at `/agents.md` on a running instance and
in `server/src/routes/` (docs, collab, asks, org, pages, extras). The web UI
is `web/src/`; the MCP server is `mcp/src/`; the mde-compatible CLI is
`cli/src/`. Changes to HTTP behavior must keep REST/MCP/CLI parity and update
the contract tests.

## Constraints

- No commits/pushes/merges/deploys without the user's explicit request.
- No new direct dependencies without the Dependency Advisor workflow.
- Email/SMTP is out of scope (dropped by decision).
- SQLite single-writer (WAL); no external message queue.

## Agent work rules (CanBang board)

- Work in your own git worktree (`git worktree add ../can-bang-<role> -b <role>/<card>`); never commit on main.
- Remove your worktree once your PR is pushed (`git worktree remove ../can-bang-<role>`); never leave worktrees behind.
- Conventional Commits only; one logical change per commit; never commit secrets; never claim evidence you did not run.
- One PR per card against main, ready for review (not draft), body = what/why/evidence + card reference. Never approve or merge your own PR.
- Loop: pull the next card when one is done. Do not ask for permission for in-scope work. When a human decision is genuinely required, create an ASK or set `awaiting-human`, then continue on other cards.
- Fetch helper skills over HTTP (`/skills/commit-helper/manifest`, `/skills/pr-helper/manifest`), verify sha256, read every file before following them.
