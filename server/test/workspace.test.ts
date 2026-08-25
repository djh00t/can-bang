import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCtx, makeCtx, account, type TestCtx } from './helpers.js'
import { backfillProjectDocs } from '../src/seed.js'

describe('workspace hierarchy', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await makeCtx()
  })
  afterEach(async () => {
    await closeCtx(ctx)
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
    expect(list.body.projects.some((p: { name: string }) => p.name === 'CanBang')).toBe(true) // seeded
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
    expect(
      releasePatch.status,
      `${releasePatch.status} ${releasePatch.text} ${JSON.stringify(releasePatch.headers)}`,
    ).toBe(200)
    const taskPatch = await agent.patch(`/api/tasks/${taskId}`).send({ status: 'done' })
    expect(taskPatch.status).toBe(200)
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.phases[0].status).toBe('active')
    expect(overview.body.releases[0].demo_status).toBe('pass')
    expect(overview.body.tasks[0].status).toBe('done')
  })

  it('mints project API keys with project-only access', async () => {
    const { agent } = await account(ctx.app, 'project-key-owner')
    const projectId = (await agent.post('/api/projects').send({ name: 'Scoped project' })).body
      .project.id as string
    const otherProjectId = (await agent.post('/api/projects').send({ name: 'Other project' })).body
      .project.id as string
    const phaseId = (await agent.post(`/api/projects/${projectId}/phases`).send({ name: 'MVP' }))
      .body.phase.id as string
    const externalDoc = await agent
      .post('/api/docs')
      .send({ title: 'External', content: '# External\n' })

    const minted = await agent.post(`/api/projects/${projectId}/api-keys`).send({ label: 'agent' })
    expect(minted.status).toBe(201)
    expect(minted.body.key).toMatch(/^pk_[A-Za-z0-9_-]+$/)
    expect(minted.body.label).toBe('agent')
    const key = minted.body.key as string
    const auth = { authorization: `Bearer ${key}` }
    const keyInfo = await request(ctx.app).get('/api/project-key').set(auth)
    expect(keyInfo.status).toBe(200)
    expect(keyInfo.body.projectId).toBe(projectId)
    const listed = await agent.get(`/api/projects/${projectId}/api-keys`)
    expect(listed.status).toBe(200)
    expect(listed.body.keys).toHaveLength(1)
    expect(listed.body.keys[0].revoked_at).toBeNull()

    const project = await request(ctx.app).get(`/api/projects/${projectId}`).set(auth)
    expect(project.status).toBe(200)
    expect(project.body.project.apiKeyCount).toBe(1)
    const task = await request(ctx.app)
      .post(`/api/phases/${phaseId}/tasks`)
      .set(auth)
      .send({ title: 'Agent task' })
    expect(task.status).toBe(201)
    const taskDetail = await request(ctx.app).get(`/api/tasks/${task.body.task.id}`).set(auth)
    expect(taskDetail.status).toBe(200)
    const unsafeLink = await request(ctx.app)
      .patch(`/api/tasks/${task.body.task.id}`)
      .set(auth)
      .send({ doc_id: externalDoc.body.doc.id })
    expect(unsafeLink.status).toBe(403)
    expect((await request(ctx.app).get(`/api/projects/${otherProjectId}`).set(auth)).status).toBe(
      404,
    )
    expect((await request(ctx.app).get('/api/projects').set(auth)).status).toBe(401)
    expect((await request(ctx.app).get('/api/me').set(auth)).status).toBe(401)
    expect(
      (await request(ctx.app).post(`/api/projects/${projectId}/api-keys`).set(auth)).status,
    ).toBe(401)
    const revoked = await agent.delete(
      `/api/projects/${projectId}/api-keys/${listed.body.keys[0].id}`,
    )
    expect(revoked.status).toBe(200)
    expect((await request(ctx.app).get(`/api/projects/${projectId}`).set(auth)).status).toBe(401)
    expect(
      (await agent.get(`/api/projects/${projectId}/api-keys`)).body.keys[0].revoked_at,
    ).toBeTypeOf('number')
  })

  it('persists project settings, configures GitHub, and mints owner-scoped keys', async () => {
    const { agent: owner } = await account(ctx.app, 'settings-owner')
    const { agent: other } = await account(ctx.app, 'settings-other')
    const pid = (
      await owner.post('/api/projects').send({ name: 'Before', description: 'Old description' })
    ).body.project.id as string

    const patch = await owner
      .patch('/api/projects/' + pid)
      .send({ name: 'After', description: 'New description' })
    expect(patch.status).toBe(200)
    const github = await owner.patch('/api/projects/' + pid + '/github').send({
      enabled: true,
      repo: 'acme/demo',
      token: 'test-token',
    })
    expect(github.status).toBe(200)

    const first = await owner.post('/api/projects/' + pid + '/key').send({ label: 'automation' })
    expect(first.status).toBe(201)
    expect(first.body.key).toMatch(/^pbk_[A-Za-z0-9_-]+$/)
    const second = await owner.post('/api/projects/' + pid + '/key').send({ label: 'release' })
    expect(second.status).toBe(201)
    expect(second.body.key).not.toBe(first.body.key)

    const overview = await owner.get('/api/projects/' + pid)
    expect(overview.body.project.name).toBe('After')
    expect(overview.body.project.description).toBe('New description')
    expect(overview.body.project.github).toMatchObject({ enabled: true, repo: 'acme/demo' })
    expect(JSON.stringify(overview.body)).not.toContain(first.body.key)
    const stored = ctx.db
      .prepare(
        'SELECT project_id, key_hash, label FROM project_keys WHERE project_id=? ORDER BY created_at',
      )
      .all(pid) as { project_id: string; key_hash: string; label: string | null }[]
    expect(stored).toHaveLength(2)
    expect(stored[0]).toMatchObject({ project_id: pid, label: 'automation' })
    expect(stored[0].key_hash).not.toBe(first.body.key)

    const keyOverview = await request(ctx.app)
      .get('/api/projects/' + pid)
      .set('authorization', 'Bearer ' + first.body.key)
    expect(keyOverview.status).toBe(200)
    expect(keyOverview.body.project.id).toBe(pid)
    const accountRoute = await request(ctx.app)
      .get('/api/me')
      .set('authorization', 'Bearer ' + first.body.key)
    expect(accountRoute.status).toBe(401)
    const projectList = await request(ctx.app)
      .get('/api/projects')
      .set('authorization', 'Bearer ' + first.body.key)
    expect(projectList.status).toBe(403)
    const otherPid = (await other.post('/api/projects').send({ name: 'Other project' })).body
      .project.id as string
    const crossProject = await request(ctx.app)
      .get('/api/projects/' + otherPid)
      .set('authorization', 'Bearer ' + first.body.key)
    expect(crossProject.status).toBe(404)
    const denied = await other
      .post('/api/projects/' + pid + '/key')
      .send({ label: 'wrong-account' })
    expect(denied.status).toBe(404)
  })

  it('aggregates the feature-status matrix across phases', async () => {
    const { agent } = await account(ctx.app, 'owner-matrix')
    const pid = (await agent.post('/api/projects').send({ name: 'Gamma' })).body.project
      .id as string
    const p1Response = await agent.post(`/api/projects/${pid}/phases`).send({ name: 'MVP' })
    expect(p1Response.status, JSON.stringify(p1Response.body)).toBe(201)
    const p1 = p1Response.body.phase.id as string
    const p2Response = await agent.post(`/api/projects/${pid}/phases`).send({ name: '0.2' })
    expect(p2Response.status, JSON.stringify(p2Response.body)).toBe(201)
    const p2 = p2Response.body.phase.id as string
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

  it('aggregates project burndown history across phases', async () => {
    const { agent } = await account(ctx.app, 'owner-project-burndown')
    const pid = (await agent.post('/api/projects').send({ name: 'Project burndown' })).body.project
      .id as string
    const p1 = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'MVP' })).body.phase
      .id as string
    const p2 = (await agent.post(`/api/projects/${pid}/phases`).send({ name: '0.2' })).body.phase
      .id as string
    await agent.post(`/api/phases/${p1}/tasks`).send({ title: 'Open MVP task', status: 'todo' })
    await agent.post(`/api/phases/${p2}/tasks`).send({ title: 'Done 0.2 task', status: 'done' })
    await agent.post(`/api/phases/${p2}/tasks`).send({ title: 'Doing 0.2 task', status: 'doing' })

    const burndown = await agent.get(`/api/projects/${pid}/burndown?days=30`)
    expect(burndown.status).toBe(200)
    expect(burndown.body.total).toBe(3)
    expect(burndown.body.current).toBe(2)
    expect(burndown.body.points.length).toBeGreaterThan(0)
    expect(burndown.body.points.some((point: { remaining: number }) => point.remaining === 2)).toBe(
      true,
    )

    const { agent: other } = await account(ctx.app, 'other-project-burndown')
    expect((await other.get(`/api/projects/${pid}/burndown`)).status).toBe(404)
  })

  it('counts a task again after it is reopened', async () => {
    const { agent } = await account(ctx.app, 'owner-project-burndown-reopen')
    const pid = (await agent.post('/api/projects').send({ name: 'Reopen burndown' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'MVP' })).body
      .phase.id as string
    const taskId = (
      await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'Reopen me', status: 'todo' })
    ).body.task.id as string

    expect((await agent.patch(`/api/tasks/${taskId}`).send({ status: 'done' })).status).toBe(200)
    expect((await agent.patch(`/api/tasks/${taskId}`).send({ status: 'doing' })).status).toBe(200)

    const burndown = await agent.get(`/api/projects/${pid}/burndown?days=30`)
    expect(burndown.status).toBe(200)
    expect(burndown.body.total).toBe(1)
    expect(burndown.body.current).toBe(1)
    expect(burndown.body.points.some((point: { remaining: number }) => point.remaining === 1)).toBe(
      true,
    )
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
      priority: 'high',
      description: 'desc',
      blockers: 'needs token scope',
      done_means: 'works on retry',
    })
    const taskId = task.body.task.id as string
    const detail = await agent.get(`/api/tasks/${taskId}`)
    expect(detail.body.task.description).toBe('desc')
    expect(detail.body.task.blockers).toBe('needs token scope')
    expect(detail.body.task.priority).toBe('high')
    const overview0 = await agent.get(`/api/projects/${pid}`)
    const doc0 = await agent.get(`/api/docs/${overview0.body.project.docId}/content`)
    expect(doc0.text).toContain('priority: high')
    const patch = await agent.patch(`/api/tasks/${taskId}`).send({ status: 'done', doc_id: docId })
    expect(patch.status).toBe(200)
    const priorityPatch = await agent.patch(`/api/tasks/${taskId}`).send({ priority: 'low' })
    expect(priorityPatch.status).toBe(200)
    const detail2 = await agent.get(`/api/tasks/${taskId}`)
    expect(detail2.body.task.docTitle).toBe('Phase doc')
    expect(detail2.body.task.priority).toBe('low')
    const burndown = await agent.get(`/api/phases/${phaseId}/burndown?days=30`)
    expect(burndown.status).toBe(200)
    expect(burndown.body.total).toBe(1)
    expect(burndown.body.current).toBe(0)
    expect(burndown.body.points.length).toBeGreaterThan(0)
    const overview = await agent.get(`/api/projects/${pid}`)
    expect(overview.body.phases[0].docTitle).toBe('Phase doc')
  })

  it('clears task priority when the project has no HQ document', async () => {
    const { agent } = await account(ctx.app, 'priority-clear')
    const pid = (await agent.post('/api/projects').send({ name: 'Priority clear' })).body.project
      .id as string
    const phaseResponse = await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })
    expect(
      phaseResponse.status,
      `${phaseResponse.status} ${phaseResponse.text} ${JSON.stringify(phaseResponse.headers)}`,
    ).toBe(201)
    const phaseId = phaseResponse.body.phase.id as string
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({
      title: 'Clear priority',
      priority: 'high',
    })
    const taskId = task.body.task.id as string
    ctx.db.prepare('UPDATE projects SET doc_id=NULL WHERE id=?').run(pid)

    const patch = await agent.patch(`/api/tasks/${taskId}`).send({ priority: null })
    expect(patch.status).toBe(200)
    const detail = await agent.get(`/api/tasks/${taskId}`)
    expect(detail.body.task.priority).toBeNull()
  })

  it('backfills HQ docs for projects without one', async () => {
    const { agent } = await account(ctx.app, 'bf-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Bare' })).body.project.id as string
    ctx.db.prepare('UPDATE projects SET doc_id=NULL WHERE id=?').run(pid)
    backfillProjectDocs(ctx.db)
    const row = ctx.db.prepare('SELECT doc_id FROM projects WHERE id=?').get(pid) as {
      doc_id: string | null
    }
    expect(row.doc_id).toBeTruthy()
    const doc = ctx.db.prepare('SELECT title, content FROM docs WHERE id=?').get(row.doc_id) as {
      title: string
      content: string
    }
    expect(doc.title).toBe('Bare — HQ')
    expect(doc.content).toContain('```chat')
  })

  it('mirrors the task board into the project doc board fence', async () => {
    const { agent } = await account(ctx.app, 'board-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'BoardSync' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const task = await agent
      .post(`/api/phases/${phaseId}/tasks`)
      .send({ title: 'Build the widget', feature: 'Widgets' })
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    const doc = await agent.get(`/api/docs/${docId}/content`)
    expect(doc.text).toContain('Build the widget')
    expect(doc.text).toContain(`task: ${taskId}`)
  })

  it('preserves release metadata through card updates and reindexing', async () => {
    const { agent } = await account(ctx.app, 'release-board-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Release board' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const release = await agent.post(`/api/phases/${phaseId}/releases`).send({ name: '0.3 demo' })
    expect(release.status).toBe(201)
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'Ship the demo' })
    expect(task.status).toBe(201)
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string

    const initial = await agent.get(`/api/docs/${docId}/content`)
    expect(initial.text).toContain('  release: 0.3 demo')

    const patch = await agent.patch(`/api/tasks/${taskId}`).send({ status: 'doing' })
    expect(patch.status).toBe(200)
    const updated = await agent.get(`/api/docs/${docId}/content`)
    expect(updated.text).toContain('  release: 0.3 demo')

    const version = updated.headers['x-doc-version'] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content: `${updated.text}\n` })
    expect(put.status).toBe(200)
    const reindexed = await agent.get(`/api/projects/${pid}`)
    expect(reindexed.body.tasks.find((t: { id: string }) => t.id === taskId).status).toBe('doing')
    const afterReindex = await agent.get(`/api/docs/${docId}/content`)
    expect(afterReindex.text).toContain('  release: 0.3 demo')
  })

  it('absorbs agent edits to the doc board back into tasks', async () => {
    const { agent } = await account(ctx.app, 'claim-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Claims' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'Claim me' })
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    let content = (await agent.get(`/api/docs/${docId}/content`)).text
    // Agent claims the card: move it under Doing with a [>] marker (clean fence edit).
    const fenceStart = content.indexOf('```board')
    const fenceEnd = content.indexOf('```', fenceStart + 3)
    content =
      content.slice(0, fenceStart) +
      '```board #tickets\n## Doing\n- [>] Claim me\n  task: ' +
      taskId +
      '\n  phase: P1\n## Todo\n## Testing\n## Done\n```' +
      content.slice(fenceEnd + 3)
    const version = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content })
    expect(put.status).toBe(200)
    const after = await agent.get(`/api/projects/${pid}`)
    expect(after.body.tasks.find((t: { id: string }) => t.id === taskId).status).toBe('doing')

    // Agent adds a brand-new card without a task marker.
    let content2 = (await agent.get(`/api/docs/${docId}/content`)).text
    content2 = content2.replace(
      '## Todo\n',
      '## Todo\n- [ ] New agent card @agent #newfeat\n  phase: P1\n  done-means: verified by a human\n',
    )
    const version2 = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version2)
      .send({ content: content2 })
    const after2 = await agent.get(`/api/projects/${pid}`)
    const added = after2.body.tasks.find((t: { title: string }) => t.title === 'New agent card')
    expect(added).toBeTruthy()
    expect(added.assignee).toBe('agent')
    expect(added.status).toBe('todo')
  })

  it('indexes multiple agent-added cards with their own task markers', async () => {
    const { agent } = await account(ctx.app, 'multi-card-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Multi card sync' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    const original = (await agent.get(`/api/docs/${docId}/content`)).text
    const fenceStart = original.indexOf('```board')
    const fenceEnd = original.indexOf('```', fenceStart + 3)
    const content =
      original.slice(0, fenceStart) +
      '```board #tickets\n## Todo\n- [ ] First agent card\n  phase: P1\n- [ ] Second agent card\n  phase: P1\n## Doing\n## Testing\n## Done\n```' +
      original.slice(fenceEnd + 3)
    const version = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content })
    expect(put.status).toBe(200)

    const after = await agent.get(`/api/projects/${pid}`)
    const board = (await agent.get(`/api/docs/${docId}/content`)).text
    const firstTaskId = /- \[ \] First agent card\n  task: ([^\n]+)/.exec(board)?.[1]
    const secondTaskId = /- \[ \] Second agent card\n  task: ([^\n]+)/.exec(board)?.[1]
    expect(firstTaskId).toBeTruthy()
    expect(secondTaskId).toBeTruthy()
    expect(firstTaskId).not.toBe(secondTaskId)
    expect(after.body.tasks.find((task: { id: string }) => task.id === firstTaskId).title).toBe(
      'First agent card',
    )
    expect(after.body.tasks.find((task: { id: string }) => task.id === secondTaskId).title).toBe(
      'Second agent card',
    )
    void phaseId
  })

  it('records doc-driven status changes in the burndown', async () => {
    const { agent } = await account(ctx.app, 'burn-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Burndown' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const task = await agent
      .post(`/api/phases/${phaseId}/tasks`)
      .send({ title: 'Finish the release' })
    const taskId = task.body.task.id as string
    const before = await agent.get(`/api/phases/${phaseId}/burndown?days=30`)
    expect(before.body.current).toBe(1)

    // Agent moves the card to Done directly in the doc.
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    let content = (await agent.get(`/api/docs/${docId}/content`)).text
    const fenceStart = content.indexOf('```board')
    const fenceEnd = content.indexOf('```', fenceStart + 3)
    content =
      content.slice(0, fenceStart) +
      '```board #tickets\n## Done\n- [x] Finish the release\n  task: ' +
      taskId +
      '\n  phase: P1\n## Todo\n## Doing\n## Testing\n```' +
      content.slice(fenceEnd + 3)
    const version = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content })
    expect(put.status).toBe(200)
    await agent.get(`/api/projects/${pid}`) // reindex
    const after = await agent.get(`/api/phases/${phaseId}/burndown?days=30`)
    expect(after.body.current).toBe(0)
    const doneEvent = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id=? AND status='done'")
      .get(taskId) as { c: number }
    expect(doneEvent.c).toBeGreaterThan(0)
    const watermark = ctx.db
      .prepare(
        'SELECT p.board_indexed_at, d.updated_at FROM projects p JOIN docs d ON d.id=p.doc_id WHERE p.id=?',
      )
      .get(pid) as { board_indexed_at: number; updated_at: number }
    expect(watermark.board_indexed_at).toBe(watermark.updated_at)
  })

  it('reindexes a doc board edit made in the same millisecond', async () => {
    const { agent } = await account(ctx.app, 'same-tick-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Same tick' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({ title: 'Same-tick task' })
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    const sameTick = Date.now() + 100_000
    ctx.db.prepare('UPDATE docs SET updated_at=? WHERE id=?').run(sameTick, docId)
    ctx.db.prepare('UPDATE projects SET board_indexed_at=? WHERE id=?').run(sameTick, pid)
    const doc = await agent.get(`/api/docs/${docId}/content`)
    const card = `- [ ] Same-tick task\n  task: ${taskId}\n  phase: P1`
    expect(doc.text).toContain(card)
    const doneCard = card.replace('- [ ]', '- [x]')
    const content = doc.text.replace(card, '').replace('## Done\n', `## Done\n${doneCard}\n`)
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', doc.headers['x-doc-version'])
      .send({ content })
    expect(put.status).toBe(200)

    const after = await agent.get(`/api/projects/${pid}`)
    expect(after.body.tasks.find((item: { id: string }) => item.id === taskId).status).toBe('done')
    const doneEvent = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM task_events WHERE task_id=? AND status='done'")
      .get(taskId) as { c: number }
    expect(doneEvent.c).toBeGreaterThan(0)
  })

  it('round-trips acceptance and context through the API and the doc board', async () => {
    const { agent } = await account(ctx.app, 'spec-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Spec' })).body.project.id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({
      title: 'Spec task',
      acceptance: 'Given the API key is set, the sync runs and posts a PR link',
      context: 'Agents must clear prior task context before claiming this card.',
    })
    expect(task.status).toBe(201)
    const taskId = task.body.task.id as string

    const detail = await agent.get(`/api/tasks/${taskId}`)
    expect(detail.body.task.acceptance).toContain('API key is set')
    expect(detail.body.task.context).toContain('clear prior task context')

    const overview = await agent.get(`/api/projects/${pid}`)
    const fromList = overview.body.tasks.find((t: { id: string }) => t.id === taskId)
    expect(fromList.acceptance).toContain('API key is set')
    expect(fromList.context).toContain('clear prior task context')

    // The doc board fence is the record: both fields must be mirrored into it.
    const docId = overview.body.project.docId as string
    const doc0 = await agent.get(`/api/docs/${docId}/content`)
    expect(doc0.text).toContain('acceptance: Given the API key is set')
    expect(doc0.text).toContain('context: Agents must clear prior task context')

    // Patching through the API updates the doc fence too.
    const patch = await agent.patch(`/api/tasks/${taskId}`).send({
      acceptance: 'Given the API key is set, the sync posts exactly one PR per card',
      context: null,
    })
    expect(patch.status).toBe(200)
    const detail2 = await agent.get(`/api/tasks/${taskId}`)
    expect(detail2.body.task.acceptance).toContain('exactly one PR per card')
    expect(detail2.body.task.context).toBeNull()
    const doc1 = await agent.get(`/api/docs/${docId}/content`)
    expect(doc1.text).toContain(
      'acceptance: Given the API key is set, the sync posts exactly one PR per card',
    )
    expect(doc1.text).not.toContain('context: Agents must clear prior task context')

    // An agent editing the fence directly is absorbed back into the task row.
    let content = doc1.text
    content = content.replace(
      '  acceptance: Given the API key is set, the sync posts exactly one PR per card\n',
      '  acceptance: Given the API key is set, the sync posts exactly one PR per card\n  context: Claimed after the previous card context is closed.\n',
    )
    const version = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content })
    expect(put.status).toBe(200)
    const after = await agent.get(`/api/projects/${pid}`)
    const refreshed = after.body.tasks.find((t: { id: string }) => t.id === taskId)
    expect(refreshed.context).toContain('Claimed after the previous card context is closed')
  })

  it('mirrors multiline spec fields through the board fence without truncation', async () => {
    const { agent } = await account(ctx.app, 'multiline-owner')
    const pid = (await agent.post('/api/projects').send({ name: 'Multiline' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P1' })).body
      .phase.id as string
    const acceptance =
      'Given the API key is set\nthe sync posts exactly one PR per card\nand never self-merges'
    const task = await agent.post(`/api/phases/${phaseId}/tasks`).send({
      title: 'Multiline spec',
      acceptance,
      context: 'Claimed after the previous card context is closed',
    })
    expect(task.status).toBe(201)
    const taskId = task.body.task.id as string

    // The fence stores continuation lines under the same field.
    const overview = await agent.get(`/api/projects/${pid}`)
    const docId = overview.body.project.docId as string
    const doc0 = await agent.get(`/api/docs/${docId}/content`)
    expect(doc0.text).toContain(
      '  acceptance: Given the API key is set\n  the sync posts exactly one PR per card\n  and never self-merges',
    )

    const detail = await agent.get(`/api/tasks/${taskId}`)
    expect(detail.body.task.acceptance).toBe(acceptance)

    // A reindex (project fetch) must not truncate the multiline value.
    const overview2 = await agent.get(`/api/projects/${pid}`)
    const fromList = overview2.body.tasks.find((t: { id: string }) => t.id === taskId)
    expect(fromList.acceptance).toBe(acceptance)

    // An agent editing the fence with continuation lines is absorbed back intact.
    let content = (await agent.get(`/api/docs/${docId}/content`)).text
    content = content.replace(
      '  and never self-merges\n',
      '  and never self-merges\n  or merges someone else\u2019s PR\n',
    )
    const version = (await agent.get(`/api/docs/${docId}/content`)).headers[
      'x-doc-version'
    ] as string
    const put = await agent
      .put(`/api/docs/${docId}/content`)
      .set('if-match', version)
      .send({ content })
    expect(put.status).toBe(200)
    const after = await agent.get(`/api/projects/${pid}`)
    const refreshed = after.body.tasks.find((t: { id: string }) => t.id === taskId)
    expect(refreshed.acceptance).toBe(
      'Given the API key is set\nthe sync posts exactly one PR per card\nand never self-merges\nor merges someone else’s PR',
    )
  })
})
