import express, { type Request, type Response } from 'express'
import { ApiError, badRequest, notFound, randomId } from '@can-bang/core'
import type { AppServices } from '../service.js'
import type { Db } from '../db.js'
import { resolveAccess } from '../auth.js'
import { asyncHandler } from '../util.js'
import { now } from '@can-bang/core'
import { realGh, syncProjectGithub } from '../github.js'
import { appendCard, reindexBoard, reindexIfStale, updateCard } from '../board-sync.js'
import { bumpContent } from '../db.js'

export interface ProjectRow {
  id: string
  owner_id: string
  name: string
  description: string | null
  doc_id: string | null
  github_repo: string | null
  github_token: string | null
  github_sync: number
  created_at: number
  updated_at: number
}

export interface PhaseRow {
  id: string
  project_id: string
  name: string
  ord: number
  status: 'planned' | 'active' | 'done'
  doc_id: string | null
  created_at: number
  updated_at: number
}

export interface ReleaseRow {
  id: string
  phase_id: string
  name: string
  demo_status: 'pending' | 'pass' | 'partial' | 'fail'
  demo_command: string | null
  notes: string | null
  doc_id: string | null
  created_at: number
  updated_at: number
}

export interface TaskRow {
  id: string
  phase_id: string
  title: string
  status: 'todo' | 'doing' | 'testing' | 'done'
  assignee: string | null
  feature: string | null
  done_means: string | null
  description: string | null
  blockers: string | null
  doc_id: string | null
  priority: string | null
  acceptance: string | null
  context: string | null
  created_at: number
  updated_at: number
}

function taskCounts(
  db: Db,
  projectId: string,
): { total: number; done: number; doing: number; todo: number; testing: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
        SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) AS done,
        SUM(CASE WHEN t.status='doing' THEN 1 ELSE 0 END) AS doing,
        SUM(CASE WHEN t.status='testing' THEN 1 ELSE 0 END) AS testing,
        SUM(CASE WHEN t.status='todo' THEN 1 ELSE 0 END) AS todo
       FROM tasks t JOIN phases p ON p.id = t.phase_id WHERE p.project_id = ?`,
    )
    .get(projectId) as { total: number; done: number; doing: number; testing: number; todo: number }
  return {
    total: row.total ?? 0,
    done: row.done ?? 0,
    doing: row.doing ?? 0,
    testing: row.testing ?? 0,
    todo: row.todo ?? 0,
  }
}

function docTitle(db: Db, docId: string | null): string | null {
  if (!docId) return null
  const row = db.prepare('SELECT title FROM docs WHERE id=?').get(docId) as
    { title: string } | undefined
  return row?.title ?? null
}

function recordTaskEvent(
  db: Db,
  taskId: string,
  phaseId: string,
  status: string,
  ts: number,
): void {
  db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
    taskId,
    phaseId,
    status,
    ts,
  )
}

function burndown(
  db: Db,
  phaseId: string,
  days: number,
): { points: { date: string; remaining: number }[]; total: number; current: number } {
  const tasks = db.prepare('SELECT id FROM tasks WHERE phase_id=?').all(phaseId) as { id: string }[]
  if (!tasks.length) return { points: [], total: 0, current: 0 }
  const DAY = 86_400_000
  const first =
    (
      db.prepare('SELECT MIN(ts) AS t FROM task_events WHERE phase_id=?').get(phaseId) as {
        t: number | null
      }
    ).t ?? Date.now()
  const firstDay = Math.floor(first / DAY) * DAY
  const lastDay = Math.floor(Date.now() / DAY) * DAY
  const start = Math.max(firstDay, lastDay - (days - 1) * DAY)
  const created = new Map<string, number>()
  const doneAt = new Map<string, number>()
  for (const task of tasks) {
    const firstEv = db
      .prepare('SELECT status, ts FROM task_events WHERE task_id=? ORDER BY ts ASC LIMIT 1')
      .get(task.id) as { status: string; ts: number } | undefined
    if (!firstEv) continue
    if (firstEv.status !== 'done') created.set(task.id, firstEv.ts)
    const done = db
      .prepare(
        "SELECT ts FROM task_events WHERE task_id=? AND status='done' ORDER BY ts ASC LIMIT 1",
      )
      .get(task.id) as { ts: number } | undefined
    if (done) doneAt.set(task.id, done.ts)
  }
  const points: { date: string; remaining: number }[] = []
  for (let day = start; day <= lastDay; day += DAY) {
    let remaining = 0
    for (const [taskId, createdTs] of created) {
      if (createdTs <= day + DAY && (!doneAt.has(taskId) || doneAt.get(taskId)! > day + DAY))
        remaining++
    }
    points.push({ date: new Date(day).toISOString().slice(0, 10), remaining })
  }
  return {
    points,
    total: tasks.length,
    current: points.length ? points[points.length - 1]!.remaining : 0,
  }
}

export function workspaceRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  const accountIdOf = (req: Request): string => {
    const access = resolveAccess(db, req, '')
    if (!access.identity.accountId)
      throw new ApiError(401, 'account required', 'Sign in or pass an account token.')
    return access.identity.accountId
  }

  const projectOf = (db: Db, accountId: string, id: string): ProjectRow => {
    const p = db.prepare('SELECT * FROM projects WHERE id=? AND owner_id=?').get(id, accountId) as
      ProjectRow | undefined
    if (!p) throw notFound('project not found')
    return p
  }

  const phaseOf = (db: Db, accountId: string, id: string): PhaseRow => {
    const p = db
      .prepare(
        'SELECT ph.* FROM phases ph JOIN projects pr ON pr.id = ph.project_id WHERE ph.id=? AND pr.owner_id=?',
      )
      .get(id, accountId) as PhaseRow | undefined
    if (!p) throw notFound('phase not found')
    return p
  }

  const releaseOf = (db: Db, accountId: string, id: string): ReleaseRow => {
    const rl = db
      .prepare(
        `SELECT rl.* FROM releases rl JOIN phases ph ON ph.id = rl.phase_id JOIN projects pr ON pr.id = ph.project_id
         WHERE rl.id=? AND pr.owner_id=?`,
      )
      .get(id, accountId) as ReleaseRow | undefined
    if (!rl) throw notFound('release not found')
    return rl
  }

  // Projects
  r.get(
    '/api/projects',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const rows = db
        .prepare('SELECT * FROM projects WHERE owner_id=? ORDER BY created_at ASC')
        .all(accountId) as ProjectRow[]
      res.json({
        projects: rows.map((p) => {
          const phases = db
            .prepare('SELECT * FROM phases WHERE project_id=? ORDER BY ord ASC')
            .all(p.id) as PhaseRow[]
          const counts = taskCounts(db, p.id)
          return {
            id: p.id,
            name: p.name,
            description: p.description,
            phaseCount: phases.length,
            releaseCount: db
              .prepare(
                'SELECT COUNT(*) AS c FROM releases WHERE phase_id IN (SELECT id FROM phases WHERE project_id=?)',
              )
              .get(p.id) as { c: number },
            ...counts,
            updated_at: p.updated_at,
          }
        }),
      })
    }),
  )

  r.post(
    '/api/projects',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
      if (!name) throw badRequest('name required')
      const id = randomId(12)
      db.prepare(
        'INSERT INTO projects (id, owner_id, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(
        id,
        accountId,
        name,
        typeof req.body?.description === 'string' ? req.body.description.slice(0, 500) : null,
        now(),
        now(),
      )
      const docId = randomId(22)
      const content = `# ${name} — HQ

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
      ).run(docId, `${name} — HQ`, 'live', accountId, null, content, now(), now())
      bumpContent(db, docId, content, 'seed', false, 'live', 'seed')
      db.prepare('UPDATE projects SET doc_id=? WHERE id=?').run(docId, id)
      res.status(201).json({ project: { id, name, docId } })
    }),
  )

  r.get(
    '/api/projects/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      reindexIfStale(db, project.id)
      const phases = db
        .prepare('SELECT * FROM phases WHERE project_id=? ORDER BY ord ASC')
        .all(project.id) as PhaseRow[]
      const releases = db
        .prepare(
          `SELECT rl.* FROM releases rl JOIN phases ph ON ph.id = rl.phase_id WHERE ph.project_id=? ORDER BY ph.ord ASC`,
        )
        .all(project.id) as ReleaseRow[]
      const tasks = db
        .prepare(
          `SELECT t.* FROM tasks t JOIN phases ph ON ph.id = t.phase_id WHERE ph.project_id=? ORDER BY t.created_at ASC`,
        )
        .all(project.id) as TaskRow[]
      res.json({
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          docId: project.doc_id,
          docTitle: docTitle(db, project.doc_id),
          github: {
            enabled: Boolean(project.github_repo && project.github_token),
            repo: project.github_repo,
            syncEnabled: project.github_sync === 1,
          },
        },
        phases: phases.map((ph) => ({
          id: ph.id,
          name: ph.name,
          ord: ph.ord,
          status: ph.status,
          docId: ph.doc_id,
          docTitle: docTitle(db, ph.doc_id),
          release: (() => {
            const rl = releases.find((x) => x.phase_id === ph.id)
            return rl
              ? {
                  id: rl.id,
                  name: rl.name,
                  demo_status: rl.demo_status,
                  docId: rl.doc_id,
                  docTitle: docTitle(db, rl.doc_id),
                }
              : null
          })(),
          counts: {
            total: tasks.filter((t) => t.phase_id === ph.id).length,
            done: tasks.filter((t) => t.phase_id === ph.id && t.status === 'done').length,
          },
        })),
        releases: releases.map((rl) => ({
          id: rl.id,
          phaseId: rl.phase_id,
          name: rl.name,
          demo_status: rl.demo_status,
          demo_command: rl.demo_command,
          notes: rl.notes,
        })),
        tasks: tasks.map((t) => ({
          id: t.id,
          phaseId: t.phase_id,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          feature: t.feature,
          done_means: t.done_means,
          priority: t.priority,
          acceptance: t.acceptance,
          context: t.context,
          description: t.description,
          blockers: t.blockers,
          docId: t.doc_id,
        })),
        counts: taskCounts(db, project.id),
      })
    }),
  )

  // Phases
  r.post(
    '/api/projects/:id/phases',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
      if (!name) throw badRequest('name required')
      const ord = (
        db
          .prepare('SELECT COALESCE(MAX(ord),-1)+1 AS o FROM phases WHERE project_id=?')
          .get(project.id) as { o: number }
      ).o
      const id = randomId(12)
      db.prepare(
        'INSERT INTO phases (id, project_id, name, ord, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, project.id, name, ord, 'planned', now(), now())
      res.status(201).json({ phase: { id, name, ord, status: 'planned' } })
    }),
  )

  r.patch(
    '/api/phases/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const phase = phaseOf(db, accountId, req.params.id!)
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : undefined
      const status = ['planned', 'active', 'done'].includes(req.body?.status)
        ? req.body.status
        : undefined
      const docId =
        req.body?.doc_id === null
          ? null
          : typeof req.body?.doc_id === 'string'
            ? req.body.doc_id
            : undefined
      db.prepare(
        'UPDATE phases SET name=COALESCE(?, name), status=COALESCE(?, status), doc_id=COALESCE(?, doc_id), updated_at=? WHERE id=?',
      ).run(name ?? null, status ?? null, docId ?? null, now(), phase.id)
      res.json({ ok: true })
    }),
  )

  r.patch(
    '/api/projects/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : undefined
      const docId =
        req.body?.doc_id === null
          ? null
          : typeof req.body?.doc_id === 'string'
            ? req.body.doc_id
            : undefined
      db.prepare(
        'UPDATE projects SET name=COALESCE(?, name), doc_id=COALESCE(?, doc_id), updated_at=? WHERE id=?',
      ).run(name ?? null, docId ?? null, now(), project.id)
      res.json({ ok: true })
    }),
  )

  r.get(
    '/api/phases/:id/burndown',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const phase = phaseOf(db, accountId, req.params.id!)
      reindexIfStale(db, phase.project_id)
      const days = Math.min(Math.max(Number(req.query.days ?? 30), 2), 90)
      res.json(burndown(db, phase.id, days))
    }),
  )

  r.patch(
    '/api/projects/:id/github',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      const enabled = req.body?.enabled === false ? 0 : 1
      const repo =
        typeof req.body?.repo === 'string' && req.body.repo.trim()
          ? req.body.repo.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '')
          : undefined
      const token =
        typeof req.body?.token === 'string' && req.body.token.trim()
          ? req.body.token.trim()
          : undefined
      if (enabled === 1 && !repo && !project.github_repo)
        throw badRequest('repo required', 'Use owner/name format, e.g. djh00t/can-bang.')
      db.prepare(
        'UPDATE projects SET github_repo=COALESCE(?, github_repo), github_token=COALESCE(?, github_token), github_sync=?, updated_at=? WHERE id=?',
      ).run(repo ?? null, token ?? null, enabled, now(), project.id)
      const updated = db
        .prepare('SELECT github_repo, github_sync FROM projects WHERE id=?')
        .get(project.id) as {
        github_repo: string | null
        github_sync: number
      }
      res.json({
        ok: true,
        enabled: updated.github_sync === 1,
        repo: updated.github_repo,
        tokenSet: Boolean(token || project.github_token),
      })
    }),
  )

  r.post(
    '/api/projects/:id/sync-github',
    asyncHandler(async (req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      if (!project.github_repo || !project.github_token) {
        throw badRequest('github not configured', 'Enable GitHub sync on the project first.')
      }
      reindexIfStale(db, project.id)
      try {
        const summary = await syncProjectGithub(db, project.id, realGh(project.github_token))
        db.prepare('UPDATE projects SET github_sync=1, updated_at=? WHERE id=?').run(
          now(),
          project.id,
        )
        res.json({ ok: true, ...summary })
      } catch (err) {
        throw new ApiError(
          502,
          'github sync failed',
          err instanceof Error ? err.message : String(err),
        )
      }
    }),
  )

  // Releases
  r.post(
    '/api/phases/:id/releases',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const phase = phaseOf(db, accountId, req.params.id!)
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
      if (!name) throw badRequest('name required')
      const id = randomId(12)
      db.prepare(
        'INSERT INTO releases (id, phase_id, name, demo_status, demo_command, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(
        id,
        phase.id,
        name,
        'pending',
        typeof req.body?.demo_command === 'string' ? req.body.demo_command.slice(0, 300) : null,
        typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : null,
        now(),
        now(),
      )
      res.status(201).json({ release: { id, name, demo_status: 'pending' } })
    }),
  )

  r.patch(
    '/api/releases/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const release = releaseOf(db, accountId, req.params.id!)
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : undefined
      const demoStatus = ['pending', 'pass', 'partial', 'fail'].includes(req.body?.demo_status)
        ? req.body.demo_status
        : undefined
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : undefined
      const docId =
        req.body?.doc_id === null
          ? null
          : typeof req.body?.doc_id === 'string'
            ? req.body.doc_id
            : undefined
      db.prepare(
        `UPDATE releases SET name=COALESCE(?, name), demo_status=COALESCE(?, demo_status), notes=COALESCE(?, notes), doc_id=COALESCE(?, doc_id), updated_at=? WHERE id=?`,
      ).run(name ?? null, demoStatus ?? null, notes ?? null, docId ?? null, now(), release.id)
      res.json({ ok: true })
    }),
  )

  r.get(
    '/api/releases/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const release = releaseOf(db, accountId, req.params.id!)
      const phase = db.prepare('SELECT * FROM phases WHERE id=?').get(release.phase_id) as PhaseRow
      reindexIfStale(db, phase.project_id)
      const project = db
        .prepare('SELECT * FROM projects WHERE id=?')
        .get(phase.project_id) as ProjectRow
      const tasks = db
        .prepare('SELECT * FROM tasks WHERE phase_id=? ORDER BY created_at ASC')
        .all(phase.id) as TaskRow[]
      res.json({
        release: {
          id: release.id,
          name: release.name,
          demo_status: release.demo_status,
          demo_command: release.demo_command,
          notes: release.notes,
          docId: release.doc_id,
          docTitle: docTitle(db, release.doc_id),
          updated_at: release.updated_at,
        },
        phase: { id: phase.id, name: phase.name, status: phase.status },
        project: { id: project.id, name: project.name },
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee: t.assignee,
          feature: t.feature,
          done_means: t.done_means,
          priority: t.priority,
          acceptance: t.acceptance,
          context: t.context,
          docId: t.doc_id,
        })),
      })
    }),
  )

  // Tasks
  r.post(
    '/api/phases/:id/tasks',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const phase = phaseOf(db, accountId, req.params.id!)
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 200) : ''
      if (!title) throw badRequest('title required')
      const status = ['todo', 'doing', 'testing', 'done'].includes(req.body?.status)
        ? req.body.status
        : 'todo'
      const id = randomId(14)
      const assignee =
        typeof req.body?.assignee === 'string' ? req.body.assignee.slice(0, 40) : null
      const feature = typeof req.body?.feature === 'string' ? req.body.feature.slice(0, 80) : null
      const doneMeans =
        typeof req.body?.done_means === 'string' ? req.body.done_means.slice(0, 500) : null
      const description =
        typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : null
      const blockers =
        typeof req.body?.blockers === 'string' ? req.body.blockers.slice(0, 500) : null
      const taskDocId = typeof req.body?.doc_id === 'string' ? req.body.doc_id.slice(0, 40) : null
      const priority =
        typeof req.body?.priority === 'string' ? req.body.priority.slice(0, 20) : null
      const acceptance =
        typeof req.body?.acceptance === 'string' ? req.body.acceptance.slice(0, 500) : null
      const context = typeof req.body?.context === 'string' ? req.body.context.slice(0, 2000) : null
      const project = db
        .prepare('SELECT id, doc_id FROM projects WHERE id=?')
        .get(phase.project_id) as {
        id: string
        doc_id: string | null
      }
      const release =
        (
          db.prepare('SELECT name FROM releases WHERE phase_id=? LIMIT 1').get(phase.id) as
            { name: string } | undefined
        )?.name ?? null
      if (project.doc_id) {
        appendCard(db, project.doc_id, id, {
          title,
          status,
          phaseName: phase.name,
          assignee,
          feature,
          doneMeans,
          release,
          priority,
          acceptance,
          context,
        })
      }
      // description/blockers/doc link live on the task row (task metadata, not the card)
      db.prepare(
        `INSERT INTO tasks (id, phase_id, title, status, assignee, feature, done_means, priority, acceptance, context, description, blockers, doc_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        phase.id,
        title,
        status,
        assignee,
        feature,
        doneMeans,
        priority,
        acceptance,
        context,
        description,
        blockers,
        taskDocId,
        now(),
        now(),
      )
      recordTaskEvent(db, id, phase.id, status, now())
      reindexBoard(db, phase.project_id)
      res.status(201).json({ task: { id, title, status } })
    }),
  )

  r.patch(
    '/api/tasks/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const task = db
        .prepare(
          `SELECT t.* FROM tasks t JOIN phases ph ON ph.id = t.phase_id JOIN projects pr ON pr.id = ph.project_id
           WHERE t.id=? AND pr.owner_id=?`,
        )
        .get(req.params.id!, accountId) as TaskRow | undefined
      if (!task) throw notFound('task not found')
      const status = ['todo', 'doing', 'testing', 'done'].includes(req.body?.status)
        ? req.body.status
        : undefined
      const assignee =
        req.body?.assignee === null
          ? null
          : typeof req.body?.assignee === 'string'
            ? req.body.assignee.slice(0, 40)
            : undefined
      const feature =
        req.body?.feature === null
          ? null
          : typeof req.body?.feature === 'string'
            ? req.body.feature.slice(0, 80)
            : undefined
      const description =
        req.body?.description === null
          ? null
          : typeof req.body?.description === 'string'
            ? req.body.description.slice(0, 2000)
            : undefined
      const blockers =
        req.body?.blockers === null
          ? null
          : typeof req.body?.blockers === 'string'
            ? req.body.blockers.slice(0, 500)
            : undefined
      const docId =
        req.body?.doc_id === null
          ? null
          : typeof req.body?.doc_id === 'string'
            ? req.body.doc_id.slice(0, 40)
            : undefined
      const title =
        req.body?.title === null
          ? null
          : typeof req.body?.title === 'string'
            ? req.body.title.trim().slice(0, 200)
            : undefined
      const doneMeans =
        req.body?.done_means === null
          ? null
          : typeof req.body?.done_means === 'string'
            ? req.body.done_means.trim().slice(0, 500)
            : undefined
      const priority =
        req.body?.priority === null
          ? null
          : typeof req.body?.priority === 'string'
            ? req.body.priority.trim().slice(0, 20)
            : undefined
      const acceptance =
        req.body?.acceptance === null
          ? null
          : typeof req.body?.acceptance === 'string'
            ? req.body.acceptance.trim().slice(0, 500)
            : undefined
      const context =
        req.body?.context === null
          ? null
          : typeof req.body?.context === 'string'
            ? req.body.context.trim().slice(0, 2000)
            : undefined
      if (status && status !== task.status)
        recordTaskEvent(db, task.id, task.phase_id, status, now())
      db.prepare(
        `UPDATE tasks SET status=COALESCE(?, status), title=COALESCE(?, title), assignee=COALESCE(?, assignee),
           feature=COALESCE(?, feature), done_means=COALESCE(?, done_means), priority=COALESCE(?, priority),
           acceptance=COALESCE(?, acceptance), context=COALESCE(?, context),
           description=COALESCE(?, description), blockers=COALESCE(?, blockers), doc_id=COALESCE(?, doc_id), updated_at=? WHERE id=?`,
      ).run(
        status ?? null,
        title ?? null,
        assignee ?? null,
        feature ?? null,
        doneMeans ?? null,
        priority ?? null,
        acceptance ?? null,
        context ?? null,
        description ?? null,
        blockers ?? null,
        docId ?? null,
        now(),
        task.id,
      )
      const projectRow = db
        .prepare('SELECT project_id FROM phases WHERE id=?')
        .get(task.phase_id) as {
        project_id: string
      }
      const projectDoc = db
        .prepare('SELECT doc_id FROM projects WHERE id=?')
        .get(projectRow.project_id) as { doc_id: string | null }
      if (projectDoc.doc_id) {
        updateCard(db, projectDoc.doc_id, task.id, {
          ...(status ? { status } : {}),
          ...(title !== undefined ? { title: title ?? undefined } : {}),
          ...(assignee !== undefined ? { assignee } : {}),
          ...(feature !== undefined ? { feature } : {}),
          ...(doneMeans !== undefined ? { doneMeans } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(acceptance !== undefined ? { acceptance } : {}),
          ...(context !== undefined ? { context } : {}),
        })
      }
      reindexBoard(db, projectRow.project_id)
      res.json({ ok: true })
    }),
  )

  r.get(
    '/api/tasks/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const task = db
        .prepare(
          `SELECT t.* FROM tasks t JOIN phases ph ON ph.id = t.phase_id JOIN projects pr ON pr.id = ph.project_id
           WHERE t.id=? AND pr.owner_id=?`,
        )
        .get(req.params.id!, accountId) as TaskRow | undefined
      if (!task) throw notFound('task not found')
      const phase = db.prepare('SELECT * FROM phases WHERE id=?').get(task.phase_id) as PhaseRow
      reindexIfStale(db, phase.project_id)
      const project = db
        .prepare('SELECT * FROM projects WHERE id=?')
        .get(phase.project_id) as ProjectRow
      res.json({
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          feature: task.feature,
          done_means: task.done_means,
          description: task.description,
          blockers: task.blockers,
          docId: task.doc_id,
          docTitle: docTitle(db, task.doc_id),
          priority: task.priority,
          acceptance: task.acceptance,
          context: task.context,
        },
        phase: { id: phase.id, name: phase.name },
        project: { id: project.id, name: project.name },
      })
    }),
  )

  // Feature-status matrix
  r.get(
    '/api/projects/:id/matrix',
    asyncHandler((req: Request, res: Response) => {
      const accountId = accountIdOf(req)
      const project = projectOf(db, accountId, req.params.id!)
      reindexIfStale(db, project.id)
      const phases = db
        .prepare('SELECT * FROM phases WHERE project_id=? ORDER BY ord ASC')
        .all(project.id) as PhaseRow[]
      const releases = db
        .prepare(
          `SELECT rl.* FROM releases rl JOIN phases ph ON ph.id = rl.phase_id WHERE ph.project_id=? ORDER BY ph.ord ASC`,
        )
        .all(project.id) as ReleaseRow[]
      const tasks = db
        .prepare(
          `SELECT t.* FROM tasks t JOIN phases ph ON ph.id = t.phase_id WHERE ph.project_id=? ORDER BY t.created_at ASC`,
        )
        .all(project.id) as TaskRow[]
      const features = [...new Set(tasks.map((t) => t.feature ?? 'General'))].sort()
      const cell = (feature: string, phaseId: string): string => {
        const ts = tasks.filter(
          (t) => t.phase_id === phaseId && (t.feature ?? 'General') === feature,
        )
        if (!ts.length) return 'none'
        if (ts.every((t) => t.status === 'done')) return 'shipped'
        if (ts.some((t) => t.status === 'doing' || t.status === 'testing')) return 'in-progress'
        return 'planned'
      }
      res.json({
        project: { id: project.id, name: project.name },
        phases: phases.map((ph) => ({
          id: ph.id,
          name: ph.name,
          status: ph.status,
          release: releases.find((rl) => rl.phase_id === ph.id)
            ? {
                id: releases.find((rl) => rl.phase_id === ph.id)!.id,
                name: releases.find((rl) => rl.phase_id === ph.id)!.name,
                demo_status: releases.find((rl) => rl.phase_id === ph.id)!.demo_status,
              }
            : null,
        })),
        rows: features.map((feature) => ({
          feature,
          cells: phases.map((ph) => ({ phaseId: ph.id, status: cell(feature, ph.id) })),
        })),
      })
    }),
  )

  return r
}
