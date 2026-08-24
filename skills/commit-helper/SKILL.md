# Commit Helper

Brute delivery workflow skill for commit helper, served by CanBang. Use it
whenever creating, amending, reviewing, or planning commits.

## Before committing

Run `make check` (or `rtk make check` where the Brute runner is installed).
Resolve all warnings and errors before committing. Do not commit if it fails
unless the user explicitly asks for a checkpoint commit; if so, state the
failing validation in the commit body.

## Commit sizing

Prefer one logical change per commit and one file per commit. A commit may
include multiple files when splitting would create an invalid, unbuildable,
misleading, or non-reviewable intermediate state (manifest + lockfile,
schema/contract + generated artifact, migration + test, implementation +
coupled test/fixture, config + generated output). When a commit includes
multiple files, the body must explain why they are coupled.

## Type selection

Highest-impact accurate type:

security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore

## Format

```text
<type>(<scope>)<optional !>: <imperative summary, lowercase after type/scope, <=72 chars>

- <what changed>
- <why it changed>
- <impact>
- <test evidence>
- <why multiple files are coupled, if applicable>

Refs: <issue/card ids>
Version-Impact: <none|patch|minor|major|unknown>
BREAKING CHANGE: <required only if breaking>
```

## Rules

- Output only the commit message.
- Summary is imperative and lowercase after the type/scope unless a proper noun.
- Every commit includes issue traceability (card id or issue number).
- Do not invent test evidence; if missing, write `not run` and why.
- Never commit secrets, keys, share URLs, or credentials.
- Work only in your own worktree (`git worktree add ../can-bang-<role> -b <role>/<card>`); never commit on main.
- Once your PR is pushed, remove the worktree (`git worktree remove ../can-bang-<role>`); never leave worktrees behind.

## Before pushing

Run `make check` and `make quality-gates`; if either fails or reports
warnings, stop the push stage, fix the cause, commit the fix, and restart.
