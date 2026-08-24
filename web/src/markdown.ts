export interface Fence {
  kind: string
  id?: string
  body: string
  start: number
  end: number
}

export function findFences(md: string): Fence[] {
  const out: Fence[] = []
  const re =
    /^```(board|chat|status|sheet|embed|chart|progress|widget)(\s+#([A-Za-z0-9_-]+))?\s*$/gm
  let m: RegExpExecArray | null
  const lines = md.split('\n')
  while ((m = re.exec(md))) {
    const startLine = md.slice(0, m.index).split('\n').length - 1
    let j = startLine + 1
    const body: string[] = []
    while (j < lines.length && !/^```\s*$/.test(lines[j]!.trim())) {
      body.push(lines[j]!)
      j++
    }
    out.push({
      kind: m[1]!,
      id: m[3],
      body: body.join('\n'),
      start: startLine,
      end: Math.min(j, lines.length - 1),
    })
  }
  return out
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const INLINE =
  /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|!\[([^\]]*)\]\(([^)]+)\))/g

export function renderInline(s: string): string {
  return escapeHtml(s).replace(
    INLINE,
    (whole, bold, boldText, ital, code, linkText, linkUrl, imgAlt, imgUrl) => {
      if (bold) return `<strong>${escapeHtml(boldText)}</strong>`
      if (ital) return `<em>${escapeHtml(ital)}</em>`
      if (code) return `<code>${escapeHtml(code)}</code>`
      if (imgUrl)
        return `<img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(imgAlt ?? '')}" loading="lazy" />`
      if (linkUrl)
        return `<a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener">${escapeHtml(linkText)}</a>`
      return whole
    },
  )
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const fences = findFences(md)
  const fenceAt = new Map<number, Fence>()
  for (const f of fences) fenceAt.set(f.start, f)
  let html = ''
  let list: string[] = []
  let inTable = false
  let tableRows: string[] = []
  let inCode = false
  let codeBuf: string[] = []
  const flushList = () => {
    if (list.length) {
      html += `<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`
      list = []
    }
  }
  const flushTable = () => {
    if (inTable) {
      const header = tableRows[0]!
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      const body = tableRows
        .slice(2)
        .filter((r) => r.trim())
        .map((r) =>
          r
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean),
        )
      html += `<table><thead><tr>${header.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
      inTable = false
      tableRows = []
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = fenceAt.get(i)
    if (fence) {
      flushList()
      flushTable()
      html += `<div class="component" data-fence="${fence.kind}" data-start="${fence.start}" data-end="${fence.end}" data-id="${fence.id ?? ''}">${escapeHtml(
        fence.body,
      )}</div>`
      i = fence.end
      continue
    }
    const trimmed = line.trim()
    if (/^```/.test(trimmed)) {
      flushList()
      flushTable()
      if (!inCode) {
        inCode = true
        codeBuf = []
      } else {
        html += `<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`
        inCode = false
      }
      continue
    }
    if (inCode) {
      codeBuf.push(line)
      continue
    }
    if (/^\|/.test(trimmed)) {
      flushList()
      if (!inTable) inTable = true
      tableRows.push(trimmed)
      continue
    }
    flushTable()
    if (/^#{1,6}\s/.test(trimmed)) {
      flushList()
      const level = trimmed.match(/^#{1,6}/)![0].length
      html += `<h${level}>${renderInline(trimmed.replace(/^#{1,6}\s*/, ''))}</h${level}>`
      continue
    }
    if (/^-\s/.test(trimmed) || /^\*\s/.test(trimmed)) {
      list.push(renderInline(trimmed.replace(/^[-*]\s+/, '')))
      continue
    }
    flushList()
    if (/^---+\s*$/.test(trimmed)) {
      html += '<hr />'
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      html += `<blockquote>${renderInline(trimmed.replace(/^>\s?/, ''))}</blockquote>`
      continue
    }
    if (trimmed === '') {
      html += '<p></p>'
      continue
    }
    html += `<p>${renderInline(line)}</p>`
  }
  flushList()
  flushTable()
  return html
}

export function parseBoard(body: string): { columns: { name: string; cards: BoardCard[] }[] } {
  const columns: { name: string; cards: BoardCard[] }[] = []
  let current: { name: string; cards: BoardCard[] } | null = null
  for (const line of body.split('\n')) {
    const col = /^##\s+(.+)$/.exec(line.trim())
    if (col) {
      current = { name: col[1]!.trim(), cards: [] }
      columns.push(current)
      continue
    }
    const card = /^-\s+\[([ >xX])\]\s+(.+)$/.exec(line.trim())
    if (card && current) {
      current.cards.push({
        state: card[1] === 'x' || card[1] === 'X' ? 'done' : card[1] === '>' ? 'doing' : 'todo',
        text: card[2]!.trim(),
      })
    }
  }
  return { columns }
}

export interface BoardCard {
  state: 'todo' | 'doing' | 'done'
  text: string
}

export function parseChat(
  body: string,
): { ts: string; name: string; text: string; kind?: string }[] {
  const out: { ts: string; name: string; text: string; kind?: string }[] = []
  for (const line of body.split('\n')) {
    const m = /^-\s+([0-9TZ:.\-+]+)\s+@([A-Za-z0-9_-]+)(?:\s+\(([a-z]+)\))?:\s*(.*)$/.exec(
      line.trim(),
    )
    if (m) out.push({ ts: m[1]!, name: m[2]!, kind: m[3], text: m[4]! })
  }
  return out
}

export function statusParts(body: string): {
  state: string | null
  lines: string[]
  checklist: string[]
} {
  const state = /^state:\s*(building|blocked|awaiting-human|done)\s*$/m.exec(body)?.[1] ?? null
  const lines = body
    .split('\n')
    .filter((l) => /^-\s/.test(l.trim()))
    .map((l) => l.trim())
  const checklist = body
    .split('\n')
    .filter((l) => /^\s*- \[[ xX>]\]/.test(l))
    .map((l) => l.trim())
  return { state, lines, checklist }
}

export function widgetIframeHtml(title: string, state: unknown, html: string): string {
  const stateJson = JSON.stringify(state ?? {})
  return `<div class="widget-frame"><iframe sandbox="allow-scripts" title="${escapeHtml(title)}" srcdoc="${escapeHtml(
    `<script>window.margin={state:${stateJson},setState:function(s){window.parent.postMessage({type:'margin-state',state:s},'*')},onChange:function(){}}</script>${html}`,
  )}"></iframe></div>`
}
