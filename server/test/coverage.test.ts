import { describe, expect, it, vi } from 'vitest'
import type { Response } from 'express'
import { ApiError } from '@can-bang/core'
import { jsonError, parseJson, pick, clientUrl, mentionsActor } from '../src/util.js'
import {
  hashPassword,
  verifyPassword,
  hashSecret,
  hmacSha256,
  safeEqual,
  stripSecrets,
} from '../src/crypto.js'
import { EventBus } from '../src/events.js'
import { RateLimiter } from '../src/rate.js'
import { AppServices } from '../src/service.js'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function mockRes() {
  const state: { status: number; body: unknown; headers: Record<string, string> } = {
    status: 200,
    body: undefined,
    headers: {},
  }
  return {
    state,
    status(code: number) {
      state.status = code
      return this
    },
    json(body: unknown) {
      state.body = body
      return this
    },
    set(k: string, v: string) {
      state.headers[k] = v
      return this
    },
  } as unknown as Response
}

describe('utility coverage', () => {
  it('formats API errors including hints and extras', () => {
    const res1 = mockRes()
    jsonError(res1, new ApiError(409, 'conflict', 'retry', { currentVersion: 'v1' }))
    expect(res1.state.status).toBe(409)
    expect(res1.state.body).toMatchObject({
      error: 'conflict',
      hint: 'retry',
      currentVersion: 'v1',
    })
    const res2 = mockRes()
    const syntax = new SyntaxError('bad json') as SyntaxError & { body?: unknown }
    syntax.body = {}
    jsonError(res2, syntax)
    expect(res2.state.status).toBe(400)
    const res3 = mockRes()
    jsonError(res3, new Error('boom'))
    expect(res3.state.status).toBe(500)
  })

  it('parses and picks JSON bodies safely', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 })
    expect(parseJson('not json')).toBeUndefined()
    expect(parseJson(undefined)).toBeUndefined()
    expect(pick({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 })
    expect(pick(null, ['a'])).toEqual({})
    expect(pick({ a: undefined }, ['a'])).toEqual({})
  })

  it('builds client URLs and detects mentions', () => {
    const req = { headers: { host: 'hq.local' }, get: () => undefined } as never
    expect(clientUrl(req as never, 'http://fallback')).toBe('http://hq.local')
    const req2 = { headers: {} } as never
    expect(clientUrl(req2 as never, 'http://fallback')).toBe('http://fallback')
    expect(mentionsActor({ text: 'hey @scout look' }, 'scout')).toBe(true)
    expect(mentionsActor({ body: 'no mentions' }, 'scout')).toBe(false)
  })

  it('hashes passwords and secrets, signs HMACs, and strips secrets', async () => {
    const hash = await hashPassword('hunter2-secure')
    expect(hash).not.toBe('hunter2-secure')
    expect(await verifyPassword('hunter2-secure', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
    expect(hashSecret('abc')).toBe(hashSecret('abc'))
    expect(hashSecret('abc')).not.toBe(hashSecret('abd'))
    expect(hmacSha256('k', 'body')).toMatch(/^[0-9a-f]{64}$/)
    expect(safeEqual('same', 'same')).toBe(true)
    expect(safeEqual('a', 'b')).toBe(false)
    const redacted = stripSecrets(
      'token mgn_abcdefghijklmnop and whsec_abcdefghijklmnop key=abcdefghijklmnop',
    )
    expect(redacted).not.toContain('mgn_abcdefghijklmnop')
    expect(redacted).toContain('mgn_…')
  })

  it('event bus wakes waiters on publish and times out otherwise', async () => {
    const bus = new EventBus()
    const waiter = bus.wait('d1', 0, 5000)
    bus.publish('d1', { seq: 1, type: 'x', ts: 1, actor: 'a', guest: false, payload: {} })
    expect((await waiter)?.seq).toBe(1)
    const timed = bus.wait('d2', 5, 20)
    bus.publish('d2', { seq: 3, type: 'x', ts: 1, actor: 'a', guest: false, payload: {} })
    expect(await timed).toBeUndefined()
    const listener = vi.fn()
    bus.on('d3', listener)
    bus.publish('d3', { seq: 1, type: 'y', ts: 1, actor: 'a', guest: false, payload: {} })
    expect(listener).toHaveBeenCalled()
    bus.off('d3', listener)
    bus.publish('d3', { seq: 2, type: 'y', ts: 1, actor: 'a', guest: false, payload: {} })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rate limiter blocks and sweeps', async () => {
    const limiter = new RateLimiter(2, 1)
    limiter.allow('k')
    const blocked = limiter.allow('k')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 10))
    limiter.sweep()
    expect(limiter.allow('k').allowed).toBe(true)
  })
})

describe('service coverage', () => {
  it('enqueues and drains webhooks with retry, skipping excluded actors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-svc-'))
    const db = openDb(join(dir, 'x.db'))
    const services = new AppServices(db, new EventBus(), loadConfig({ dataDir: dir }), {
      setTyping: () => undefined,
      getTyping: () => [],
      broadcast: () => undefined,
    })
    db.prepare(
      'INSERT INTO docs (id, title, kind, content, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('doc1', 't', 'live', '', 1, 1)
    db.prepare(
      'INSERT INTO hooks (id, doc_id, url, secret, events, exclude_actor, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(
      'h1',
      'doc1',
      'http://127.0.0.1:1/nope',
      'whsec_test',
      JSON.stringify(['chat.message']),
      'me',
      1,
    )
    services.emit('doc1', 'chat.message', 'other', false, { text: 'x' })
    services.emit('doc1', 'chat.message', 'me', false, { text: 'self' })
    services.emit('doc1', 'status.changed', 'other', false, {})
    const rows = db.prepare('SELECT * FROM outbox').all() as { event_type: string }[]
    expect(rows.length).toBe(1)
    expect(rows[0]!.event_type).toBe('chat.message')
    await services.drainWebhooks()
    const after = db.prepare('SELECT attempts, delivered_at FROM outbox').all() as {
      attempts: number
      delivered_at: number | null
    }[]
    expect(after[0]!.attempts).toBe(1)
    expect(after[0]!.delivered_at).toBeNull()
    expect(
      (db.prepare('SELECT next_attempt_at FROM outbox').get() as { next_attempt_at: number })
        .next_attempt_at,
    ).toBeGreaterThan(Date.now())
    services.notifyOwner('doc1', 'info', 'hello', 'head')
    const log = db.prepare('SELECT * FROM notify_log').all()
    expect(log.length).toBe(1)
    services.setTyping('doc1', 'alice')
    services.setTyping('doc2', 'bob')
    expect(services.getTyping('doc1')).toEqual(['alice'])
    try {
      vi.useFakeTimers()
      services.debouncedEdited('doc1')
      services.debouncedEdited('doc1')
      vi.advanceTimersByTime(4000)
      const edited = db
        .prepare("SELECT * FROM events WHERE doc_id='doc1' AND type='doc.edited'")
        .all()
      expect(edited.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
    db.close()
  })

  it('loads config with env overrides', () => {
    process.env.PORT = '9090'
    process.env.DATA_DIR = '/tmp/x'
    const cfg = loadConfig()
    expect(cfg.port).toBe(9090)
    expect(cfg.dataDir).toBe('/tmp/x')
    delete process.env.PORT
    delete process.env.DATA_DIR
  })

  it('writes asset files for the content-addressed store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-assets-'))
    const db = openDb(join(dir, 'x.db'))
    const services = new AppServices(db, new EventBus(), loadConfig({ dataDir: dir }), {
      setTyping: () => undefined,
      getTyping: () => [],
      broadcast: () => undefined,
    })
    db.prepare(
      'INSERT INTO docs (id, title, kind, content, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ).run('doc1', 't', 'live', '', 1, 1)
    services.db
      .prepare(
        'INSERT INTO assets (sha256, kind, mime, name, size, created_at) VALUES (?,?,?,?,?,?)',
      )
      .run('abc', 'code', 'text/plain', 'x.txt', 3, 1)
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'assets', 'abc'), 'xyz')
    const row = db.prepare('SELECT * FROM assets WHERE sha256=?').get('abc') as {
      name: string | null
    }
    expect(row.name).toBe('x.txt')
    db.close()
  })
})
