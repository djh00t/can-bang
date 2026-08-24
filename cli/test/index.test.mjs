import assert from 'node:assert/strict'
import { test } from 'node:test'

const { daemonServicePath, formatActivity, formatAgentFreshness } = await import('../dist/index.js')

test('activity formatting includes ISO timestamps, actors, and payloads', () => {
  const output = formatActivity([
    { seq: 4, type: 'chat.message', ts: 0, actor: 'builder', payload: { text: 'hello' } },
  ])

  assert.match(output, /1970-01-01T00:00:00\.000Z chat\.message @builder/)
  assert.match(output, /"text":"hello"/)
})

test('activity JSON mode returns the event array', () => {
  const event = { seq: 1, type: 'doc.edited', ts: 5, actor: 'tester', payload: {} }

  assert.deepEqual(JSON.parse(formatActivity([event], true)), [event])
})

test('chief formatting flags stale agents and preserves freshness context', () => {
  const output = formatAgentFreshness([
    { name: 'live-one', role: 'agent', freshness: 'live', currentDoc: 'doc-a', currentTask: null },
    {
      name: 'stalled',
      role: 'agent',
      freshness: 'stale',
      currentDoc: null,
      currentTask: 'blocked',
    },
  ])

  assert.match(output, /AGENT @live-one freshness=live/)
  assert.match(output, /STALE @stalled freshness=stale/)
  assert.match(output, /task=blocked/)
})

test('daemon service paths are deterministic per platform and document', () => {
  assert.equal(
    daemonServicePath('doc-1', 'darwin', '/tmp/mde'),
    '/tmp/mde/Library/LaunchAgents/mde-watch-doc-1.plist',
  )
  assert.equal(
    daemonServicePath('doc-1', 'linux', '/tmp/mde'),
    '/tmp/mde/.config/systemd/user/mde-watch-doc-1.service',
  )
})
