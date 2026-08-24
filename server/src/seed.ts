import type { Request } from 'express'
import { now, randomId, secret } from '@can-bang/core'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './db.js'
import { bumpContent } from './db.js'
import type { AppServices } from './service.js'
import { buildManifest } from './routes/extras.js'

interface SeedSkill {
  slug: string
  name: string
  category: string
  description: string
  files: { path: string; content: string }[]
  notes: string
}

const SKILLS: SeedSkill[] = [
  {
    slug: 'commit-helper',
    name: 'Commit Helper',
    category: 'developer',
    description:
      'Enforces the CanBang/Brute commit business rules: deterministic conventional commits, mandatory Refs/Version-Impact, evidence, no secrets, worktree-only commits.',
    files: [
      {
        path: 'SKILL.md',
        content: `---
name: commit-helper
description: Brute delivery workflow skill for commit helper, served by CanBang.
---

# Commit Helper Skill

## Description

Use this skill whenever creating, amending, reviewing, or planning commits. It enforces deterministic Conventional Commits, issue traceability, validation evidence, changelog quality, release-note quality, and SemVer-compatible history.

## Template

Fetch COMMIT_TEMPLATE.md from this skill and use it as the commit message
skeleton. Replace every <...> placeholder, keep Refs: and Version-Impact:
mandatory, and include BREAKING CHANGE: only when the change is breaking (then
it is mandatory). The template IS the required commit format.

## Before committing

Run \`make check\` (\`rtk make check\` where the Brute runner is installed).
Resolve all warnings and errors before committing. Do not commit if it fails
unless the user explicitly asks for a checkpoint commit; if so, state the
failing validation in the commit body.

## Commit sizing

Prefer one logical change per commit and one file per commit. A commit may
include multiple files when splitting would create an invalid, unbuildable,
misleading, or non-reviewable intermediate state (manifest + lockfile,
schema/contract + generated artifact, migration + test, implementation +
coupled test/fixture, public API change + type update, config + generated
output). When a commit includes multiple files, the body must explain why they
are coupled.

## Output rules

- Output only the commit message.
- Summary must be imperative, lowercase after the type/scope, and <= 72 chars.
- Bullets must be specific and factual.
- Every commit must include issue traceability (CanBang card id or issue number).
- Do not invent test evidence; if missing, write \`not run\` and why.

## Type selection

Highest-impact accurate type:

security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore

## Format

\`\`\`text
<type>(<scope>)<optional !>: <imperative summary>

- <what changed>
- <why it changed>
- <impact>
- <test evidence>
- <why multiple files are coupled, if more than one file is included>

Refs: <issue ids>
Version-Impact: <none|patch|minor|major|unknown>
BREAKING CHANGE: <required only if breaking_change is true>
\`\`\`

## Rules

- Never commit secrets, keys, share URLs, or credentials.
- Work only in your own worktree (git worktree add ../can-bang-<role> -b <role>/<card>); never commit on main.
- Once your PR is pushed, remove the worktree (git worktree remove ../can-bang-<role>); never leave worktrees behind.

## Before pushing to origin

Run \`make check\` and \`make quality-gates\` (\`rtk make check\` /
\`rtk make quality-gates\` where the Brute runner is installed). If either
fails or reports warnings, stop, fix, commit the fix, and restart.
`,
      },
      {
        path: 'COMMIT_TEMPLATE.md',
        content: `<type>(<scope>)<optional !>: <imperative summary, lowercase after type/scope, <=72 chars>

- <what changed>
- <why it changed>
- <impact>
- <test evidence>
- <why multiple files are coupled, if more than one file is included>

Refs: <issue ids / CanBang card ids>
Version-Impact: <none|patch|minor|major|unknown>
BREAKING CHANGE: <required only if breaking_change is true>
`,
      },
    ],
    notes: 'commit rules + message template for agents',
  },
  {
    slug: 'pr-helper',
    name: 'PR Helper',
    category: 'developer',
    description:
      'Opens and manages pull requests for CanBang cards using the Brute PR body template: one PR per card, evidence in the body, no self-approve/merge.',
    files: [
      {
        path: 'SKILL.md',
        content: `---
name: pr-helper
description: Brute delivery workflow skill for pr helper, served by CanBang.
---

# PR Helper Skill

## Description

Use this skill when preparing, opening, updating, or reviewing a pull request.

## Template

Fetch PULL_REQUEST_TEMPLATE.md from this skill and use it as the body skeleton.
Copy it verbatim, fill every section, and never delete a section. If a section
has no content, write \`Not provided\` and mark missing required evidence as a
blocker. The template IS the required body format.

## Pull request policy

Do not create draft PRs. Never approve PRs. Never merge PRs.

Open a normal PR only when the branch is ready for review, or when the user
explicitly asks for an early review PR.

Every PR must have a Conventional Commit-style subject and a complete markdown
body. Write the body to a file using the PULL_REQUEST_TEMPLATE.md skeleton,
validate every required section is present, pass it with
\`gh pr create --title ... --body-file ...\` (or \`gh pr edit\`), then read the
PR back with \`gh pr view --json title,body,url\` and verify the stored body is
non-empty and contains every required section. Never rely on stdin/heredocs or
a successful exit code as proof.

## Agent / Thread (body preface)

Start the body with an Agent / Thread section: session id or agent name, title,
working directory, Brute version, Brute URL, CanBang doc URL, and identity
provenance. When the Brute MCP \`brute_whoami\` is available, use its
session_id/title/url/cwd/version/provenance as canonical and include
\`codex_url\` only when verified (else null). If unavailable or
\`CALLER_UNRESOLVED\`, write your agent name, repo path, and CanBang doc URL,
and mark provenance as unverified.

## Body must include

Agent / Thread · Summary · Conventional Commit Breakdown · Release Notes
Draft · Behaviour Changes · API / Schema / Contract Changes · Testing Evidence ·
Coverage Evidence · Quality Gate Evidence · Demo Evidence · Versioning / SemVer
Impact · Risk and Rollback · Operational Notes · Linked Work · Reviewer
Checklist · Adversarial Review Result.

## Evidence rules

- Do not invent test results; missing evidence is written \`Not provided\` and
  marked as a blocker.
- UI changes MUST include annotated screenshots with the changed area circled
  in red; store under docs/screenshots/{pr_id}/ and use URLs that resolve.
- CLI changes MUST include the actual command and output in a fenced shell block.
- Breaking changes must be impossible to miss.
- If the read-back title or body is empty, incomplete, or missing required
  sections, fix the PR immediately with \`gh pr edit --body-file ...\` and
  verify it again before handoff.

## Title

Use Conventional Commit style: \`<type>(<scope>): <summary>\`. Pick the PR type
from the highest-impact included commit:

security > fix > feat > perf > schema > config > deps > docs > test > ci > build > infra > refactor > style > chore

## Completion

- Move the card to Testing and add the PR link as evidence.
- After pushing the PR, remove your worktree (git worktree remove ../can-bang-<role>); never leave worktrees behind.
- If CI fails, fix and re-run before asking for review.
- Never approve or merge your own PR.
- If a human decision is needed, create an ASK or set awaiting-human instead of stopping.
`,
      },
      {
        path: 'PULL_REQUEST_TEMPLATE.md',
        content: `## Agent / Thread

- Session ID: {session_id}
- Title: {codex_thread_name}
- CWD: {codex_cwd}
- Brute version: {brute_version}
- Brute URL: {brute_url}
- Codex URL: {codex_url}
- Identity provenance: {identity_provenance}

## Summary

- ...

## Conventional Commit Breakdown

| Commit | Type | Scope | Issue | Version impact | Notes |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

## Release Notes Draft

### Customer-facing

- ...

### Internal / operational

- ...

## Behaviour Changes

- ...

## API / Schema / Contract Changes

- ...

## Testing Evidence

- \`make check\`: Not provided
- Targeted tests: Not provided

## Coverage Evidence

Not provided

## Quality Gate Evidence

- \`make quality-gates\`: Not provided

## Demo Evidence

### UI Evidence

- Screenshots: Not applicable. UI changes MUST include red-circled annotated screenshots under \`docs/screenshots/{pr_id}/\`.
- Screenshot image URLs must be uploaded and reachable before submission.
- Video: Not applicable.
- Browser/runtime: Not applicable.

### CLI Evidence

\`\`\`shell
# CLI changes MUST include the exact command and captured output here.
\`\`\`

## Versioning / SemVer Impact

Recommended impact: \`none | patch | minor | major | unknown\`

Reason:

## Risk and Rollback

- Risk:
- Rollback:

## Operational Notes

- ...

## Linked Work

- Refs:

## Reviewer Checklist

- [ ] Acceptance criteria satisfied
- [ ] Tests are meaningful
- [ ] \`make check\` passed
- [ ] \`make quality-gates\` passed
- [ ] Coverage evidence reviewed
- [ ] Demo evidence reviewed
- [ ] UI-related PRs include reachable marked-up screenshots
- [ ] CLI-related PRs include captured output in a \`shell\` block
- [ ] Adversarial review completed
- [ ] Version impact is correct
- [ ] Rollback plan is credible

## Adversarial Review Result

- Verdict: Not provided
- Blocking findings: Not provided
- Follow-ups: Not provided
`,
      },
    ],
    notes: 'PR workflow rules + body template for agents',
  },
  {
    slug: 'sprint-review',
    name: 'Sprint Review',
    category: 'productivity',
    description:
      'Runs a post-sprint/end-of-phase review: gathers evidence, root-causes failures, and writes never-repeat rules.',
    files: [
      {
        path: 'SKILL.md',
        content: `# Sprint Review

Runs the end-of-phase review defined in the repository's review process.

## When to use

When a phase, release, or sprint ends — or after a run that involved rework,
a failed gate, or a surprise.

## Procedure

1. Gather the evidence packet (\`make review\` if available): changed files,
   test/coverage state, demo status, open issues.
2. Compare planned vs shipped deliverables feature by feature.
3. List what worked (with evidence) — these become habits.
4. For each failure, ask "why" until the root cause is a process gap.
5. Decide the smallest action that prevents or catches the failure earlier;
   prefer executable gates over "be more careful".
6. Write one-line never-repeat rules into the lessons register at the level
   that prevents the failure: task, project, account, or global (every
   account on the instance). The system is multi-user aware — scope rules to
   an account when they do not apply elsewhere. Promote rules that recur or
   clearly generalize, and record the promotion.
7. Promote cross-cutting rules into AGENTS.md.
8. File the review doc under docs/reviews/ and open improvements as board cards.

## Rules

- A review that produces no artifacts did not happen.
- Never blame a person; fix the process gap.
- Every improvement needs an owner and an acceptance criterion.
`,
      },
      {
        path: 'agenda.md',
        content: `# Review agenda

1. Evidence first (make review)
2. Outcome vs goal
3. What worked
4. What failed (root cause)
5. Improvements (owner, action, acceptance)
6. Never-repeat rules
7. Levels & promotion (task / project / account / global)
8. File the review
`,
      },
    ],
    notes: 'first seeded release',
  },
  {
    slug: 'code-review-checklist',
    name: 'Code Review Checklist',
    category: 'developer',
    description:
      'Reviews a change against its acceptance contract, evidence tiers, and regression risks before merge.',
    files: [
      {
        path: 'SKILL.md',
        content: `# Code Review Checklist

Reviews a change before it is claimed done or merged.

## When to use

When a change is presented for review: new feature, bug fix, refactor, or doc
change that affects behavior.

## Procedure

1. Read the acceptance contract for the change (goal, success criteria, scope).
2. Check the diff against the contract, not against style preferences.
3. Verify evidence tiers in order: tests run, coverage gate, demo/contract
   checks, docker smoke — never accept a claim without the run.
4. Look for the classic regressions: stale concurrency (If-Match), wipe
   guards, role/attribution edges, secret leakage in logs, and missing tests
   for new branches.
5. Write findings as file:line items; separate resolved from remaining.
6. Batch one review's blockers into one repair cycle, then re-review once.

## Rules

- Never approve or merge automatically.
- Freeze the contract and evidence before reviewing.
- A finding without a file:line is a suggestion, not a blocker.
`,
      },
      {
        path: 'checks.md',
        content: `# Checklist

- [ ] Acceptance contract exists and matches the diff
- [ ] Tests run and coverage gate green
- [ ] Demo/contract checks pass (when applicable)
- [ ] No secrets in logs, URLs, or share keys in code
- [ ] New branches have tests in the same change
- [ ] Concurrency/versioning handled (If-Match, wipe guard)
- [ ] Findings are file:line, resolved vs remaining separated
`,
      },
    ],
    notes: 'first seeded release',
  },
]

function skillFile(slug: string, path: string, fallback: string): string {
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const p = join(base, 'skills', slug, path)
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  return fallback
}

/** Seed starter skills once per instance under the first account. */
export function seedSkillsIfFirst(
  services: AppServices,
  accountId: string,
  username: string,
): void {
  const { db } = services
  const done = db.prepare('SELECT value FROM meta WHERE key=?').get(`skills_seeded_v1_${accountId}`)
  if (done) return
  const fakeReq = (() => {
    try {
      const u = new URL(services.config.publicUrl)
      return { headers: { host: u.host }, query: {}, body: {} } as unknown as Request
    } catch {
      return { headers: { host: 'localhost:8080' }, query: {}, body: {} } as unknown as Request
    }
  })()

  for (const skill of SKILLS) {
    const exists = db.prepare('SELECT 1 FROM skills WHERE slug=?').get(skill.slug)
    if (exists) continue
    const folderId = randomId(12)
    db.prepare(
      'INSERT INTO folders (id, owner_id, name, parent_id, created_at) VALUES (?,?,?,?,?)',
    ).run(folderId, accountId, skill.name, null, now())
    for (const file of skill.files) {
      const content = skillFile(skill.slug, file.path, file.content)
      const docId = randomId(22)
      db.prepare(
        'INSERT INTO docs (id, title, kind, owner_id, folder_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(docId, file.path, 'plain', accountId, folderId, content, now(), now())
      bumpContent(db, docId, content, username, false, 'plain', 'seed')
    }
    const manifest = buildManifest(services, fakeReq, folderId, undefined)
    if (manifest) {
      const releaseManifest = { ...manifest, version: 1 }
      db.prepare(
        'INSERT INTO skill_releases (folder_id, version, notes, manifest, created_at) VALUES (?,?,?,?,?)',
      ).run(folderId, 1, skill.notes, JSON.stringify(releaseManifest), now())
    }
    const shareKey = secret(24)
    db.prepare(
      'INSERT INTO folder_shares (secret, folder_id, role, created_at) VALUES (?,?,?,?)',
    ).run(shareKey, folderId, 'view', now())
    db.prepare(
      `INSERT INTO skills (slug, folder_id, share_secret, category, status, submitted_by, installs, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO NOTHING`,
    ).run(skill.slug, folderId, shareKey, skill.category, 'approved', username, 0, now(), now())
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run(`skills_seeded_v1_${accountId}`, '1')
}

/**
 * Upgrade previously seeded starter skills in place: refresh every file from
 * the canonical skills/ tree and cut a new immutable release. Runs once per
 * account so agents pinning an old version keep their manifest.
 */
export function upgradeSeededSkillsV2(
  services: AppServices,
  accountId: string,
  username: string,
): void {
  const { db } = services
  const done = db.prepare('SELECT value FROM meta WHERE key=?').get(`skills_seeded_v2_${accountId}`)
  if (done) return
  const fakeReq = (() => {
    try {
      const u = new URL(services.config.publicUrl)
      return { headers: { host: u.host }, query: {}, body: {} } as unknown as Request
    } catch {
      return { headers: { host: 'localhost:8080' }, query: {}, body: {} } as unknown as Request
    }
  })()
  let upgraded = 0
  for (const skill of SKILLS) {
    const row = db.prepare('SELECT folder_id FROM skills WHERE slug=?').get(skill.slug) as
      { folder_id: string } | undefined
    if (!row) continue
    let changed = false
    for (const file of skill.files) {
      const content = skillFile(skill.slug, file.path, file.content)
      const doc = db
        .prepare('SELECT id, content FROM docs WHERE folder_id=? AND title=?')
        .get(row.folder_id, file.path) as { id: string; content: string } | undefined
      if (doc) {
        if (doc.content === content) continue
        bumpContent(db, doc.id, content, username, false, 'plain', 'seed-upgrade')
        changed = true
      } else {
        const docId = randomId(22)
        db.prepare(
          'INSERT INTO docs (id, title, kind, owner_id, folder_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(docId, file.path, 'plain', accountId, row.folder_id, content, now(), now())
        bumpContent(db, docId, content, username, false, 'plain', 'seed-upgrade')
        changed = true
      }
    }
    const manifest = buildManifest(services, fakeReq, row.folder_id, undefined, true)
    const latest = db
      .prepare(
        'SELECT manifest FROM skill_releases WHERE folder_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(row.folder_id) as { manifest: string } | undefined
    const current = manifest && JSON.stringify(manifest.files.map((f) => [f.path, f.sha256]).sort())
    const frozen =
      latest &&
      JSON.stringify(
        (JSON.parse(latest.manifest) as { files: { path: string; sha256: string }[] }).files
          .map((f) => [f.path, f.sha256])
          .sort(),
      )
    if ((changed || current !== frozen) && manifest) {
      const next = (
        db
          .prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM skill_releases WHERE folder_id=?')
          .get(row.folder_id) as { v: number }
      ).v
      db.prepare(
        'INSERT INTO skill_releases (folder_id, version, notes, manifest, created_at) VALUES (?,?,?,?,?)',
      ).run(
        row.folder_id,
        next,
        'v2: canonical commit/PR templates',
        JSON.stringify({ ...manifest, version: next }),
        now(),
      )
      upgraded++
    }
  }
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run(`skills_seeded_v2_${accountId}`, '1')
  console.log(`[seed] upgraded ${upgraded} seeded skill(s) to v2 for account ${accountId}`)
}

/** Repair seeded release manifests that were frozen before version numbering. */
export function repairSeededSkills(db: Db): void {
  const rows = db.prepare('SELECT id, version, manifest FROM skill_releases').all() as {
    id: number
    version: number
    manifest: string
  }[]
  for (const row of rows) {
    const m = JSON.parse(row.manifest) as { version?: number | string }
    if (m.version === 'unreleased') {
      m.version = row.version
      db.prepare('UPDATE skill_releases SET manifest=? WHERE id=?').run(JSON.stringify(m), row.id)
    }
  }
}

const SEED_PROJECT = {
  name: 'CanBang',
  description: 'Self-hosted emulation of workbench.md — this project, dogfooded.',
  phases: [
    {
      name: 'MVP',
      status: 'done' as const,
      release: { name: 'MVP demo', demo_status: 'pass' as const, demo_command: 'bash demo/mvp.sh' },
      tasks: [
        ['Docs + content API with edit keys', 'done', 'Docs & content API', 'integrator'],
        ['Share links with role ladder', 'done', 'Docs & content API', 'integrator'],
        ['Chat, status, events long-poll', 'done', 'Collaboration', 'builder-1'],
        ['Live component fences (board/chat/status)', 'done', 'Collaboration', 'builder-1'],
        ['Web editor view/edit', 'done', 'UI parity', 'builder-2'],
        ['MCP server (18 tools)', 'done', 'Skills & CLI', 'scout'],
        ['Docker image + demo script', 'done', 'Release', 'integrator'],
      ],
    },
    {
      name: '0.2',
      status: 'done' as const,
      release: { name: '0.2 demo', demo_status: 'pass' as const, demo_command: 'bash demo/0.2.sh' },
      tasks: [
        ['Accounts, tokens, claim', 'done', 'Multi-user & org', 'integrator'],
        ['Folders + folder shares + search', 'done', 'Multi-user & org', 'builder-1'],
        ['Comments + suggestions + revisions', 'done', 'Collaboration', 'builder-1'],
        ['Asks, registry, webhooks', 'done', 'Collaboration', 'builder-2'],
        ['Live cursors + publish page', 'doing', 'UI parity', 'scout'],
        ['Assets/media upload', 'done', 'Docs & content API', 'builder-2'],
      ],
    },
    {
      name: '0.3',
      status: 'active' as const,
      release: {
        name: '0.3 demo',
        demo_status: 'partial' as const,
        demo_command: 'bash demo/0.3.sh',
      },
      tasks: [
        ['Skills marketplace + releases', 'done', 'Skills & CLI', 'integrator'],
        ['Widgets + templates', 'done', 'Skills & CLI', 'builder-1'],
        ['mde CLI core verbs', 'done', 'Skills & CLI', 'builder-2'],
        [
          'CLI daemon verbs (watch --daemon, activity, chief-supervisor)',
          'doing',
          'Skills & CLI',
          'builder-2',
        ],
        ['Backup/restore scripts', 'done', 'Release', 'integrator'],
        ['Project/phase/release/task hierarchy views', 'doing', 'Multi-user & org', 'builder-1'],
        ['Feature-status matrix + release drill-down', 'todo', 'UI parity', 'builder-1'],
        ['Pixel-parity UI polish', 'todo', 'UI parity', 'scout'],
      ],
    },
  ],
}

function linkHqDoc(db: Db, accountId: string, projectId: string): void {
  const docId = randomId(22)
  const content = `# CanBang — HQ

## Board

\`\`\`board #tickets
## Todo
## Doing
## Testing
## Done
\`\`\`

## Status

\`\`\`status
state: building
\`\`\`

## Team chat

\`\`\`chat #general
\`\`\`
`
  db.prepare(
    'INSERT INTO docs (id, title, kind, owner_id, folder_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(docId, 'CanBang — HQ', 'live', accountId, null, content, now(), now())
  bumpContent(db, docId, content, 'seed', false, 'live', 'seed')
  db.prepare('UPDATE projects SET doc_id=? WHERE id=?').run(docId, projectId)
}

/** Seed a starter project with phases, releases, and tasks once per instance. */
export function seedWorkspaceIfFirst(services: AppServices, accountId: string): void {
  const { db } = services
  const done = db
    .prepare('SELECT value FROM meta WHERE key=?')
    .get(`workspace_seeded_v1_${accountId}`)
  if (done) return
  const already = db
    .prepare('SELECT 1 FROM projects WHERE owner_id=? AND name=?')
    .get(accountId, SEED_PROJECT.name)
  if (already) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run(
      `workspace_seeded_v1_${accountId}`,
      '1',
    )
    const existing = db
      .prepare('SELECT id, doc_id FROM projects WHERE owner_id=? AND name=?')
      .get(accountId, SEED_PROJECT.name) as { id: string; doc_id: string | null } | undefined
    if (existing && !existing.doc_id) linkHqDoc(db, accountId, existing.id)
    return
  }
  const projectId = randomId(12)
  db.prepare(
    'INSERT INTO projects (id, owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(projectId, accountId, SEED_PROJECT.name, SEED_PROJECT.description, now(), now())
  linkHqDoc(db, accountId, projectId)
  SEED_PROJECT.phases.forEach((phase, idx) => {
    const phaseId = randomId(12)
    db.prepare(
      'INSERT INTO phases (id, project_id, name, ord, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(phaseId, projectId, phase.name, idx, phase.status, now(), now())
    db.prepare(
      'INSERT INTO releases (id, phase_id, name, demo_status, demo_command, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      randomId(12),
      phaseId,
      phase.release.name,
      phase.release.demo_status,
      phase.release.demo_command,
      null,
      now(),
      now(),
    )
    const phaseBase = now() - (idx === 0 ? 21 : idx === 1 ? 10 : 3) * 86_400_000
    for (const [taskIdx, [title, status, feature, assignee]] of phase.tasks.entries()) {
      const taskId = randomId(14)
      const createdTs = phaseBase + taskIdx * 86_400_000
      db.prepare(
        'INSERT INTO tasks (id, phase_id, title, status, assignee, feature, done_means, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(taskId, phaseId, title, status, assignee, feature, null, createdTs, createdTs)
      db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
        taskId,
        phaseId,
        status,
        createdTs,
      )
      if (status === 'done') {
        db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
          taskId,
          phaseId,
          'done',
          createdTs + 12 * 3_600_000,
        )
      }
    }
  })
  db.prepare('INSERT INTO meta (key, value) VALUES (?,?)').run(
    `workspace_seeded_v1_${accountId}`,
    '1',
  )
}

/** Remove duplicate seeded projects created across seeding migrations. */
export function dedupeSeededProjects(db: Db): void {
  const groups = db
    .prepare('SELECT owner_id, name FROM projects GROUP BY owner_id, name HAVING COUNT(*) > 1')
    .all() as { owner_id: string; name: string }[]
  for (const g of groups) {
    const projects = db
      .prepare('SELECT * FROM projects WHERE owner_id=? AND name=? ORDER BY created_at ASC')
      .all(g.owner_id, g.name) as { id: string; doc_id: string | null }[]
    for (const dup of projects.slice(1)) {
      const phaseIds = (
        db.prepare('SELECT id FROM phases WHERE project_id=?').all(dup.id) as { id: string }[]
      ).map((p) => p.id)
      for (const phaseId of phaseIds) {
        db.prepare('DELETE FROM task_events WHERE phase_id=?').run(phaseId)
        db.prepare('DELETE FROM tasks WHERE phase_id=?').run(phaseId)
        db.prepare('DELETE FROM releases WHERE phase_id=?').run(phaseId)
      }
      db.prepare('DELETE FROM phases WHERE project_id=?').run(dup.id)
      db.prepare('DELETE FROM projects WHERE id=?').run(dup.id)
    }
  }
}

/** One-time rename of pre-rename seeded projects and HQ docs. */
export function renameSeededProjects(db: Db): void {
  db.prepare(
    "UPDATE projects SET name='CanBang' WHERE name IN ('Workbench Local', 'Can Bang')",
  ).run()
  db.prepare(
    "UPDATE docs SET title=replace(title, 'Can Bang — HQ', 'CanBang — HQ') WHERE title LIKE '%Can Bang — HQ%'",
  ).run()
  db.prepare(
    "UPDATE docs SET title=replace(title, 'Workbench Local — HQ', 'CanBang — HQ') WHERE title LIKE '%Workbench Local — HQ%'",
  ).run()
}

/** Give every project without one an HQ doc (board + status + chat). */
export function backfillProjectDocs(db: Db): void {
  const rows = db.prepare('SELECT id, owner_id, name FROM projects WHERE doc_id IS NULL').all() as {
    id: string
    owner_id: string
    name: string
  }[]
  for (const p of rows) {
    const docId = randomId(22)
    const content = `# ${p.name} — HQ

## Board

\`\`\`board #tickets
## Todo
## Doing
## Testing
## Done
\`\`\`

## Status

\`\`\`status
state: building
\`\`\`

## Team chat

\`\`\`chat #general
\`\`\`
`
    db.prepare(
      'INSERT INTO docs (id, title, kind, owner_id, folder_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(docId, `${p.name} — HQ`, 'live', p.owner_id, null, content, now(), now())
    bumpContent(db, docId, content, 'seed', false, 'live', 'seed')
    db.prepare('UPDATE projects SET doc_id=? WHERE id=?').run(docId, p.id)
  }
}

/** Create burndown events for tasks seeded before event recording existed. */
export function backfillTaskEvents(db: Db): void {
  const rows = db
    .prepare(
      `SELECT t.id, t.phase_id, t.status, t.created_at, t.updated_at FROM tasks t
       WHERE NOT EXISTS (SELECT 1 FROM task_events e WHERE e.task_id = t.id)`,
    )
    .all() as {
    id: string
    phase_id: string
    status: string
    created_at: number
    updated_at: number
  }[]
  for (const t of rows) {
    db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
      t.id,
      t.phase_id,
      t.status === 'done' ? 'todo' : t.status,
      t.created_at,
    )
    if (t.status === 'done') {
      db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
        t.id,
        t.phase_id,
        'done',
        t.updated_at || t.created_at + 1,
      )
    }
  }
}
