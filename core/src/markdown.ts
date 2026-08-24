export type FenceKind =
  'board' | 'chat' | 'status' | 'sheet' | 'embed' | 'chart' | 'progress' | 'widget' | 'unknown'

export interface Fence {
  kind: FenceKind
  id?: string
  body: string
  start: number
  end: number
  openingLine: string
}

const KNOWN: FenceKind[] = [
  'board',
  'chat',
  'status',
  'sheet',
  'embed',
  'chart',
  'progress',
  'widget',
]

/** Extract all fenced component blocks from markdown. */
export function findFences(md: string): Fence[] {
  const fences: Fence[] = []
  const lines = md.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const m =
      /^```(board|chat|status|sheet|embed|chart|progress|widget)(\s+#([A-Za-z0-9_-]+))?\s*$/.exec(
        line.trim(),
      )
    if (m) {
      const kind = m[1] as FenceKind
      const id = m[3]
      const body: string[] = []
      let j = i + 1
      while (j < lines.length && !/^```\s*$/.test(lines[j]!.trim())) {
        body.push(lines[j]!)
        j++
      }
      const end = Math.min(j, lines.length - 1)
      fences.push({
        kind,
        id,
        body: body.join('\n'),
        start: i,
        end,
        openingLine: line,
      })
      i = j + 1
    } else {
      i++
    }
  }
  return fences
}

/** True when the markdown contains any known component fence. */
export function hasComponents(md: string): boolean {
  return findFences(md).length > 0
}

/** First status fence's state line, if any. */
export function statusState(md: string): string | null {
  const fence = findFences(md).find((f) => f.kind === 'status')
  if (!fence) return null
  const m = /^state:\s*(building|blocked|awaiting-human|done)\s*$/m.exec(fence.body)
  return m ? m[1]! : null
}

export interface BoardCard {
  column: string
  state: 'todo' | 'doing' | 'done'
  text: string
  assignees: string[]
  tags: string[]
  due?: string
  fields: Record<string, string>
  line: number
}

/** Parse a board fence into columns and cards. */
export function parseBoard(body: string): { columns: string[]; cards: BoardCard[] } {
  const columns: string[] = []
  const cards: BoardCard[] = []
  let column = ''
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const col = /^##\s+(.+)$/.exec(line.trim())
    if (col) {
      column = col[1]!.trim()
      columns.push(column)
      continue
    }
    const card = /^-\s+\[([ >xX])\]\s+(.+)$/.exec(line.trim())
    if (card && column) {
      const text = card[2]!.trim()
      const state = card[1] === 'x' || card[1] === 'X' ? 'done' : card[1] === '>' ? 'doing' : 'todo'
      const assignees = [...text.matchAll(/@([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)
      const tags = [...text.matchAll(/#([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)
      const due = /!(\d{4}-\d{2}-\d{2})/.exec(text)?.[1]
      const fields: Record<string, string> = {}
      let j = i + 1
      while (j < lines.length && /^\s+/.test(lines[j]!) && !/^-\s+\[/.test(lines[j]!.trim())) {
        const kv = /^\s*([A-Za-z0-9 _-]+?):\s*(.+)$/.exec(lines[j]!)
        if (kv) fields[kv[1]!.trim()] = kv[2]!.trim()
        j++
      }
      cards.push({ column, state, text, assignees, tags, due, fields, line: i })
    }
  }
  return { columns, cards }
}

export interface ChatLine {
  ts: string
  name: string
  text: string
  kind?: string
}

/** Parse a chat fence into lines. */
export function parseChat(body: string): ChatLine[] {
  const out: ChatLine[] = []
  for (const line of body.split('\n')) {
    const m = /^-\s+([0-9TZ:.\-+]+)\s+@([A-Za-z0-9_-]+)(?:\s+\(([a-z]+)\))?:\s*(.*)$/.exec(
      line.trim(),
    )
    if (m) {
      out.push({ ts: m[1]!, name: m[2]!, kind: m[3], text: m[4]! })
    }
  }
  return out
}

/** Append one line to a fence body. */
export function appendFenceLine(md: string, fence: Fence, line: string): string {
  const lines = md.split('\n')
  const insertAt = fence.end + 1
  lines.splice(insertAt, 0, line)
  return lines.join('\n')
}

/** Replace the body of one fence, preserving the opening line. */
export function replaceFenceBody(md: string, fence: Fence, body: string): string {
  const lines = md.split('\n')
  const endLine = Math.min(fence.end, lines.length - 1)
  lines.splice(fence.start + 1, endLine - fence.start - 1, ...body.split('\n'))
  return lines.join('\n')
}

/** Find a fence by id (falling back to kind when unique). */
export function findFence(md: string, kind: FenceKind, id?: string): Fence | undefined {
  const fences = findFences(md)
  if (id) return fences.find((f) => f.id === id)
  const ofKind = fences.filter((f) => f.kind === kind)
  return ofKind.length === 1 ? ofKind[0] : undefined
}

/** True when doc contains a component that renders interactively (live). */
export function isLiveDoc(kind: string | null | undefined, md: string): boolean {
  return kind === 'live' || (kind !== 'plain' && hasComponents(md))
}
