import assert from 'node:assert/strict'
import test from 'node:test'
import { renderSettings } from '../src/settings.js'

test('renders agent identity, safe token metadata, and account templates', () => {
  const html = renderSettings({
    user: { username: 'owner', agent_name: 'Build <bot>' },
    tokens: [{ id: 'abc1234567', label: 'CI token' }],
    templates: [
      {
        slug: 'project-tracker',
        title: 'Project tracker',
        description: 'Track work',
        category: 'product',
        builtin: true,
      },
    ],
  })

  assert.match(html, /<h1>Settings<\/h1>/)
  assert.match(html, /owner/)
  assert.match(html, /Build &lt;bot&gt;/)
  assert.match(html, /abc1234567/)
  assert.match(html, /CI token/)
  assert.match(html, /Account templates/)
  assert.match(html, /Project tracker/)
  assert.doesNotMatch(html, /Build <bot>/)
})
