import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCtx, account, type TestCtx } from './helpers.js'
import { syncProjectGithub, issueBody, type GhClient } from '../src/github.js'

function fakeGh(
  overrides: Partial<GhClient> = {},
): GhClient & { calls: { method: string; path: string; body?: unknown }[] } {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const base: GhClient = {
    get: async (path) => {
      calls.push({ method: 'GET', path })
      return { status: 200, json: [] }
    },
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body })
      return { status: 201, json: { number: 42, html_url: 'https://github.com/x/y/issues/42' } }
    },
    patch: async (path, body) => {
      calls.push({ method: 'PATCH', path, body })
      return { status: 200, json: {} }
    },
  }
  return { ...base, ...overrides, calls }
}

describe('github issues sync', () => {
  let ctx: TestCtx
  beforeEach(() => {
    ctx = makeCtx()
  })
  afterEach(() => {
    ctx.db.close()
  })

  it('builds marker bodies and pushes tasks as issues', async () => {
    const { agent } = await account(ctx.app, 'gh-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Sync' })).body.project.id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P' })).body.phase
      .id as string
    await agent
      .post(`/api/phases/${phaseId}/tasks`)
      .send({ title: 'Fix import', feature: 'Docs', done_means: 'no errors' })
    await agent
      .patch(`/api/projects/${pid}/github`)
      .send({ enabled: true, repo: 'djh00t/repo', token: 'ghp_test' })
    const gh = fakeGh()
    const summary = await syncProjectGithub(ctx.db, pid, gh)
    expect(summary.created).toBe(1)
    const task = ctx.db
      .prepare('SELECT github_issue_id, github_issue_url FROM tasks WHERE phase_id=?')
      .get(phaseId) as {
      github_issue_id: number | null
      github_issue_url: string | null
    }
    expect(task.github_issue_id).toBe(42)
    expect(task.github_issue_url).toContain('issues/42')
    const body = gh.calls.find((c) => c.method === 'POST')?.body as { title: string; body: string }
    expect(body.title).toBe('Fix import')
    expect(body.body).toContain('<!-- workbench task -->')
    expect(issueBody({ done_means: 'x', phase_id: phaseId, feature: 'F' })).toContain('## phase')
  })

  it('closes issues for done tasks and imports Can Bang-marked issues', async () => {
    const { agent } = await account(ctx.app, 'gh-owner2')
    const pid = (await agent.post('/api/projects').send({ name: 'Sync2' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P' })).body.phase
      .id as string
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'Ship it' })
    await agent.patch(`/api/tasks/${task.body.task.id}`).send({ status: 'done' })
    await agent
      .patch(`/api/projects/${pid}/github`)
      .send({ enabled: true, repo: 'djh00t/repo', token: 'ghp_test' })
    ctx.db
      .prepare('UPDATE tasks SET github_issue_id=7, github_issue_url=? WHERE id=?')
      .run('https://github.com/djh00t/repo/issues/7', task.body.task.id as string)
    const marker = `${issueBody({ done_means: null, phase_id: phaseId, feature: 'F' })}`
    const gh = fakeGh({
      get: async () => ({
        status: 200,
        json: [
          {
            number: 99,
            title: 'From GitHub',
            state: 'open',
            body: marker,
            html_url: 'https://github.com/djh00t/repo/issues/99',
            assignee: { login: 'matt' },
          },
        ],
      }),
    })
    const summary = await syncProjectGithub(ctx.db, pid, gh)
    expect(summary.closed).toBe(1)
    const closeCall = gh.calls.find((c) => c.method === 'PATCH' && c.path.includes('/7'))
    expect((closeCall?.body as { state: string }).state).toBe('closed')
    expect(summary.imported).toBe(1)
    const imported = ctx.db
      .prepare('SELECT title, status, assignee FROM tasks WHERE github_issue_id=99')
      .get() as {
      title: string
      status: string
      assignee: string | null
    }
    expect(imported.title).toBe('From GitHub')
    expect(imported.assignee).toBe('matt')
    expect(imported.status).toBe('todo')
    // second sync does not duplicate
    const again = await syncProjectGithub(ctx.db, pid, gh)
    expect(again.imported).toBe(0)
  })

  it('stores github settings via the API without leaking the token', async () => {
    const { agent } = await account(ctx.app, 'gh-owner3')
    const { agent: other } = await account(ctx.app, 'gh-other')
    const pid = (await agent.post('/api/projects').send({ name: 'GH' })).body.project.id as string
    const patched = await agent
      .patch(`/api/projects/${pid}/github`)
      .send({ enabled: true, repo: 'djh00t/repo', token: 'ghp_secret' })
    expect(patched.status).toBe(200)
    expect(patched.body.tokenSet).toBe(true)
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.project.github.enabled).toBe(true)
    expect(JSON.stringify(overview.body)).not.toContain('ghp_secret')
    const denied = await other
      .patch(`/api/projects/${pid}/github`)
      .send({ enabled: true, repo: 'x/y' })
    expect(denied.status).toBe(404)
  })
})
