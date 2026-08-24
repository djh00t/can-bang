---
name: pr-helper
description: Brute delivery workflow skill for pr helper, served by CanBang.
---

# PR Helper Skill

## Description

Use this skill when preparing, opening, updating, or reviewing a pull request. It generates reviewer-friendly PR titles and bodies from commits, diff summaries, validation evidence, demo evidence, versioning impact, and linked issues.

## Template

Fetch `PULL_REQUEST_TEMPLATE.md` from this skill (it is in the manifest next to
SKILL.md) and use it as the body skeleton. Copy it verbatim, fill every section,
and never delete a section. If a section has no content, write `Not provided`
and mark missing required evidence as a blocker. The template IS the required
body format; a body that omits or reorders its sections is rejected.

## Pull request policy

Do not create draft PRs. Never approve PRs. Never merge PRs.

Open a normal PR only when the branch is ready for review, or when the user explicitly asks for an early review PR.

Every PR must have a Conventional Commit-style subject and a complete markdown
body before it is created or marked ready. Write the body to a file using the
`PULL_REQUEST_TEMPLATE.md` skeleton, validate it contains every required
section, pass it to GitHub with
`gh pr create --title "<title>" --body-file <body-file>` or
`gh pr edit --title "<title>" --body-file <body-file>`, then read the PR back
with `gh pr view --json title,body,url` and verify the stored body is non-empty
and contains every required section.

Every PR body must start with an `Agent / Thread` section. Put the owning Codex
session ID, thread title, working directory, Brute version, stable Brute URL,
Codex URL, and identity provenance at the top of the body so humans
can map the PR back to the Codex thread or agent that produced it before reading
the delivery details.

Before preparing the body, call the Brute MCP `brute_whoami` tool when
available. Treat its versioned `session_id`, `title`, `url`, `cwd`,
`brute_version`, and `provenance` fields as the canonical identity record. Use
the stable Brute `url` once in the header. Include `codex_url` only when the
resolver verifies it; otherwise write `null` and preserve its provenance. Do
not reconstruct identity from Git, CWD, branch, PR title, task ID, process ID,
cookie, or a truncated identifier. If the resolver returns `CALLER_UNRESOLVED`
or required identity is incomplete, write your agent name, repo path, and
CanBang doc URL, and mark provenance as unverified.

## Body must include

- Agent / Thread
- Summary
- Conventional Commit Breakdown
- Release Notes Draft
- Behaviour Changes
- API / Schema / Contract Changes
- Testing Evidence
- Coverage Evidence
- Quality Gate Evidence
- Demo Evidence
- Versioning / SemVer Impact
- Risk and Rollback
- Operational Notes
- Linked Work
- Reviewer Checklist
- Adversarial Review Result

## Evidence rules

- Do not invent test results; missing evidence is written `Not provided` and
  marked as a blocker.
- UI changes MUST include annotated screenshots with the changed area circled
  in red and a note explaining the change. Store screenshots under
  `docs/screenshots/{pr_id}/` using `pr_{pr_id}_{sanitized_pr_title}_{order:02d}.png`.
  Screenshot links must be reachable when the body is submitted; a URL that
  returns 404 is not valid evidence.
- CLI changes MUST include the actual command and output in a fenced `shell` block.
- Breaking changes must be impossible to miss.
- Never rely on stdin, shell heredocs piped directly to `gh pr create`, or a
  successful GitHub CLI exit code as proof that the body was stored.
- If the read-back title or body is empty, incomplete, or missing required
  sections, fix the PR immediately with `gh pr edit --body-file ...` and verify
  it again before handoff.

## Title

Use Conventional Commit style:

```text
<type>(<scope>): <summary>
```

Pick the PR type from the highest-impact included commit:

```text
security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore
```

## Completion

- Move the card to Testing and add the PR link as evidence.
- After pushing the PR, remove your worktree (`git worktree remove ../can-bang-<role>`); never leave worktrees behind.
- If CI fails, fix and re-run before asking for review.
- Never approve or merge your own PR.
- If a human decision is needed, create an ASK or set awaiting-human instead
  of stopping.
