import assert from 'node:assert/strict'
import test from 'node:test'
import { renderAgentPromptModal, renderProjectSettingsPanel } from '../src/workspace.js'

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

test('renders escaped project settings with GitHub and one-time key controls', () => {
  const html = renderProjectSettingsPanel({
    id: 'project-1',
    name: '<Project>',
    description: 'A useful project',
    docId: 'doc/1',
    docTitle: 'HQ',
    github: { enabled: false, repo: null, syncEnabled: false },
  })

  assert.match(html, /Project settings/)
  assert.match(html, /value="&lt;Project&gt;"/)
  assert.match(html, /A useful project/)
  assert.match(html, /href="\/d\/doc%2F1"/)
  assert.match(html, /GitHub Issues sync/)
  assert.match(html, /id="enable-github"/)
  assert.match(html, /id="mint-project-key"/)
  assert.match(html, /secret is shown once/)
  assert.doesNotMatch(html, /<Project>/)
})
