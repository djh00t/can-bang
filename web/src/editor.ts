import { Api } from './api.js'
import {
  escapeHtml,
  findFences,
  parseBoard,
  parseChat,
  renderMarkdown,
  statusParts,
  widgetIframeHtml,
} from './markdown.js'

interface ActionCtx {
  docId: string
  key: string
  api: Api
  reload: () => Promise<void>
  getContent: () => string
  save: (content: string, label?: string) => Promise<void>
  role: string
}

export async function mountEditor(
  root: HTMLElement,
  docId: string,
  key: string,
  readonly: boolean,
): Promise<void> {
  const api = new Api()
  let content = ''
  let version = ''
  let role = 'view'
  let editing = false
  let unclaimed = false
  let title = ''
  let me = await api.me()
  type Cursor = { start: number; end: number }
  const remoteCursors = new Map<string, Cursor>()
  let socket: WebSocket | null = null
  const storedAuthor = localStorage.getItem('wb.author') ?? ''
  const author =
    me?.user.agent_name ??
    me?.user.username ??
    storedAuthor ??
    prompt('Author name (for guest attribution):') ??
    'Guest'
  if (!me && author && author !== 'Guest') localStorage.setItem('wb.author', author)

  const canWrite = () => !readonly && (role === 'edit' || role === 'owner')
  const canComment = () => !readonly && role !== 'view'

  const sendCursor = () => {
    if (readonly || !socket || socket.readyState !== WebSocket.OPEN) return
    const source = document.getElementById('source') as HTMLTextAreaElement | null
    if (!source) return
    socket.send(
      JSON.stringify({
        type: 'cursor',
        cursor: { start: source.selectionStart, end: source.selectionEnd },
      }),
    )
  }

  const renderRemoteCursors = () => {
    const target = document.getElementById('remote-cursors')
    if (!target) return
    target.innerHTML = [...remoteCursors.entries()]
      .map(
        ([name, cursor]) =>
          `<span class="wb-cursor-chip"><span class="wb-cursor-mark" aria-hidden="true"></span>@${escapeHtml(name)} at ${cursor.start}</span>`,
      )
      .join('')
  }

  const reload = async () => {
    const [doc, meta] = await Promise.all([api.readDoc(docId, key), api.meta(docId, key)])
    content = doc.content
    version = doc.version
    role = meta.role
    unclaimed = Boolean(meta.unclaimed)
    title = meta.title
    render()
  }

  const save = async (newContent: string, label?: string) => {
    try {
      version = await api.writeDoc(docId, key, newContent, version, label)
      content = newContent
      editing = false
      render()
    } catch (err) {
      const e = err as { status?: number; body?: { currentVersion?: string; error?: string } }
      if (e.status === 409) {
        const latest = await api.readDoc(docId, key)
        const choice = confirm(
          `Document changed by someone else. Overwrite their changes with yours?\n\nOK = overwrite (you keep your text)\nCancel = re-read and reload`,
        )
        if (choice) {
          version = latest.version
          version = await api.writeDoc(docId, key, newContent, version, label)
          content = newContent
          render()
        } else {
          content = latest.content
          version = latest.version
          render()
        }
      } else {
        alert(`Save failed: ${e.body?.error ?? e.status ?? 'unknown error'}`)
      }
    }
  }

  const ctx: ActionCtx = { docId, key, api, reload, getContent: () => content, save, role }

  const render = () => {
    const meta = ctx
    root.innerHTML = `
      <div class="wb-shell">
        <header class="wb-topbar">
          <div class="wb-top-left">
            <div class="wb-brand"><img src="/logo.svg" alt="" class="brand-logo" /> CanBang</div>
            <div class="wb-doc-title">${escapeHtml(title)}</div>
          </div>
          <div class="wb-top-actions">
            <span class="live-dot" id="live-dot" title="realtime connection"></span>
            ${renderEditorActions(readonly, role, editing, Boolean(unclaimed && me))}
            <a class="btn-link" href="/">Dashboard</a>
          </div>
        </header>
        <div class="wb-layout">
          ${unclaimed && me ? '<div class="wb-banner">This document belongs to no account. Claim it to protect it and see it in your dashboard.</div>' : ''}
          <main class="wb-main">
            ${!readonly && editing ? renderEditor() : renderPreview()}
          </main>
          <aside class="wb-side">
            ${canComment() ? renderChatPanel() : ''}
            ${renderStatusPanel()}
            ${renderCommentsPanel()}
            ${renderSuggestionsPanel()}
            ${renderHistoryPanel()}
            ${renderAsksPanel()}
          </aside>
        </div>
        <footer class="wb-presence">
          <span id="presence">watching…</span>
          <span class="wb-remote-cursors" id="remote-cursors" aria-live="polite"></span>
        </footer>
      </div>`
    bootstrapComponents()
    wire()
    renderRemoteCursors()
  }

  const renderEditor = () => `
    <div class="wb-editor">
      <textarea id="source" spellcheck="false">${escapeHtml(content)}</textarea>
      <div class="wb-editor-actions">
        <button class="btn primary" id="save-btn">Save</button>
        <span class="muted" id="save-hint">Version ${escapeHtml(version.slice(0, 8))}</span>
      </div>
    </div>`

  const renderPreview = () => `<article class="wb-doc">${renderMarkdown(content)}</article>`

  const renderChatPanel = () => {
    const fences = findFences(content).filter((f) => f.kind === 'chat')
    if (!fences.length) return ''
    const fence = fences[0]!
    const messages = parseChat(fence.body)
    return `
      <section class="panel">
        <h3>Chat${fence.id ? ` <span class="fence-id">#${escapeHtml(fence.id)}</span>` : ''}</h3>
        <div class="chat-list">${messages
          .map(
            (m) =>
              `<div class="chat-line"><span class="chat-name">@${escapeHtml(m.name)}${m.kind ? ` <em>(${escapeHtml(m.kind)})</em>` : ''}</span><span class="chat-text">${renderInlineSafe(
                m.text,
              )}</span><time>${escapeHtml(m.ts.slice(11, 19))}</time></div>`,
          )
          .join('')}</div>
        <div class="chat-compose">
          <input id="chat-input" placeholder="Message…" />
          <button class="btn primary" id="chat-send">Send</button>
        </div>
      </section>`
  }

  const renderStatusPanel = () => {
    const fence = findFences(content).find((f) => f.kind === 'status')
    if (!fence) return ''
    const { state, lines, checklist } = statusParts(fence.body)
    return `
      <section class="panel">
        <h3>Status</h3>
        <div class="status-badge ${state ?? ''}">${escapeHtml(state ?? 'none')}</div>
        <ul class="status-lines">${lines.map((l) => `<li>${renderInlineSafe(l)}</li>`).join('')}</ul>
        ${checklist.length ? `<ul class="checklist">${checklist.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
        ${canWrite() ? renderStatusButtons() : ''}
      </section>`
  }

  const renderStatusButtons = () => `
    <div class="status-actions">
      ${['building', 'blocked', 'awaiting-human', 'done']
        .map((s) => `<button class="btn sm" data-status="${s}">${s}</button>`)
        .join('')}
    </div>`

  const renderCommentsPanel = () => `
    <section class="panel">
      <h3>Comments</h3>
      <div id="comments-list"><span class="muted">loading…</span></div>
      ${canComment() ? `<div class="comment-compose"><input id="comment-body" placeholder="Add a comment…" /><button class="btn sm primary" id="comment-add">Add</button></div>` : ''}
    </section>`

  const renderSuggestionsPanel = () => `
    <section class="panel">
      <h3>Suggestions</h3>
      <div id="suggestions-list"><span class="muted">loading…</span></div>
    </section>`

  const renderHistoryPanel = () => `
    <section class="panel">
      <h3>History</h3>
      <div id="history-list"><span class="muted">loading…</span></div>
    </section>`

  const renderAsksPanel = () => `
    <section class="panel">
      <h3>Asks</h3>
      <div id="asks-list"><span class="muted">loading…</span></div>
      ${canComment() ? `<div class="ask-compose"><input id="ask-body" placeholder="Ask the team…" /><button class="btn sm primary" id="ask-add">Ask</button></div>` : ''}
    </section>`

  const wire = () => {
    const editBtn = document.getElementById('edit-btn')
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        if (readonly) return
        editing = !editing
        render()
        if (editing) {
          const ta = document.getElementById('source') as HTMLTextAreaElement | null
          if (ta) ta.value = content
          document.getElementById('save-btn')?.addEventListener('click', () => {
            void save(
              (document.getElementById('source') as HTMLTextAreaElement).value,
              'editor save',
            )
          })
        }
      })
    }
    const source = document.getElementById('source') as HTMLTextAreaElement | null
    if (source) {
      source.addEventListener('select', sendCursor)
      source.addEventListener('keyup', sendCursor)
      source.addEventListener('click', sendCursor)
      source.addEventListener('input', sendCursor)
      sendCursor()
    }
    document.getElementById('share-btn')?.addEventListener('click', () => void share())
    document.getElementById('claim-btn')?.addEventListener('click', () => void claim())
    document.getElementById('chat-send')?.addEventListener('click', () => void sendChat())
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void sendChat()
    })
    document.querySelectorAll<HTMLButtonElement>('[data-status]').forEach((b) => {
      b.addEventListener('click', () => void setStatus(b.dataset.status!))
    })
    document.getElementById('comment-add')?.addEventListener('click', () => void addComment())
    document.getElementById('ask-add')?.addEventListener('click', () => void addAsk())
    wireBoard()
    wireWidgets()
    wireChatFences()
    void loadPanels()
  }

  const wireBoard = () => {
    document.querySelectorAll<HTMLElement>('.board-card').forEach((card) => {
      card.addEventListener('click', () => {
        if (readonly || (role !== 'edit' && role !== 'owner')) return
        const col = card.dataset.column!
        const text = card.dataset.text!
        const state = card.dataset.state!
        const next = state === 'todo' ? 'doing' : state === 'doing' ? 'done' : 'todo'
        const nextMarker = next === 'doing' ? '[>]' : next === 'done' ? '[x]' : '[ ]'
        const lines = content.split('\n')
        let inCol = false
        for (let i = 0; i < lines.length; i++) {
          const t = lines[i]!.trim()
          if (t.startsWith('## ')) inCol = t.slice(3).trim() === col
          if (inCol && new RegExp(`^- \\[[ >xX]\\] ${escapeRegExp(text)}$`).test(t)) {
            lines[i] = t.replace(/^- \[[ >xX]\]/, `- ${nextMarker}`)
            break
          }
        }
        void save(lines.join('\n'), `card ${text} → ${next}`)
      })
    })
  }

  const wireWidgets = () => {
    document.querySelectorAll<HTMLIFrameElement>('iframe[data-widget]').forEach((frame) => {
      frame.addEventListener('load', () => {
        try {
          frame.contentWindow?.postMessage({ type: 'margin-ready' }, '*')
        } catch {
          /* ignore */
        }
      })
    })
  }

  const wireChatFences = () => {
    document.querySelectorAll<HTMLElement>('[data-chat-fence]').forEach((el) => {
      el.addEventListener('click', () => {
        if (readonly) return
        const fence = findFences(content).find(
          (f) => f.kind === 'chat' && f.id === el.dataset.chatFence,
        )
        if (fence) {
          const text = prompt(`Message to #${fence.id ?? 'general'}:`) ?? ''
          if (text.trim()) void api.chat(docId, key, text, fence.id, author).then(reload)
        }
      })
    })
  }

  const loadPanels = async () => {
    const [comments, revisions, asks] = await Promise.all([
      api.comments(docId, key),
      api.revisions(docId, key),
      api.asks(docId, key),
    ])
    const cl = document.getElementById('comments-list')
    if (cl) {
      const cs = comments.comments as {
        id: string
        body: string
        author: string
        anchored?: boolean
        resolved?: boolean
        replies: { id: string; body: string; author: string }[]
      }[]
      cl.innerHTML = cs.length
        ? cs
            .map(
              (c) =>
                `<div class="comment ${c.resolved ? 'resolved' : ''}"><div class="comment-head">@${escapeHtml(c.author)}${c.anchored ? ' <span class="tag">anchored</span>' : ''}</div><div>${renderInlineSafe(c.body)}</div>${c.replies
                  .map(
                    (r) =>
                      `<div class="reply">↳ @${escapeHtml(r.author)}: ${renderInlineSafe(r.body)}</div>`,
                  )
                  .join('')}</div>`,
            )
            .join('')
        : '<span class="muted">No comments</span>'
    }
    const sl = document.getElementById('suggestions-list')
    if (sl) {
      const ss = comments.suggestions as {
        id: string
        type: string
        find: string | null
        text: string | null
        status: string
        author: string
      }[]
      sl.innerHTML = ss.length
        ? ss
            .map(
              (s) =>
                `<div class="suggestion ${s.status}"><code>${escapeHtml(s.type)}</code> ${escapeHtml((s.find ?? s.text ?? '').slice(0, 60))} — @${escapeHtml(s.author)}
                 ${s.status === 'pending' && canWrite() ? `<button class="btn sm" data-accept="${s.id}">Accept</button><button class="btn sm" data-reject="${s.id}">Reject</button>` : `<span class="tag">${escapeHtml(s.status)}</span>`}</div>`,
            )
            .join('')
        : '<span class="muted">No suggestions</span>'
      sl.querySelectorAll<HTMLButtonElement>('[data-accept]').forEach((b) => {
        b.addEventListener(
          'click',
          () => void api.suggestionAction(docId, key, b.dataset.accept!, 'accept').then(reload),
        )
      })
      sl.querySelectorAll<HTMLButtonElement>('[data-reject]').forEach((b) => {
        b.addEventListener(
          'click',
          () => void api.suggestionAction(docId, key, b.dataset.reject!, 'reject').then(reload),
        )
      })
    }
    const hl = document.getElementById('history-list')
    if (hl) {
      hl.innerHTML = revisions.revisions.length
        ? revisions.revisions
            .slice(0, 10)
            .map(
              (r) =>
                `<div class="rev"><span>${escapeHtml(r.label ?? 'edit')}</span> <span class="muted">@${escapeHtml(r.author)}</span> ${canWrite() ? `<button class="btn sm" data-restore="${r.id}">restore</button>` : ''}</div>`,
            )
            .join('')
        : '<span class="muted">No versions yet</span>'
      hl.querySelectorAll<HTMLButtonElement>('[data-restore]').forEach((b) => {
        b.addEventListener('click', () => {
          if (
            confirm(
              'Restore this version? Current content will be replaced (a new version is saved).',
            )
          ) {
            void api.restore(docId, key, b.dataset.restore!).then(reload)
          }
        })
      })
    }
    const al = document.getElementById('asks-list')
    if (al) {
      const as = asks.asks as {
        id: string
        text: string
        state: string
        claimedBy: string | null
      }[]
      al.innerHTML = as.length
        ? as
            .map(
              (a) =>
                `<div class="ask"><span class="tag">${escapeHtml(a.state)}</span> ${renderInlineSafe(a.text)}${a.claimedBy ? ` <span class="muted">— @${escapeHtml(a.claimedBy)}</span>` : ''}
                 ${a.state === 'open' && canComment() ? `<button class="btn sm" data-claim="${a.id}">Claim</button>` : ''}
                 ${a.state === 'claimed' && canComment() ? `<button class="btn sm" data-resolve="${a.id}">Resolve</button>` : ''}</div>`,
            )
            .join('')
        : '<span class="muted">No asks</span>'
      al.querySelectorAll<HTMLButtonElement>('[data-claim]').forEach((b) => {
        b.addEventListener(
          'click',
          () => void api.claimAsk(docId, key, b.dataset.claim!, author).then(reload),
        )
      })
      al.querySelectorAll<HTMLButtonElement>('[data-resolve]').forEach((b) => {
        b.addEventListener('click', () => {
          const note = prompt('Resolution note:') ?? undefined
          void api.resolveAsk(docId, key, b.dataset.resolve!, note).then(reload)
        })
      })
    }
  }

  const sendChat = async () => {
    if (!canComment()) return
    const input = document.getElementById('chat-input') as HTMLInputElement | null
    if (!input || !input.value.trim()) return
    const fences = findFences(content).filter((f) => f.kind === 'chat')
    await api.chat(docId, key, input.value, fences[0]?.id, author)
    input.value = ''
    await reload()
  }

  const setStatus = async (state: string) => {
    if (!canWrite()) return
    const note =
      state === 'awaiting-human' ? (prompt('What do you need from the human?') ?? '') : undefined
    await api.setStatus(docId, key, state, note)
    await reload()
  }

  const addComment = async () => {
    if (!canComment()) return
    const input = document.getElementById('comment-body') as HTMLInputElement | null
    if (!input) return
    const text = input.value.trim()
    if (!text) return
    const find = prompt('Optional: anchor to exact text (leave empty for doc-level):') ?? undefined
    await api.addComment(docId, key, text, find || undefined)
    input.value = ''
    await reload()
  }

  const addAsk = async () => {
    if (!canComment()) return
    const input = document.getElementById('ask-body') as HTMLInputElement | null
    if (!input) return
    const text = input.value.trim()
    if (!text) return
    await api.createAsk(docId, key, text)
    input.value = ''
    await reload()
  }

  const share = async () => {
    if (readonly) return
    try {
      const res = await fetch(`/api/docs/${docId}/shares`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-share-key': key },
        body: JSON.stringify({ role: 'view' }),
      })
      const body = (await res.json()) as { share?: { url?: string } }
      if (body.share?.url) {
        navigator.clipboard?.writeText(body.share.url).catch(() => undefined)
        prompt('View link (copied):', body.share.url)
      } else {
        alert('Could not mint a share link.')
      }
    } catch (e) {
      alert(`Share failed: ${(e as Error).message}`)
    }
  }

  const claim = async () => {
    if (readonly) return
    try {
      await api.claimDoc(docId, key)
      await reload()
    } catch (e) {
      alert(`Claim failed: ${(e as Error).message}`)
    }
  }

  // Component bootstrapping: replace placeholder divs with real components
  const bootstrapComponents = () => {
    document.querySelectorAll<HTMLElement>('.component').forEach((el) => {
      const kind = el.dataset.fence!
      const body = el.textContent ?? ''
      const idx = Number(el.dataset.start)
      if (kind === 'board') {
        const board = parseBoard(body)
        el.innerHTML = `<div class="board">${board.columns
          .map((col) => {
            const cards = col.cards
              .map((c) => {
                const assignees = [...c.text.matchAll(/@([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)
                const tags = [...c.text.matchAll(/#([A-Za-z0-9_-]+)/g)].map((m) => m[1]!)
                const clean = c.text
                  .replace(/@[A-Za-z0-9_-]+/g, '')
                  .replace(/#[A-Za-z0-9_-]+/g, '')
                  .replace(/\s+/g, ' ')
                  .trim()
                return `<div class="board-card ${c.state}" data-column="${escapeHtml(col.name)}" data-text="${escapeHtml(c.text)}" data-state="${c.state}">
                  <span class="card-text">${escapeHtml(clean)}</span>
                  <span class="card-meta">${assignees.map((a) => `<span class="chip assignee">@${escapeHtml(a)}</span>`).join('')}${tags
                    .map((t) => `<span class="chip tag">#${escapeHtml(t)}</span>`)
                    .join('')}</span>
                </div>`
              })
              .join('')
            return `<div class="board-col"><h4>${escapeHtml(col.name)} <span class="col-count">${col.cards.length}</span></h4>${cards}</div>`
          })
          .join('')}</div>`
      } else if (kind === 'chat') {
        const messages = parseChat(body)
        el.innerHTML = `<div class="chat-fence" data-chat-fence="${el.dataset.id ?? ''}">${
          messages
            .map(
              (m) =>
                `<div class="chat-line"><span class="avatar" style="--hue:${nameHue(m.name)}">${escapeHtml(m.name.slice(0, 1).toUpperCase())}</span><div class="chat-body"><span class="chat-name">@${escapeHtml(m.name)}</span><span class="chat-text">${renderInlineSafe(m.text)}</span><time>${escapeHtml(m.ts.slice(11, 19))}</time></div></div>`,
            )
            .join('') || '<span class="muted">empty</span>'
        }</div>`
      } else if (kind === 'status') {
        const { state, lines } = statusParts(body)
        el.innerHTML = `<div class="status-card ${state ?? ''}"><span class="status-badge">${escapeHtml(state ?? 'none')}</span><ul>${lines
          .map((l) => `<li>${renderInlineSafe(l)}</li>`)
          .join('')}</ul></div>`
      } else if (kind === 'sheet') {
        el.innerHTML = renderMarkdown(body)
      } else if (kind === 'embed') {
        const target = body.trim()
        const m = /^\/?d\/([A-Za-z0-9_-]+)/.exec(target)
        el.innerHTML = `<div class="embed">loading…</div>`
        if (m) {
          void fetch(`/api/docs/${m[1]}/content`, { headers: { accept: 'text/markdown' } })
            .then((r) => (r.ok ? r.text() : null))
            .then((t) => {
              el.innerHTML =
                t === null
                  ? '<div class="embed muted">no access to embedded doc</div>'
                  : renderMarkdown(t)
            })
        } else {
          el.innerHTML = '<div class="embed muted">invalid embed target</div>'
        }
      } else if (kind === 'chart') {
        el.innerHTML = renderChart(body)
      } else if (kind === 'progress') {
        el.innerHTML = renderProgress(body)
      } else if (kind === 'widget') {
        try {
          const spec = JSON.parse(body) as { title?: string; state?: unknown; html?: string }
          el.innerHTML = widgetIframeHtml(spec.title ?? 'widget', spec.state, spec.html ?? '')
          const frame = el.querySelector('iframe') as HTMLIFrameElement
          frame.dataset.widget = '1'
          const fences = findFences(content)
          const fence = fences.find((f) => f.start === idx)
          frame.dataset.idx = String(fences.indexOf(fence ?? fences[0]!))
        } catch {
          el.innerHTML = '<div class="muted">invalid widget</div>'
        }
      }
    })
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data as { type?: string; state?: unknown }
    if (msg?.type !== 'margin-state' || !ev.source) return
    const frame = [...document.querySelectorAll<HTMLIFrameElement>('iframe[data-widget]')].find(
      (f) => f.contentWindow === ev.source,
    )
    if (!frame) return
    const fences = findFences(content)
    const fence = fences[Number(frame.dataset.idx)]
    if (!fence || fence.kind !== 'widget') return
    try {
      const spec = JSON.parse(fence.body) as { title?: string; state?: unknown; html?: string }
      const lines = content.split('\n')
      lines[fence.start + 1] = JSON.stringify({ ...spec, state: msg.state })
      if (!readonly) void save(lines.join('\n'), 'widget state')
    } catch {
      /* ignore */
    }
  })

  const renderChart = (body: string): string => {
    try {
      const spec = JSON.parse(body) as {
        type?: string
        title?: string
        series?: { name?: string; data?: [string, number][] }[]
      }
      const series = spec.series ?? []
      if (spec.type === 'bar') {
        const rows = series.flatMap((s) =>
          (s.data ?? []).map(([x, y]) => ({ x, y, name: s.name ?? '' })),
        )
        const max = Math.max(1, ...rows.map((r) => r.y))
        return `<div class="chart"><h4>${escapeHtml(spec.title ?? '')}</h4><div class="bars">${rows
          .map(
            (r) =>
              `<div class="bar-col"><div class="bar" style="height:${Math.round((r.y / max) * 120)}px"></div><span>${escapeHtml(String(r.x))}</span><b>${r.y}</b></div>`,
          )
          .join('')}</div></div>`
      }
      const points = series.flatMap((s) => (s.data ?? []).map(([x, y]) => ({ x, y })))
      const max = Math.max(1, ...points.map((p) => p.y))
      const w = 420
      const h = 140
      const coords = points.map((p, i) => {
        const x = points.length > 1 ? (i / (points.length - 1)) * w : w / 2
        return `${x},${h - (p.y / max) * h}`
      })
      return `<div class="chart"><h4>${escapeHtml(spec.title ?? '')}</h4><svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><polyline points="${coords.join(
        ' ',
      )}" fill="none" stroke="#3b5bdb" stroke-width="2"/></svg></div>`
    } catch {
      return '<div class="muted">invalid chart</div>'
    }
  }

  const renderProgress = (body: string): string => {
    try {
      const spec = JSON.parse(body) as { title?: string; done?: string }
      const boards = findFences(content).filter((f) => f.kind === 'board')
      let total = 0
      let done = 0
      for (const b of boards) {
        const parsed = parseBoard(b.body)
        for (const col of parsed.columns) {
          for (const card of col.cards) {
            total++
            if (card.state === 'done') done++
          }
        }
      }
      const pct = total ? Math.round((done / total) * 100) : 0
      return `<div class="progress"><h4>${escapeHtml(spec.title ?? 'Shipping progress')}</h4><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span>${done}/${total} (${pct}%)</span></div>`
    } catch {
      return '<div class="muted">invalid progress</div>'
    }
  }

  await reload()

  // Live events loop + presence via WebSocket
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  try {
    const liveSocket = new WebSocket(
      `${proto}://${location.host}/ws?doc=${encodeURIComponent(docId)}&key=${encodeURIComponent(key)}`,
    )
    socket = liveSocket
    liveSocket.onopen = () => {
      document.getElementById('live-dot')?.classList.add('on')
      sendCursor()
    }
    liveSocket.onclose = () => {
      socket = null
      document.getElementById('live-dot')?.classList.remove('on')
    }
    liveSocket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as {
        type?: string
        name?: string
        names?: string[]
        cursor?: Cursor | null
        event?: { type?: string }
      }
      const presence = document.getElementById('presence')
      const dot = document.getElementById('live-dot')
      if (dot) dot.classList.add('on')
      if (msg.type === 'cursor' && msg.name) {
        const cursor = msg.cursor
        if (
          cursor &&
          Number.isFinite(cursor.start) &&
          Number.isFinite(cursor.end) &&
          cursor.start >= 0 &&
          cursor.end >= 0
        ) {
          remoteCursors.set(msg.name, { start: cursor.start, end: cursor.end })
        } else {
          remoteCursors.delete(msg.name)
        }
        renderRemoteCursors()
      }
      if (presence) {
        if (msg.type === 'typing')
          presence.textContent = msg.names?.length ? `${msg.names.join(', ')} typing…` : 'watching…'
      }
      if (msg.type === 'event' && msg.event?.type) {
        if (
          ['chat.message', 'content.replaced', 'doc.edited', 'status.changed'].includes(
            msg.event.type,
          )
        )
          void reload()
      }
    }
  } catch {
    // fall back to long-poll below
  }

  let since: number | 'latest' = 'latest'
  const poll = async () => {
    try {
      const res = await api.events(docId, key, since, 55)
      if (
        res.events.some((e) =>
          ['chat.message', 'content.replaced', 'doc.edited', 'status.changed'].includes(e.type),
        )
      )
        await reload()
      since = res.latest
    } catch {
      /* transient */
    }
    setTimeout(() => void poll(), 1000)
  }
  void poll()
}

export function renderEditorActions(
  isReadonly: boolean,
  currentRole: string,
  isEditing: boolean,
  showClaim: boolean,
): string {
  if (isReadonly) return '<span class="wb-role-badge">view</span>'
  return `<span class="wb-role-badge">${escapeHtml(currentRole)}</span>
    ${showClaim ? '<button class="btn" id="claim-btn">Claim this doc</button>' : ''}
    ${currentRole === 'edit' || currentRole === 'owner' ? '<button class="btn" id="share-btn">Share</button>' : ''}
    <button class="btn" id="edit-btn">${isEditing ? 'Preview' : 'Edit'}</button>`
}

function renderInlineSafe(s: string): string {
  return renderMarkdown(s).replace(/^<p>|<\/p>$/g, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function nameHue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}
