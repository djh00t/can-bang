# End-of-phase review process

Reviews are how this project improves. They are short, evidence-led, and
produce two durable artifacts: **actions** (things we will do) and
**never-repeat rules** (things we will not do again). Rules are written into
[lessons.md](lessons.md) and, when they are codebase-wide, into `AGENTS.md`.

## When to review

- End of every **phase** (MVP, 0.2, 0.3) and every **release**.
- After any sprint that ended with rework, a failed gate, or a surprise.
- Optionally after a long autonomous run — reviews are cheap and catch drift.

## The review meeting (15-30 minutes)

1. **Evidence first.** Run `make review` to gather the packet: what changed,
   test/coverage state, demo status, open issues. Nobody argues with the
   packet.
2. **Outcome vs goal.** Compare what we planned to deliver against what
   shipped, feature by feature. Mark done / partial / dropped and why.
3. **What worked.** One line each, with evidence. These become habits.
4. **What failed.** For each failure: what happened, when it surfaced, and its
   root cause (ask "why" until the cause is a process gap, not a person).
5. **Improvements.** Decide the smallest action that prevents or catches the
   failure earlier. Assign one owner per action. Prefer executable gates
   (tests, scripts, Makefile targets) over "be more careful".
6. **Never-repeat rules.** Distill each root cause into a one-line rule.
   Append to `docs/lessons.md`; promote cross-cutting rules into `AGENTS.md`.
7. **Levels & promotion.** Classify each rule at the level where it prevents
   the failure: task (this run), project (this repo), account (every project
   owned by one account), or global (every account on the instance). The
   system is multi-user aware: scope account-specific rules to the account,
   and publish global rules to every account (instance template/skill or
   AGENTS-level guidance). If a rule already recurred, or clearly generalizes,
   promote it one level now — waiting for the third occurrence is how repeated
   failures happen. Record promotions in the promotion log.
8. **File the review.** Write `docs/reviews/YYYY-MM-DD-<phase>.md` from the
   template below, commit it with the phase's final changes.

## Template

```markdown
# Review: <phase/release> — <date>

## Outcome vs goal

| Deliverable | Planned | Shipped | Note |
| ----------- | ------- | ------- | ---- |

## Evidence packet

- Commits: <n> · changed files: <n>
- Tests: <n> passed · coverage: <line>%
- Demos: MVP / 0.2 / 0.3 (pass/fail + where)

## What worked

## What failed (root cause → fix)

## Improvements (owner, action)

## Never-repeat rules (→ docs/lessons.md)
```

## Closing the loop

- Open the improvements as issues/cards on the board with acceptance criteria.
- Never-repeat rules are done only when they are in `lessons.md` (and
  `AGENTS.md` if cross-cutting).
- The next phase's contract should cite this review's rules.
