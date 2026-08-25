import assert from 'node:assert/strict'
import test from 'node:test'
import { Api } from '../src/api.js'

test('writeDoc forwards If-Match and preserves a stale-write response', async () => {
  const originalFetch = globalThis.fetch
  const calls: RequestInit[] = []
  globalThis.fetch = async (_input, init) => {
    calls.push(init ?? {})
    const ifMatch = new Headers(init?.headers).get('if-match')
    if (ifMatch === 'stale-version') {
      return new Response(
        JSON.stringify({ error: 'version conflict', currentVersion: 'current-version' }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(JSON.stringify({ version: 'next-version' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  try {
    const api = new Api('https://example.test')
    await assert.rejects(
      api.writeDoc('doc-1', 'share-key', '# stale', 'stale-version'),
      (error: unknown) => {
        const err = error as { status?: number; body?: { currentVersion?: string } }
        return err.status === 409 && err.body?.currentVersion === 'current-version'
      },
    )
    const version = await api.writeDoc('doc-1', 'share-key', '# current', 'current-version')

    assert.equal(version, 'next-version')
    assert.equal(calls.length, 2)
    assert.equal(new Headers(calls[0]!.headers).get('if-match'), 'stale-version')
    assert.equal(new Headers(calls[1]!.headers).get('if-match'), 'current-version')
    assert.equal(new Headers(calls[1]!.headers).get('x-share-key'), 'share-key')
  } finally {
    globalThis.fetch = originalFetch
  }
})
