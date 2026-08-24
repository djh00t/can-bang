import { describe, expect, it } from 'vitest'
import {
  appendFenceLine,
  findFence,
  findFences,
  hasComponents,
  parseBoard,
  parseChat,
  replaceFenceBody,
  statusState,
} from '../src/markdown.js'
import { contentVersion } from '../src/ids.js'

const DOC = `# HQ

\`\`\`board #tickets
## Todo
- [ ] Ship the API @builder #p1 !2026-07-20
  priority: high
\`\`\`

\`\`\`status
state: awaiting-human
- 2026-07-08T14:02Z scaffolded the parser
\`\`\`

\`\`\`chat #general
- 2026-07-04T14:02Z @jake: standup?
\`\`\`
`

describe('markdown model', () => {
  it('finds component fences with ids', () => {
    const fences = findFences(DOC)
    expect(fences.map((f) => f.kind)).toEqual(['board', 'status', 'chat'])
    expect(fences[0]!.id).toBe('tickets')
    expect(hasComponents(DOC)).toBe(true)
    expect(hasComponents('# plain')).toBe(false)
  })

  it('parses boards with cards, assignees, tags, dates, and fields', () => {
    const fence = findFence(DOC, 'board', 'tickets')!
    const board = parseBoard(fence.body)
    expect(board.columns).toContain('Todo')
    const card = board.cards[0]!
    expect(card.state).toBe('todo')
    expect(card.assignees).toContain('builder')
    expect(card.tags).toContain('p1')
    expect(card.due).toBe('2026-07-20')
    expect(card.fields.priority).toBe('high')
  })

  it('joins indented continuation lines into multiline card fields', () => {
    const fence = findFence(
      `# Board

\`\`\`board #tickets
## Todo
- [ ] Spec it
  task: T1
  phase: MVP
  acceptance: Given the API key is set
    the sync posts exactly one PR per card
    and never self-merges
  context: Claimed after the previous card context is closed
  priority: high
## Doing
\`\`\`
`,
      'board',
      'tickets',
    )!
    const card = parseBoard(fence.body).cards[0]!
    expect(card.fields.acceptance).toBe(
      'Given the API key is set\nthe sync posts exactly one PR per card\nand never self-merges',
    )
    expect(card.fields.context).toBe('Claimed after the previous card context is closed')
    expect(card.fields.priority).toBe('high')
  })

  it('parses chat lines and appends new ones', () => {
    const fence = findFence(DOC, 'chat', 'general')!
    const lines = parseChat(fence.body)
    expect(lines[0]!.name).toBe('jake')
    const updated = appendFenceLine(DOC, fence, '- 2026-07-04T15:00Z @claude (agent): on it')
    expect(updated).toContain('@claude (agent): on it')
    const updatedFence = findFence(updated, 'chat', 'general')!
    expect(parseChat(updatedFence.body).some((line) => line.name === 'claude')).toBe(true)
  })

  it('reads status state and replaces fence bodies', () => {
    expect(statusState(DOC)).toBe('awaiting-human')
    const fence = findFence(DOC, 'status')!
    const updated = replaceFenceBody(DOC, fence, 'state: done\n')
    expect(statusState(updated)).toBe('done')
  })

  it('content versions differ for different content', () => {
    expect(contentVersion('a')).not.toBe(contentVersion('b'))
    expect(contentVersion('a')).toBe(contentVersion('a'))
  })
})
