import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAgentPromptModal, renderFeatureMatrix } from '../src/workspace.js'

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

test('renders feature statuses and only links real release columns', () => {
  const html = renderFeatureMatrix({
    project: { id: 'project-1', name: 'CanBang' },
    phases: [
      {
        id: 'phase-1',
        name: 'MVP',
        status: 'done',
        release: { id: 'release-1', name: '0.1', demo_status: 'pass' },
      },
      { id: 'phase-2', name: '0.2', status: 'active', release: null },
    ],
    rows: [
      {
        feature: 'Docs',
        cells: [
          { phaseId: 'phase-1', status: 'shipped' },
          { phaseId: 'phase-2', status: 'in-progress' },
        ],
      },
    ],
  })

  assert.match(html, /data-release="release-1"/)
  assert.match(html, /aria-label="Open release 0\.1"/)
  assert.match(html, /data-status="shipped"/)
  assert.match(html, /in progress/)
  assert.match(html, /No release/)
  assert.doesNotMatch(html, /data-release=""/)
})
