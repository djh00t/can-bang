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
the contract tests. The task spec contract (title, status, assignee, feature,
priority, done_means, acceptance, context, description, contract, workflow,
scenarios, dependencies, blockers) is exposed by REST `/api/phases/:id/tasks` and
`/api/tasks/:id`, MCP `create_task` / `update_task` / `get_task` /
`list_tasks`, and CLI `mde task new|edit`; the project doc board fence mirrors
these fields as indented continuation lines so multiline values survive
reindexing.

## Task spec (minimum criteria)

Every task card must be born with a spec, and a card may not move to Doing
until it has one. The required minimum is **acceptance criteria** and
**done-means**; the API rejects task creation and Doing transitions without
them (HTTP 422). Recommended fields to fill when the work needs them:

- `description` — what the work is and why it matters
- `acceptance` — acceptance criteria (Gherkin Given/When/Then encouraged)
- `done_means` — how you know it is done
- `context` — constraints, prior decisions, cleared-task context
- `scenarios` — BDD/Gherkin scenarios
- `contract` — API/schema/contract boundaries the change must satisfy
- `workflow` — the steps/process to implement and verify it
- `dependencies` — task IDs/titles this card depends on (comma-separated)
- `priority` — high/medium/low when triaged

Agents must write the spec fields into the card before claiming it (the doc
board fence is the record); skip cards with a missing minimum spec or add the
criteria first. Cards missing the minimum show a ⚠ spec badge on the board.
When a card has dependencies, do not claim it until those cards are done.

## Task activity log

Every task keeps a full history: status moves, assignee changes, spec edits,
and comments/actions are appended to `/api/tasks/:id` (`activity`) and logged
through `POST /api/tasks/:id/activity`, MCP `post_task_activity`, and
`mde task comment <taskId> <text>`. Agents must log PR links (kind `pr`),
tester findings, and decisions on the task itself so the history is complete
and visible in the task view.

## Testing loop

One builder implements a card; one tester verifies it. The loop:

1. Builder claims the card (spec required), works in its own worktree, commits,
   opens the PR, moves the card to **Testing**, and logs the PR link on the
   task (kind `pr`) with the test/demo evidence in the PR body.
2. Tester checks out the PR branch, runs `make check` and the card's demo, and
   verifies against the acceptance criteria.
3. On failure: the tester logs each finding on the task (file:line, what
   failed, what to fix) and sends the card back to **Doing** (rework). The
   builder fixes every finding, re-runs the PR, and moves it back to Testing.
4. On pass: the tester logs a verification comment with the evidence and moves
   the card to **Done**.
5. No agent approves or merges its own PR; merging stays with the human.

The UI's "Send back for rework" action (Testing → Doing) prompts for the
tester's findings and logs them on the task before moving the card.

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
