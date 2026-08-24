import assert from 'node:assert/strict'
import test from 'node:test'
import { agentPresenceStatus, renderAgentPresence, type WorkspaceAgent } from '../src/workspace.js'

const agent = (
  name: string,
  freshness: WorkspaceAgent['freshness'],
  currentTask: string | null = null,
): WorkspaceAgent => ({
  id: name,
  name,
  harness: null,
  machine: null,
  role: 'agent',
  currentDoc: null,
  currentTask,
  freshness,
})

test('derives online, offline, working, and blocked agent presence', () => {
  assert.equal(agentPresenceStatus(agent('online', 'live'), []), 'online')
  assert.equal(agentPresenceStatus(agent('offline', 'stale'), []), 'offline')
  assert.equal(agentPresenceStatus(agent('working', 'live', 'task-1'), []), 'working')
  assert.equal(
    agentPresenceStatus(agent('blocked', 'live', 'task-2'), [
      { id: 'task-2', blockers: 'Needs review' },
    ]),
    'blocked',
  )
})

test('renders the AGENTS presence list with escaped names and task labels', () => {
  const html = renderAgentPresence(
    [
      agent('<chief>', 'live'),
      agent('working', 'live', 'task-1'),
      agent('blocked', 'live', 'task-2'),
    ],
    [
      { id: 'task-1', title: 'Ship UI', blockers: null },
      { id: 'task-2', title: 'Needs human', blockers: 'Decision required' },
    ],
  )

  assert.match(html, /&lt;chief&gt;/)
  assert.match(html, />online</)
  assert.match(html, />working</)
  assert.match(html, />blocked</)
  assert.match(html, /Ship UI/)
  assert.match(html, /Needs human/)
})
