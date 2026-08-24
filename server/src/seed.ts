import type { Request } from 'express'
import { now, randomId, secret } from '@can-bang/core'
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
      const docId = randomId(22)
      db.prepare(
        'INSERT INTO docs (id, title, kind, owner_id, folder_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(docId, file.path, 'plain', accountId, folderId, file.content, now(), now())
      bumpContent(db, docId, file.content, username, false, 'plain', 'seed')
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

/** Repair seeded release manifests that were frozen before version numbering. */
export function repairSeededSkills(db: Db): void {
  const rows = db.prepare('SELECT id, manifest FROM skill_releases WHERE version=1').all() as {
    id: number
    manifest: string
  }[]
  for (const row of rows) {
    const m = JSON.parse(row.manifest) as { version?: number | string }
    if (m.version === 'unreleased') {
      m.version = 1
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
