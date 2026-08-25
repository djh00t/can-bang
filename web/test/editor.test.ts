import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderEditorActions, renderRemoteCursorChips } from '../src/editor.js'

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

test('remote cursors keep same-name connections distinct', () => {
  const html = renderRemoteCursorChips(
    new Map([
      ['ws-1', { name: 'Guest', cursor: { start: 2, end: 2 } }],
      ['ws-2', { name: 'Guest', cursor: { start: 9, end: 10 } }],
    ]),
  )

  assert.equal((html.match(/wb-cursor-chip/g) ?? []).length, 2)
  assert.match(html, /@Guest at 2/)
  assert.match(html, /@Guest at 9/)
})
