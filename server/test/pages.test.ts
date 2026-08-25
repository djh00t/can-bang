import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCtx, makeCtx, anonDoc, account, type TestCtx } from './helpers.js'

describe('pages, handoff, and 0.3 extras', () => {
  let ctx: TestCtx
  beforeEach(async () => {
    ctx = await makeCtx()
  })
  afterEach(async () => {
    await closeCtx(ctx)
  })

  it('serves agent handoffs: CLI fetchers get markdown, JSON manifest via Accept', async () => {
    const { id, key } = await anonDoc(ctx.app, '# Hi\n')
    const cli = await request(ctx.app).get(`/d/${id}`).set('user-agent', 'curl/8.0').query({ key })
    expect(cli.status).toBe(200)
    expect(cli.headers['content-type']).toContain('text/markdown')
    expect(cli.text).toContain('CanBang document')
    const manifest = await request(ctx.app)
      .get(`/d/${id}/agent`)
      .set('accept', 'application/json')
      .query({ key })
    expect(manifest.status).toBe(200)
    expect(manifest.body.id).toBe(id)
    expect(manifest.body.operations).toContain('replace')
    expect(manifest.body.serviceDoc).toContain('/agents.md')
    const jsonRoute = await request(ctx.app).get(`/d/${id}/agent.json`).query({ key })
    expect(jsonRoute.status).toBe(200)
    expect(jsonRoute.body.id).toBe(id)
    const raw = await request(ctx.app).get(`/d/${id}.md`).query({ key })
    expect(raw.text).toBe('# Hi\n')
  })

  it('serves reference docs and the publish page', async () => {
    const agents = await request(ctx.app).get('/agents.md')
    expect(agents.text).toContain('self-hosted CanBang-compatible')
    const browser = await request(ctx.app)
      .get('/agents.md')
      .set('accept', 'text/html')
      .set('user-agent', 'Mozilla/5.0 (Macintosh)')
    expect(browser.status).toBe(200)
    expect(browser.text).toContain('self-hosted CanBang-compatible')
    const cli = await request(ctx.app).get('/cli.md')
    expect(cli.text).toContain('mde login')
    const chief = await request(ctx.app).get('/chief.md')
    expect(chief.text).toContain('chief')
    const { id, key } = await anonDoc(ctx.app)
    const pub = await request(ctx.app).get(`/pub/${id}`).query({ key })
    expect(pub.status).toBe(200)
  })

  it('serves social preview metadata and a 1200x630 image', async () => {
    const { id, key } = await anonDoc(ctx.app)
    const page = await request(ctx.app)
      .get(`/d/${id}`)
      .query({ key })
      .set('accept', 'text/html')
      .set('user-agent', 'Mozilla/5.0 (social scraper)')
    expect(page.status).toBe(200)
    expect(page.text).toContain('<meta property="og:title" content="CanBang — Multi-Agent Canvas"')
    expect(page.text).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+\/og-image\.png"/)
    expect(page.text).toMatch(
      /<meta name="twitter:image" content="https?:\/\/[^"]+\/og-image\.png"/,
    )
    expect(page.text).toContain('<meta property="og:image:width" content="1200"')
    expect(page.text).toContain('<meta property="og:image:height" content="630"')

    const image = await request(ctx.app).get('/og-image.png')
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toContain('image/png')
    expect(image.body.readUInt32BE(16)).toBe(1200)
    expect(image.body.readUInt32BE(20)).toBe(630)
  })

  it('serves every workspace hierarchy URL for direct navigation and refresh', async () => {
    for (const path of [
      '/p/project-1',
      '/p/project-1/pipeline',
      '/p/project-1/matrix',
      '/p/project-1/phase/phase-1',
      '/p/project-1/phase/phase-1/task/task-1',
      '/p/project-1/release/release-1',
    ]) {
      const page = await request(ctx.app).get(path)
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toContain('text/html')
    }
  })

  it('lists templates and seeds docs via /new?template=', async () => {
    const list = await request(ctx.app).get('/api/templates')
    expect(list.body.templates.some((t: { slug: string }) => t.slug === 'agent-team-hq')).toBe(true)
    const content = await request(ctx.app).get('/api/templates/agent-team-hq')
    expect(content.body.content).toContain('```board')
    const redirect = await request(ctx.app).get('/new').query({ template: 'agent-team-hq' })
    expect(redirect.status).toBe(303)
    expect(redirect.headers.location).toMatch(/^\/d\//)
    const missing = await request(ctx.app).get('/new').query({ template: 'nope' })
    expect(missing.status).toBe(404)
  })

  it('scopes custom templates per account and publishes globally', async () => {
    const { agent } = await account(ctx.app, 'tmpl-owner')
    const created = await agent
      .post('/api/templates')
      .send({ slug: 'team-playbook', title: 'Team Playbook', content: '# Playbook\n' })
    expect(
      created.status,
      `${created.status} ${created.text} ${JSON.stringify(created.headers)}`,
    ).toBe(201)
    const anonList = await request(ctx.app).get('/api/templates')
    expect(anonList.body.templates.some((t: { slug: string }) => t.slug === 'team-playbook')).toBe(
      false,
    )
    const ownerList = await agent.get('/api/templates')
    expect(
      ownerList.status,
      `${ownerList.status} ${ownerList.text} ${JSON.stringify(ownerList.headers)}`,
    ).toBe(200)
    expect(ownerList.body.templates.some((t: { slug: string }) => t.slug === 'team-playbook')).toBe(
      true,
    )
    const { agent: other } = await account(ctx.app, 'other-user')
    const conflict = await other.post('/api/templates').send({
      slug: 'team-playbook',
      title: 'Hijacked Playbook',
      content: '# Hijacked\n',
    })
    expect(conflict.status).toBe(409)
    const preserved = await agent.get('/api/templates/team-playbook')
    expect(preserved.body.content).toBe('# Playbook\n')
    const published = await agent
      .post('/api/templates/team-playbook/publish')
      .send({ scope: 'global' })
    expect(published.status).toBe(200)
    const anonAfter = await request(ctx.app).get('/api/templates')
    expect(anonAfter.body.templates.some((t: { slug: string }) => t.slug === 'team-playbook')).toBe(
      true,
    )
    const denied = await other
      .post('/api/templates/team-playbook/publish')
      .send({ scope: 'account' })
    expect(denied.status).toBe(403)
  })

  it('submits and approves widgets, then seeds docs', async () => {
    const submitted = await request(ctx.app).post('/api/widgets').send({
      title: 'Vote',
      category: 'tool',
      html: '<button onclick="margin.setState({n:(margin.state.n||0)+1})">Vote</button>',
    })
    expect(submitted.status).toBe(201)
    expect(submitted.body.status).toBe('pending')
    const flagged = await request(ctx.app).post('/api/widgets').send({
      title: 'Sneaky',
      category: 'fun',
      html: '<script src="https://evil.example/x.js"></script>',
    })
    expect(flagged.body.lintFlags).toContain('external-script')
    const anonymousReview = await request(ctx.app)
      .post('/api/widgets/sneaky/review')
      .send({ status: 'approved' })
    expect(anonymousReview.status).toBe(401)
    const { agent } = await account(ctx.app, 'widget-owner')
    const approved = await agent.post('/api/widgets/vote/review').send({ status: 'approved' })
    expect(approved.status).toBe(200)
    const list = await request(ctx.app).get('/api/widgets')
    expect(list.body.widgets.length).toBe(1)
    const redirect = await request(ctx.app).get('/new').query({ widget: 'vote' })
    expect(redirect.status).toBe(303)
  })

  it('runs the full skill lifecycle: folder, SKILL.md, release, submit, review, manifest, diff', async () => {
    const { agent, token } = await account(ctx.app, 'skill-owner')
    const folder = await agent.post('/api/folders').send({ name: 'Import Auditor' })
    expect(folder.status, `${folder.status} ${folder.text} ${JSON.stringify(folder.headers)}`).toBe(
      201,
    )
    const folderId = folder.body.folder.id as string
    const skillDoc = await agent
      .post('/api/docs')
      .send({ title: 'SKILL.md', content: '# SKILL\n\nAudits imports.\n' })
    expect(
      skillDoc.status,
      `${skillDoc.status} ${skillDoc.text} ${JSON.stringify(skillDoc.headers)}`,
    ).toBe(201)
    await agent.post(`/api/docs/${skillDoc.body.doc.id}/move`).send({ folderId })
    const script = await agent
      .post('/api/docs')
      .send({ title: 'scripts/run.js', content: '// audit' })
    await agent.post(`/api/docs/${script.body.doc.id}/move`).send({ folderId })
    const release = await agent
      .post(`/api/folders/${folderId}/releases`)
      .send({ notes: 'first release' })
    expect(release.status).toBe(201)
    const share = await agent.post(`/api/folders/${folderId}/shares`).send({ role: 'view' })
    const shareUrl = share.body.share.url as string
    const submitted = await request(ctx.app)
      .post('/api/skills')
      .set('authorization', `Bearer ${token}`)
      .send({ shareUrl, category: 'developer' })
    expect(submitted.status).toBe(201)
    const slug = submitted.body.slug as string
    const status = await request(ctx.app)
      .get(`/api/skills/${slug}`)
      .set('authorization', `Bearer ${token}`)
    expect(status.body.status).toBe('pending')
    const reviewed = await agent.post(`/api/skills/${slug}/review`).send({ status: 'approved' })
    expect(reviewed.status).toBe(200)
    const manifest = await request(ctx.app).get(`/skills/${slug}/manifest?v=1`)
    expect(manifest.body.files.map((f: { path: string }) => f.path)).toContain('SKILL.md')
    expect(manifest.body.files[0].sha256).toBeTruthy()
    const releases = await agent.get(`/api/folders/${folderId}/releases`)
    expect(releases.body.releases.length).toBe(1)
    const diff = await agent.get(`/api/folders/${folderId}/releases/1/diff/1`)
    expect(diff.status).toBe(200)

    // A new release must snapshot the folder's current docs, not copy v1.
    const template = await agent
      .post('/api/docs')
      .send({ title: 'PULL_REQUEST_TEMPLATE.md', content: '## Summary\n' })
    await agent.post(`/api/docs/${template.body.doc.id}/move`).send({ folderId })
    const release2 = await agent
      .post(`/api/folders/${folderId}/releases`)
      .send({ notes: 'add template' })
    expect(release2.status).toBe(201)
    const manifest2 = await request(ctx.app).get(`/skills/${slug}/manifest?v=2`)
    expect(manifest2.body.version).toBe(2)
    const paths2 = manifest2.body.files.map((f: { path: string }) => f.path) as string[]
    expect(paths2).toContain('SKILL.md')
    expect(paths2).toContain('scripts/run.js')
    expect(paths2).toContain('PULL_REQUEST_TEMPLATE.md')

    const rate = await agent.post(`/api/skills/${slug}/rate`).send({ stars: 5 })
    expect(rate.status).toBe(200)
  })
})
