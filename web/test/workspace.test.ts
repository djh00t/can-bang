import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAgentPromptModal, renderProjectTreeLabel } from '../src/workspace.js'

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

test('renders project names as expansion controls instead of navigation controls', () => {
  const html = renderProjectTreeLabel(
    { id: 'project-1', name: 'Project <One>', done: 2, total: 5 },
    false,
    false,
  )

  assert.match(html, /data-project-toggle="project-1"/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /aria-controls="project-children-project-1"/)
  assert.match(html, /Project &lt;One&gt;/)
  assert.doesNotMatch(html, /data-project="project-1"/)
})
