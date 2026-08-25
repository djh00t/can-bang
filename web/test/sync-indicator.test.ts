import assert from 'node:assert/strict'
import test from 'node:test'
import { renderProjectSyncIndicator } from '../src/workspace.js'

test('renders configured GitHub sync status in the project header', () => {
  const html = renderProjectSyncIndicator({
    enabled: true,
    repo: 'djh00t/can-bang',
    syncEnabled: false,
  })

  assert.match(html, /aria-label="GitHub sync status"/)
  assert.match(html, /sp-pending">Configured/)
  assert.match(html, /GitHub · djh00t\/can-bang/)
})

test('renders synced state and escapes the configured repository', () => {
  const html = renderProjectSyncIndicator({
    enabled: true,
    repo: 'owner/<repo>',
    syncEnabled: true,
  })

  assert.match(html, /sp-pass">Synced/)
  assert.match(html, /owner\/&lt;repo&gt;/)
  assert.doesNotMatch(html, /owner\/<repo>/)
})

test('omits the indicator when GitHub sync is not configured', () => {
  assert.equal(renderProjectSyncIndicator({ enabled: false, repo: null, syncEnabled: false }), '')
})
