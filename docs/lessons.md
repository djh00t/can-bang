# Lessons learned — never-repeat register

Each rule is a one-line invariant from a real failure. Rules live at the level
that prevents the failure:

- **Task** — applies to one task or run.
- **Project** — applies across this repo.
- **Account** — applies to every project owned by one account.
- **Global** — instance-wide: applies to every account and every project.

The system is **multi-user aware**: rules are scoped per account when accounts
have different constraints, and a rule promoted to **global** is applied to
every account on the instance (for example, published as an instance template
or skill, or enforced in AGENTS-level guidance).

New rules are added at the end of a review. Promotion moves a rule up a level
when it recurs or clearly generalizes; record every promotion in the log below.
Stale rules are removed only by a review.

## Global rules (every account, every project)

1. Never claim evidence you did not run in this session.
2. No speculative features without a requested card — scope discipline saves
   the rework.
3. Pin stable dependency lines explicitly — advisors can return pre-release
   tags that look "recommended".
4. When `curl` is policy-blocked, use `node fetch` for diagnostics instead of
   fighting the sandbox.
5. Prefer executable gates (tests, scripts, Makefile targets) over "be more
   careful".

## Project rules (can-bang)

1. Verify emitted asset names against references before shipping UI — an
   `index.html` pointing at a script that does not exist produces a silent
   blank page. `make check` smoke-tests this.
2. Insert parent rows before foreign-key children; rely on tests, not
   eyeballing order.
3. Shell helpers: `shift` positional args before forwarding; treat `since=latest`
   as "from now" (past events need `since=0`).
4. Pair every new code branch with a coverage test in the same change — the
   coverage gate is not a surprise, it is part of the diff.
5. Docker context needs every file the build reads (lockfile included).
6. A review that produces no artifacts did not happen — file it or skip it
   deliberately.

## Account rules (every project in one account)

- None yet — add account-specific invariants here when a review produces a
  rule that is true for one account's projects but not every account.

## Task notes (candidates for promotion)

- Keep empty unless a review leaves a rule that is not yet proven general.

## Promotion log

- 2026-08-24: "Verify emitted asset names before shipping UI" promoted
  task → project (blank-page bug, now a `make check` smoke test).
- 2026-08-24: "No speculative features without a requested card" promoted
  project → global (SMTP lesson applies across all projects).
- 2026-08-24: Levels extended for multi-user instances — task → project →
  account → global; a global rule is published to every account.
