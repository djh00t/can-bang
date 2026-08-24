import { randomId } from '@can-bang/core'
import type { Db } from './db.js'

export interface GhClient {
  get(path: string): Promise<{ status: number; json: unknown }>
  post(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }>
  patch(path: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }>
}

export function realGh(token: string): GhClient {
  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'can-bang',
        'x-github-api-version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      /* non-json response */
    }
    return { status: res.status, json }
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
  }
}

const MARKER = '<!-- workbench task -->'

export function issueBody(task: {
  done_means: string | null
  phase_id: string
  feature: string | null
}): string {
  return `${MARKER}

## done-means
${task.done_means ?? '_none_'}

## phase
${task.phase_id}

## feature
${task.feature ?? ''}
`
}

export async function syncProjectGithub(
  db: Db,
  projectId: string,
  gh: GhClient,
): Promise<{ created: number; updated: number; closed: number; imported: number }> {
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
    { github_repo: string | null; github_token: string | null } | undefined
  if (!project?.github_repo || !project.github_token) {
    throw new Error('github not configured')
  }
  const repo = project.github_repo
  const tasks = db
    .prepare(
      `SELECT t.* FROM tasks t JOIN phases ph ON ph.id = t.phase_id WHERE ph.project_id=? ORDER BY t.created_at ASC`,
    )
    .all(projectId) as {
    id: string
    title: string
    status: string
    done_means: string | null
    phase_id: string
    feature: string | null
    github_issue_id: number | null
    github_issue_url: string | null
  }[]
  let created = 0
  let updated = 0
  let closed = 0
  for (const task of tasks) {
    const body = issueBody(task)
    if (!task.github_issue_id) {
      const r = await gh.post(`/repos/${repo}/issues`, { title: task.title, body })
      if (r.status >= 200 && r.status < 300 && r.json && typeof r.json === 'object') {
        const issue = r.json as { number?: number; html_url?: string }
        if (issue.number) {
          db.prepare('UPDATE tasks SET github_issue_id=?, github_issue_url=? WHERE id=?').run(
            issue.number,
            issue.html_url ?? null,
            task.id,
          )
          created++
        }
      }
    } else {
      const state = task.status === 'done' ? 'closed' : 'open'
      await gh.patch(`/repos/${repo}/issues/${task.github_issue_id}`, {
        title: task.title,
        body,
        state,
      })
      updated++
      if (state === 'closed') closed++
    }
  }

  const list = await gh.get(
    `/repos/${repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
  )
  const issues = Array.isArray(list.json)
    ? (list.json as {
        number: number
        title: string
        state: string
        body: string | null
        html_url: string
        assignee: { login: string } | null
      }[])
    : []
  let imported = 0
  const validPhaseIds = new Set(
    (db.prepare('SELECT id FROM phases WHERE project_id=?').all(projectId) as { id: string }[]).map(
      (p) => p.id,
    ),
  )
  for (const issue of issues) {
    const body = issue.body ?? ''
    if (!body.includes(MARKER)) continue
    const phaseMatch = /## phase\n([A-Za-z0-9_-]+)/.exec(body)
    if (!phaseMatch || !validPhaseIds.has(phaseMatch[1]!)) continue
    const phaseId = phaseMatch[1]!
    const exists = db.prepare('SELECT id FROM tasks WHERE github_issue_id=?').get(issue.number)
    if (exists) continue
    const dm = /## done-means\n([^\n]*)/.exec(body)
    const feat = /## feature\n([^\n]*)/.exec(body)
    const id = randomId(14)
    const status = issue.state === 'closed' ? 'done' : 'todo'
    db.prepare(
      `INSERT INTO tasks (id, phase_id, title, status, assignee, feature, done_means, github_issue_id, github_issue_url, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      phaseId,
      issue.title,
      status,
      issue.assignee?.login ?? null,
      feat?.[1] ?? null,
      dm?.[1] && dm[1] !== '_none_' ? dm[1] : null,
      issue.number,
      issue.html_url,
      Date.now(),
      Date.now(),
    )
    db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
      id,
      phaseId,
      status,
      Date.now(),
    )
    imported++
  }
  return { created, updated, closed, imported }
}
