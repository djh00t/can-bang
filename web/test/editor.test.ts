import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderEditorActions } from '../src/editor.js'

test('publish actions are read-only even for an editor role', () => {
  const html = renderEditorActions(true, 'owner', true, true)

  assert.match(html, /wb-role-badge[^>]*>view</)
  assert.doesNotMatch(html, /edit-btn|share-btn|claim-btn|Edit|Share|Claim/)
})

test('editable actions preserve the role controls', () => {
  const html = renderEditorActions(false, 'owner', false, true)

  assert.match(html, /wb-role-badge[^>]*>owner</)
  assert.match(html, /claim-btn/)
  assert.match(html, /share-btn/)
  assert.match(html, /edit-btn[^>]*>Edit</)
})
