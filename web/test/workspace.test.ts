import assert from 'node:assert/strict'
import test from 'node:test'
import { parseWorkspaceRoute, renderAgentPromptModal, workspacePathFor } from '../src/workspace.js'

test('renders the onboarding modal with escaped prompt and agent link', () => {
  const html = renderAgentPromptModal(
    'https://example.test/d/project?key=secret',
    'Read <this-doc> and follow the briefing.',
    'Read /agents.md, then work the doc.',
  )

  assert.match(html, /Onboarding modal|One-line kickoff/)
  assert.match(html, /https:\/\/example\.test\/d\/project\?key=secret\.md/)
  assert.match(html, /id="agent-kickoff">Read \/agents\.md, then work the doc\./)
  assert.match(html, /id="agent-prompt">Read &lt;this-doc&gt;/)
  assert.match(html, /id="copy-agent-kickoff">Copy kickoff/)
  assert.match(html, /id="copy-agent-prompt">Copy briefing/)
  assert.doesNotMatch(html, /<this-doc>/)
})

test('round-trips every hierarchy URL through the route contract', () => {
  const paths = [
    '/p/project-1',
    '/p/project-1/pipeline',
    '/p/project-1/matrix',
    '/p/project-1/phase/phase-1',
    '/p/project-1/phase/phase-1/task/task-1',
    '/p/project-1/release/release-1',
  ]

  for (const path of paths) {
    assert.equal(workspacePathFor(parseWorkspaceRoute(path)), path)
  }
})

test('restores hierarchy ancestors from a task URL', () => {
  const route = parseWorkspaceRoute('/p/project-1/phase/phase-1/task/task-1')

  assert.deepEqual(route, {
    projectId: 'project-1',
    phaseId: 'phase-1',
    view: 'pipeline',
    releaseId: null,
    taskId: 'task-1',
    detail: 'project',
  })
})
