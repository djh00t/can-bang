import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCtx, anonDoc, HQ, account, type TestCtx } from './helpers.js'
import { escalateAsks } from '../src/routes/asks.js'

describe('asks', () => {
  let ctx: TestCtx
  beforeEach(() => {
    ctx = makeCtx()
  })
  afterEach(() => {
    ctx.db.close()
  })

  it('creates, claims atomically, and resolves asks', async () => {
    const { id, key } = await anonDoc(ctx.app, HQ)
    const created = await request(ctx.app)
      .post(`/api/docs/${id}/asks`)
      .set('x-share-key', key)
      .send({ text: 'Investigate the failing import', author: 'matt' })
    expect(created.status).toBe(201)
    expect(created.body.ask.state).toBe('open')
    const askId = created.body.ask.id as string
    const claim = await request(ctx.app)
      .post(`/api/docs/${id}/asks/${askId}/claim`)
      .set('x-share-key', key)
      .send({ agent: 'scout' })
    expect(claim.status).toBe(200)
    expect(claim.body.claimed).toBe(true)
    const second = await request(ctx.app)
      .post(`/api/docs/${id}/asks/${askId}/claim`)
      .set('x-share-key', key)
      .send({ agent: 'builder-1' })
    expect(second.status).toBe(409)
    expect(second.body.claimedBy).toBe('scout')
    const resolved = await request(ctx.app)
      .post(`/api/docs/${id}/asks/${askId}/resolve`)
      .set('x-share-key', key)
      .send({ note: 'fixed in the parser' })
    expect(resolved.status).toBe(200)
    expect(resolved.body.ask.state).toBe('resolved')
    const list = await request(ctx.app)
      .get(`/api/docs/${id}/asks?state=resolved`)
      .set('x-share-key', key)
    expect(list.body.asks.length).toBe(1)
  })

  it('gives the registered chief a priority window', async () => {
    const { agent, token } = await account(ctx.app, 'owner')
    const created = await agent.post('/api/docs').send({ title: 'HQ', content: HQ })
    const id = created.body.doc.id as string
    await request(ctx.app)
      .post('/api/agents/register')
      .set('authorization', `Bearer ${token}`)
      .send({ name: 'chief-1', role: 'chief' })
    const ask = await request(ctx.app)
      .post(`/api/docs/${id}/asks`)
      .set('authorization', `Bearer ${token}`)
      .send({ text: 'route me' })
    const askId = ask.body.ask.id as string
    const blocked = await request(ctx.app)
      .post(`/api/docs/${id}/asks/${askId}/claim`)
      .set('authorization', `Bearer ${token}`)
      .send({ agent: 'worker' })
    expect(blocked.status).toBe(409)
    expect(blocked.body.reason).toBe('chief-window')
    expect(blocked.body.windowEndsAt).toBeTruthy()
    const chiefClaim = await request(ctx.app)
      .post(`/api/docs/${id}/asks/${askId}/claim`)
      .set('authorization', `Bearer ${token}`)
      .send({ agent: 'chief-1' })
    expect(chiefClaim.status).toBe(200)
  })

  it('emits chief-window expiry and unclaimed escalation exactly once', async () => {
    const { id, key } = await anonDoc(ctx.app, HQ)
    const created = await request(ctx.app)
      .post(`/api/docs/${id}/asks`)
      .set('x-share-key', key)
      .send({ text: 'do the thing', ttlMinutes: 1, author: 'matt' })
    const askId = created.body.ask.id as string
    ctx.db
      .prepare('UPDATE asks SET chief_window_ends_at=?, created_at=? WHERE id=?')
      .run(Date.now() - 1000, Date.now() - 2 * 60_000, askId)
    escalateAsks(ctx.services)
    escalateAsks(ctx.services)
    const events = ctx.db
      .prepare("SELECT * FROM events WHERE doc_id=? AND type='ask.chief_window_expired'")
      .all(id)
    expect(events.length).toBe(1)
    const unclaimed = ctx.db
      .prepare("SELECT * FROM events WHERE doc_id=? AND type='ask.unclaimed'")
      .all(id)
    expect(unclaimed.length).toBe(1)
  })
})
