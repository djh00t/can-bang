import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCtx, account, type TestCtx } from './helpers.js'

describe('workspace hierarchy', () => {
  let ctx: TestCtx
  beforeEach(() => {
    ctx = makeCtx()
  })
  afterEach(() => {
    ctx.db.close()
  })

  it('creates projects, phases, releases, tasks and returns an overview', async () => {
    const { agent } = await account(ctx.app, 'owner-ws')
    const created = await agent
      .post('/api/projects')
      .send({ name: 'Alpha', description: 'first project' })
    expect(created.status).toBe(201)
    const pid = created.body.project.id as string
    const list = await agent.get('/api/projects')
    const alpha = list.body.projects.find((p: { name: string }) => p.name === 'Alpha')
    expect(alpha).toBeTruthy()
    expect(list.body.projects.some((p: { name: string }) => p.name === 'Can Bang')).toBe(true) // seeded
    const phase = await agent.post(`/api/projects/${pid}/phases`).send({ name: 'Phase 1' })
    expect(phase.status).toBe(201)
    const phaseId = phase.body.phase.id as string
    const release = await agent
      .post(`/api/phases/${phaseId}/releases`)
      .send({ name: 'P1 demo', demo_command: 'bash demo/p1.sh' })
    expect(release.status).toBe(201)
    const releaseId = release.body.release.id as string
    const task = await agent
      .post(`/api/phases/${phaseId}/tasks`)
      .send({ title: 'Build the widget', feature: 'Widgets', assignee: 'builder-1' })
    expect(task.status).toBe(201)
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.phases.length).toBe(1)
    expect(overview.body.releases.length).toBe(1)
    expect(overview.body.tasks.length).toBe(1)
    expect(overview.body.counts.total).toBe(1)
    const detail = await agent.get(`/api/releases/${releaseId}`)
    expect(detail.body.release.demo_status).toBe('pending')
    expect(detail.body.tasks[0].title).toBe('Build the widget')
    void taskId
  })

  it('patches phase, release, and task state', async () => {
    const { agent } = await account(ctx.app, 'owner-patch')
    const pid = (await agent.post('/api/projects').send({ name: 'Beta' })).body.project.id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P' })).body.phase
      .id as string
    const releaseId = (await agent.post(`/api/phases/${phaseId}/releases`).send({ name: 'B demo' }))
      .body.release.id as string
    const taskId = (
      await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'T', feature: 'F' })
    ).body.task.id as string
    const phasePatch = await agent.patch(`/api/phases/${phaseId}`).send({ status: 'active' })
    expect(phasePatch.status).toBe(200)
    const releasePatch = await agent
      .patch(`/api/releases/${releaseId}`)
      .send({ demo_status: 'pass', notes: 'all green' })
    expect(releasePatch.status).toBe(200)
    const taskPatch = await agent.patch(`/api/tasks/${taskId}`).send({ status: 'done' })
    expect(taskPatch.status).toBe(200)
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.phases[0].status).toBe('active')
    expect(overview.body.releases[0].demo_status).toBe('pass')
    expect(overview.body.tasks[0].status).toBe('done')
  })

  it('aggregates the feature-status matrix across phases', async () => {
    const { agent } = await account(ctx.app, 'owner-matrix')
    const pid = (await agent.post('/api/projects').send({ name: 'Gamma' })).body.project
      .id as string
    const p1 = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'MVP' })).body.phase
      .id as string
    const p2 = (await agent.post(`/api/projects/${pid}/phases`).send({ name: '0.2' })).body.phase
      .id as string
    const mkTask = (phaseId: string, title: string, feature: string, status: string) =>
      agent.post(`/api/phases/${phaseId}/tasks`).send({ title, feature, status })
    await mkTask(p1, 'a', 'Docs', 'done')
    await mkTask(p1, 'b', 'Docs', 'done')
    await mkTask(p2, 'c', 'Docs', 'doing')
    await mkTask(p2, 'd', 'Auth', 'todo')
    const matrix = await agent.get(`/api/projects/${pid}/matrix`)
    expect(matrix.status).toBe(200)
    const docs = matrix.body.rows.find((r: { feature: string }) => r.feature === 'Docs')
    expect(docs.cells[0].status).toBe('shipped')
    expect(docs.cells[1].status).toBe('in-progress')
    const auth = matrix.body.rows.find((r: { feature: string }) => r.feature === 'Auth')
    expect(auth.cells[1].status).toBe('planned')
  })

  it('scopes workspace data to the owning account', async () => {
    const { agent: owner } = await account(ctx.app, 'ws-owner')
    const { agent: other } = await account(ctx.app, 'ws-other')
    const pid = (await owner.post('/api/projects').send({ name: 'Private' })).body.project
      .id as string
    const otherList = await other.get('/api/projects')
    expect(otherList.body.projects.some((p: { name: string }) => p.name === 'Private')).toBe(false)
    const forbidden = await other.get(`/api/projects/${pid}`)
    expect(forbidden.status).toBe(404)
  })

  it('supports task detail, extended fields, doc links, and burndown history', async () => {
    const { agent } = await account(ctx.app, 'owner-detail')
    const pid = (await agent.post('/api/projects').send({ name: 'Delta' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P' })).body.phase
      .id as string
    const doc = await agent.post('/api/docs').send({ title: 'Phase doc', content: '# P\n' })
    const docId = doc.body.doc.id as string
    const phaseLink = await agent.patch(`/api/phases/${phaseId}`).send({ doc_id: docId })
    expect(phaseLink.status).toBe(200)
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({
      title: 'T',
      feature: 'F',
      description: 'desc',
      blockers: 'needs token scope',
      done_means: 'works on retry',
    })
    const taskId = task.body.task.id as string
    const detail = await agent.get(`/api/tasks/${taskId}`)
    expect(detail.body.task.description).toBe('desc')
    expect(detail.body.task.blockers).toBe('needs token scope')
    const patch = await agent.patch(`/api/tasks/${taskId}`).send({ status: 'done', doc_id: docId })
    expect(patch.status).toBe(200)
    const detail2 = await agent.get(`/api/tasks/${taskId}`)
    expect(detail2.body.task.docTitle).toBe('Phase doc')
    const burndown = await agent.get(`/api/phases/${phaseId}/burndown?days=30`)
    expect(burndown.status).toBe(200)
    expect(burndown.body.total).toBe(1)
    expect(burndown.body.current).toBe(0)
    expect(burndown.body.points.length).toBeGreaterThan(0)
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.phases[0].docTitle).toBe('Phase doc')
  })
})
