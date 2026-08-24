---
name: commit-helper
description: Brute delivery workflow skill for commit helper, served by CanBang.
---

# Commit Helper Skill

## Description

Use this skill whenever creating, amending, reviewing, or planning commits. It enforces deterministic Conventional Commits, issue traceability, validation evidence, changelog quality, release-note quality, and SemVer-compatible history.

## Template

Fetch `COMMIT_TEMPLATE.md` from this skill (it is in the manifest next to
SKILL.md) and use it as the commit message skeleton. Replace every `<...>`
placeholder, keep the `Refs:` and `Version-Impact:` lines mandatory, and include
`BREAKING CHANGE:` only when the change is breaking (then it is mandatory). The
template IS the required commit format; a message that omits or reorders its
lines is rejected.

## Before committing

Run:

```bash
make check
```

(Use `rtk make check` where the Brute runner is installed.) Resolve all warnings
and errors before committing. Do not commit if `make check` fails unless the
user explicitly asks for a checkpoint commit; if so, state the failing
validation in the commit body.

## Commit sizing

Prefer one logical change per commit and one file per commit.

Do not split a single atomic logical change into misleading or invalid commits.
A commit may include multiple files when splitting would create an invalid,
unbuildable, misleading, or non-reviewable intermediate state.

Allowed multi-file examples:

- package manifest + lockfile
- schema/contract + generated artifact
- migration + migration test
- implementation + required fixture/snapshot
- public API change + matching type/interface update
- source file + directly coupled test when the test cannot be meaningfully reviewed separately
- config file + generated config output

When a commit includes multiple files, the body must explain why the files are coupled.

## Output rules

- Output only the commit message.
- Generate strictly valid multi-line Conventional Commit messages.
- Use deterministic type and scope selection.
- Summary must be imperative.
- Summary must be lowercase after the type/scope unless a proper noun is required.
- Summary must be <= 72 characters.
- Bullets must be specific and factual.
- Do not mention implementation details unless they affect behaviour, contracts, operations, public API, release notes, or maintainability.
- Every commit must include issue traceability (CanBang card id or issue number).
- Do not invent test evidence.
- If test evidence is missing, write `not run` and why, if known.

## Type selection

Choose the highest-impact accurate type:

```text
security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore
```

## Format

```text
<type>(<scope>)<optional !>: <imperative summary>

- <what changed>
- <why it changed>
- <impact>
- <test evidence>
- <why multiple files are coupled, if more than one file is included>

Refs: <issue ids>
Version-Impact: <none|patch|minor|major|unknown>
BREAKING CHANGE: <required only if breaking_change is true>
```

## Rules

- Never commit secrets, keys, share URLs, or credentials.
- Work only in your own worktree (`git worktree add ../can-bang-<role> -b <role>/<card>`); never commit on main.
- Once your PR is pushed, remove the worktree (`git worktree remove ../can-bang-<role>`); never leave worktrees behind.

## Before pushing to origin

Run:

```bash
make check
make quality-gates
```

(Use `rtk make check` and `rtk make quality-gates` where the Brute runner is
installed.) If either command fails or reports warnings, stop the push stage,
fix the cause, commit the fix appropriately, and restart the before-pushing
stage from the beginning.
