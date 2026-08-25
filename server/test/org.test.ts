import { createServer, type Server } from 'node:http'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCtx, makeCtx, anonDoc, HQ, account, type TestCtx } from './helpers.js'

describe('accounts and org', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await makeCtx()
  })
  afterEach(async () => {
    await closeCtx(ctx)
  })

  it('signs up, logs in/out, sets agent name, and manages tokens', async () => {
    const { agent, token } = await account(ctx.app, 'dave')
    const me = await agent.get('/api/me')
    expect(me.status, `${me.status} ${me.text} ${JSON.stringify(me.headers)}`).toBe(200)
    expect(me.body.user.username).toBe('dave')
    const renamed = await agent.post('/api/me/agent-name').send({ name: "Dave's agent" })
    expect(
      renamed.status,
      `${renamed.status} ${renamed.text} ${JSON.stringify(renamed.headers)}`,
    ).toBe(200)
    const me2 = await agent.get('/api/me')
    expect(me2.status, `${me2.status} ${me2.text} ${JSON.stringify(me2.headers)}`).toBe(200)
    expect(me2.body.user.agent_name).toBe("Dave's agent")
    const tokens = await agent.get('/api/tokens')
    expect(tokens.body.tokens.length).toBe(1)
    const tokenMe = await request(ctx.app).get('/api/me').set('authorization', `Bearer ${token}`)
    expect(tokenMe.body.user.username).toBe('dave')
    const logout = await agent.post('/api/auth/logout').send({})
    expect(logout.status).toBe(200)
    const after = await agent.get('/api/me')
    expect(after.status).toBe(401)
  })

  it('rejects cross-origin cookie mutations', async () => {
    const { agent } = await account(ctx.app, 'csrf-user')
    const res = await agent
      .post('/api/me/agent-name')
      .set('Origin', 'http://evil.example')
      .send({ name: 'x' })
    expect(res.status).toBe(403)
    expect(res.body.error).toContain('cross-origin')
  })

  it('manages one-level folders, moves docs, and scopes access via folder shares', async () => {
    const { agent, token } = await account(ctx.app, 'erin')
    const root = await agent.post('/api/folders').send({ name: 'Projects' })
    expect(root.status).toBe(201)
    const rootId = root.body.folder.id as string
    const child = await agent.post('/api/folders').send({ name: 'Launch', parentId: rootId })
    expect(child.status).toBe(201)
    const tooDeep = await agent
      .post('/api/folders')
      .send({ name: 'Nope', parentId: child.body.folder.id })
    expect(tooDeep.status).toBe(400)
    const doc = await agent.post('/api/docs').send({ title: 'Plan', content: '# Plan\n' })
    const docId = doc.body.doc.id as string
    const moved = await agent
      .post(`/api/docs/${docId}/move`)
      .send({ folderId: child.body.folder.id })
    expect(moved.status).toBe(200)
    const tree = await agent.get('/api/folders')
    const projects = tree.body.folders.find((f: { name: string }) => f.name === 'Projects')
    expect(projects.docCount).toBe(1)
    const share = await agent.post(`/api/folders/${rootId}/shares`).send({ role: 'view' })
    const folderKey = share.body.share.secret as string
    const read = await request(ctx.app)
      .get(`/api/docs/${docId}/content`)
      .set('x-share-key', folderKey)
    expect(read.status).toBe(200)
    const write = await request(ctx.app)
      .put(`/api/docs/${docId}/content`)
      .set('x-share-key', folderKey)
      .send({ content: 'x' })
    expect(write.status).toBe(403)
    const detail = await request(ctx.app)
      .get(`/api/folders/${rootId}`)
      .set('x-share-key', folderKey)
    expect(detail.status).toBe(200)
    const { agent: outsider } = await account(ctx.app, 'folder-outsider')
    const secrets = await outsider.get(`/api/folders/${rootId}/shares`)
    expect(secrets.status).toBe(404)
    expect(secrets.body.shares).toBeUndefined()
    const deleteFolder = await agent.delete(`/api/folders/${child.body.folder.id}`)
    expect(deleteFolder.status).toBe(200)
    const afterDelete = await agent.get('/api/docs')
    expect(afterDelete.body.docs[0].folderId).toBeNull()
    void token
  })

  it('ranks search results and filters by folder', async () => {
    const { agent, token } = await account(ctx.app, 'frank')
    await agent
      .post('/api/docs')
      .send({ title: 'Launch Plan', content: '# Launch Plan\nlaunch details here\n' })
    await agent
      .post('/api/docs')
      .send({ title: 'Other', content: '# Other\nlaunch plan buried deep in the text\n' })
    const exact = await request(ctx.app)
      .get(`/api/search?q=${encodeURIComponent('launch')}`)
      .set('authorization', `Bearer ${token}`)
    expect(exact.body.results[0].title).toBe('Launch Plan')
    const folder = await agent.post('/api/folders').send({ name: 'Q3' })
    const doc = await agent.post('/api/docs').send({ title: 'Q3 launch', content: 'launch in q3' })
    const moved = await agent
      .post(`/api/docs/${doc.body.doc.id}/move`)
      .send({ folderId: folder.body.folder.id })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    const filtered = await request(ctx.app)
      .get(`/api/search?q=${encodeURIComponent('launch folder:"Q3"')}`)
      .set('authorization', `Bearer ${token}`)
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200)
    expect(filtered.body.results.length).toBe(1)
    expect(filtered.body.results[0].title).toBe('Q3 launch')
  })

  it('registers agents, heartbeats, computes freshness, and deregisters', async () => {
    const { agent, token } = await account(ctx.app, 'grace')
    const doc = await agent.post('/api/docs').send({ title: 'G', content: '# G\n' })
    const id = doc.body.doc.id as string
    await request(ctx.app)
      .post('/api/agents/register')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'scout', harness: 'codex' })
    await request(ctx.app)
      .post('/api/agents/heartbeat')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'scout', currentTask: 'audit', currentDoc: id })
    const list = await request(ctx.app).get('/api/agents').set('authorization', `Bearer ${token}`)
    expect(list.body.agents[0].name).toBe('scout')
    expect(list.body.agents[0].freshness).toBe('live')
    ctx.db
      .prepare('UPDATE agents SET last_seen_at=? WHERE name=?')
      .run(Date.now() - 40 * 60_000, 'scout')
    const stale = await request(ctx.app).get('/api/agents').set('authorization', `Bearer ${token}`)
    expect(stale.body.agents[0].freshness).toBe('stale')
    await request(ctx.app).delete('/api/agents/scout').set('authorization', `Bearer ${token}`)
    const after = await request(ctx.app).get('/api/agents').set('authorization', `Bearer ${token}`)
    expect(after.body.agents.length).toBe(0)
  })

  it('delivers signed webhook deliveries through the outbox', async () => {
    const { id, key } = await anonDoc(ctx.app, HQ)
    let received: { headers: Record<string, unknown>; body: string } | undefined
    const server: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        received = { headers: req.headers as Record<string, unknown>, body }
        res.end('ok')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const created = await request(ctx.app)
      .post(`/api/docs/${id}/hooks`)
      .set('x-share-key', key)
      .send({ url: `http://127.0.0.1:${port}/hook`, events: ['chat.message'] })
    expect(created.status).toBe(201)
    const secret = created.body.hook.secret as string
    expect(secret.startsWith('whsec_')).toBe(true)
    await request(ctx.app)
      .post(`/api/docs/${id}/chat/message`)
      .set('x-share-key', key)
      .send({ text: 'ping' })
    await ctx.services.drainWebhooks()
    for (let i = 0; i < 50 && !received; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(received).toBeTruthy()
    expect(JSON.parse(received!.body).type).toBe('chat.message')
    const sig = received!.headers['x-margin-signature'] as string
    expect(sig.startsWith('sha256=')).toBe(true)
    const { hmacSha256 } = await import('../src/crypto.js')
    expect(sig).toBe(`sha256=${hmacSha256(secret, received!.body)}`)
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  it('uploads assets with content-addressing and refuses opaque binaries', async () => {
    const { id, key } = await anonDoc(ctx.app)
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
    const up = await request(ctx.app)
      .post(`/api/docs/${id}/assets`)
      .set('x-share-key', key)
      .set('content-type', 'image/png')
      .send(png)
    expect(up.status).toBe(200)
    expect(up.body.kind).toBe('image')
    expect(up.body.markdown).toContain('![](http')
    const url = new URL(up.body.url)
    const fetched = await request(ctx.app).get(url.pathname)
    expect(fetched.status).toBe(200)
    expect(fetched.headers['x-content-type-options']).toBe('nosniff')
    const code = await request(ctx.app)
      .post(`/api/docs/${id}/assets`)
      .set('x-share-key', key)
      .set('content-type', 'application/javascript')
      .set('x-asset-name', 'scripts/run.js')
      .send('console.log(1)')
    expect(code.status).toBe(200)
    expect(code.body.kind).toBe('code')
    expect(code.body.manifestPath).toBe('scripts/run.js')
    const zip = await request(ctx.app)
      .post(`/api/docs/${id}/assets`)
      .set('x-share-key', key)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('PK\x03\x04'))
    expect(zip.status).toBe(415)
    expect(zip.body.code).toBe('asset_not_readable')
  })

  it('exposes the owner inbox for awaiting-human docs, asks, and notify logs', async () => {
    const { agent, token } = await account(ctx.app, 'hugo')
    const doc = await agent.post('/api/docs').send({ title: 'I', content: HQ })
    const id = doc.body.doc.id as string
    await request(ctx.app)
      .post(`/api/docs/${id}/status`)
      .set('authorization', `Bearer ${token}`)
      .send({ state: 'awaiting-human', note: 'need input' })
    await request(ctx.app)
      .post(`/api/docs/${id}/asks`)
      .set('authorization', `Bearer ${token}`)
      .send({ text: 'open ask' })
    await request(ctx.app)
      .post(`/api/docs/${id}/notify`)
      .set('authorization', `Bearer ${token}`)
      .send({ message: 'heads up', level: 'info' })
    const inbox = await request(ctx.app).get('/api/inbox').set('authorization', `Bearer ${token}`)
    const types = inbox.body.items.map((i: { type: string }) => i.type)
    expect(types).toContain('status')
    expect(types).toContain('ask')
    expect(types).toContain('notify')
  })

  it('dismisses attention items so they leave the inbox', async () => {
    const { agent } = await account(ctx.app, 'dismiss-owner')
    const doc = await agent.post('/api/docs').send({ title: 'D', content: HQ })
    const id = doc.body.doc.id as string
    await agent.post(`/api/docs/${id}/status`).send({ state: 'awaiting-human', note: 'need input' })
    const ask = await agent.post(`/api/docs/${id}/asks`).send({ text: 'open ask' })
    await agent.post(`/api/docs/${id}/notify`).send({ message: 'heads up', level: 'info' })
    const before = await agent.get('/api/inbox')
    expect(before.body.items.some((i: { type: string }) => i.type === 'status')).toBe(true)
    expect(before.body.items.some((i: { type: string }) => i.type === 'ask')).toBe(true)
    await agent.post('/api/inbox/dismiss').send({ docId: id, type: 'status', ref: 'status' })
    await agent.post('/api/inbox/dismiss').send({ docId: id, type: 'ask', ref: ask.body.ask.id })
    const after = await agent.get('/api/inbox')
    expect(after.body.items.some((i: { type: string }) => i.type === 'status')).toBe(false)
    expect(after.body.items.some((i: { type: string }) => i.type === 'ask')).toBe(false)
    expect(after.body.items.some((i: { type: string }) => i.type === 'notify')).toBe(true)
    const outsider = await account(ctx.app, 'dismiss-outsider')
    const denied = await outsider.agent
      .post('/api/inbox/dismiss')
      .send({ docId: id, type: 'status' })
    expect(denied.status).toBe(404)
  })

  it('links asks to the task they reference for deep-linking', async () => {
    const { agent } = await account(ctx.app, 'ask-link')
    const pid = (await agent.post('/api/projects').send({ name: 'AskLink' })).body.project
      .id as string
    const phaseId = (await agent.post(`/api/projects/${pid}/phases`).send({ name: 'P' })).body.phase
      .id as string
    const task = await agent
      .post(`/api/phases/${phaseId}/tasks`)
      .send({ title: 'Fix the thing', acceptance: 'it works', done_means: 'verified by a human' })
    expect(task.status, JSON.stringify(task.body)).toBe(201)
    const taskId = task.body.task.id as string
    const overview = await agent.get(`/api/projects/${pid}`)
    await agent
      .post(`/api/docs/${overview.body.project.docId}/asks`)
      .send({ text: `Task ${taskId} needs a done-means before implementation` })
    const inbox = await agent.get('/api/inbox')
    const item = inbox.body.items.find((i: { type: string }) => i.type === 'ask')
    expect(item.taskId).toBe(taskId)
    expect(item.projectId).toBe(pid)
    expect(item.phaseId).toBe(phaseId)
  })
})
