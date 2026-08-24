# Delivery process — Can Bang

How this project turns a request into shipped, evidenced work. Every agent
working in this repo follows this process; humans keep authority over merges,
deploys, and external publication.

## 1. Freeze the acceptance contract

Before any implementation, state in one place:

- **Goal**: the outcome in one or two sentences.
- **Success criteria**: observable, checkable results (what "done" looks like).
- **Audience**: who uses it (human owner, agents via REST/MCP/CLI, both).
- **In scope / out of scope**: what is explicitly excluded (e.g., email was
  dropped by decision; no speculative infrastructure).
- **Constraints**: stack, ports, persistence, auth model, coverage gate.

## 2. Decompose: Release → Phase → Feature → Issue

Break work into small, independent slices:

1. **Release** — a versioned milestone with its own demo (MVP, 0.2, 0.3).
2. **Phase** — a theme inside a release (core API, collaboration, multi-user,
   skills/CLI/ops).
3. **Feature** — one user-visible capability (chat append, ASK claim, folder
   shares).
4. **Issue/task** — 5–10 minutes of work, independently testable.

Each task must fit on one card and state:

- **Plain-language acceptance**: "A suggest link can add comments but cannot
  rewrite the document body."
- **Gherkin scenario** when the behavior is user-visible:
  `Given a suggest share key When a PUT /content is attempted Then 403 is returned`.
- **Boundary contracts**: schemas, status codes, headers, error shapes —
  copied from the protocol reference at `/agents.md`, never invented.
- **Demo/evidence**: how to prove it (unit test, contract test, demo script,
  docker smoke, live UAT).

## 3. Implement in slices

- One logical change per commit (Conventional Commits); no speculative code.
- TDD/BDD for meaningful behavior; record an exemption for scripts, tiny
  utilities, docs, and experiments.
- Keep the product working after every slice: `make check` (typecheck, format,
  tests, **85% line coverage**) must stay green.
- Run the narrowest check for the change, then the full gate before claiming
  completion.

## 4. Evidence tiers

Never claim a tier you did not run:

1. Local tests (`make check`, unit + contract).
2. Demo scripts (`make demo`) against a live instance.
3. Docker build + container smoke (health, persistence, MCP doctor).
4. Live-agent UAT and hosted deployment — human-run.

## 5. Review

- Freeze the acceptance contract, dependency graph, and evidence before review.
- Batch one review's blockers into one repair cycle, then do one fresh review.
- Never approve or merge automatically.
