# PR Helper

Brute delivery workflow skill for PR helper, served by CanBang. Use it when
preparing, opening, updating, or reviewing a pull request.

## Pull request policy

- Do not create draft PRs. Never approve PRs. Never merge PRs.
- Open a normal PR only when the branch is ready for review (or the user
  explicitly asks for an early review PR).
- One PR per card, base main. Title = Conventional Commit subject, type from
  the highest-impact included commit:

  security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore

- Write the body to a file, pass it with `gh pr create --title ... --body-file ...`
  (or `gh pr edit`), then read the PR back with `gh pr view --json title,body,url`
  and verify the stored body is non-empty and contains every required section.
  Never rely on stdin/heredocs or a successful exit code as proof.

## Agent / Thread (body preface)

Start the body with an Agent / Thread section: session id or agent name,
title, working directory, CanBang doc URL, and identity provenance. When the
Brute MCP `brute_whoami` is available, use its session_id/title/url/cwd/
version/provenance as canonical and include `codex_url` only when verified
(else null). If unavailable or `CALLER_UNRESOLVED`, write your agent name,
repo path, and CanBang doc URL, and mark provenance as unverified.

## Body must include

Summary · Conventional Commit Breakdown · Behaviour Changes · API / Schema /
Contract Changes · Testing Evidence · Coverage Evidence · Quality Gate
Evidence · Demo Evidence · Versioning / SemVer Impact · Risk and Rollback ·
Operational Notes · Linked Work (card) · Reviewer Checklist · Adversarial
Review Result.

## Evidence rules

- Do not invent test results; missing evidence is written `Not provided` and
  marked as a blocker.
- UI changes MUST include annotated screenshots (changed area highlighted);
  store under docs/screenshots/{pr_id}/ and use URLs that resolve. When Brute
  browser tooling is available, use it.
- CLI changes MUST include the actual command and output in a fenced shell block.
- Breaking changes must be impossible to miss.

## Completion

- Move the card to Testing and add the PR link as evidence.
- After pushing the PR, remove your worktree (`git worktree remove ../can-bang-<role>`); never leave worktrees behind.
- If CI fails, fix and re-run before asking for review.
- Never approve or merge your own PR.
- If a human decision is needed, create an ASK or set awaiting-human instead
  of stopping.
