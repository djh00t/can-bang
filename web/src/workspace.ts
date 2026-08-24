import { Api } from './api.js'
import { escapeHtml, findFences, parseChat } from './markdown.js'

type Phase = {
  id: string
  name: string
  ord: number
  status: string
  docId: string | null
  docTitle: string | null
  release: {
    id: string
    name: string
    demo_status: string
    docId: string | null
    docTitle: string | null
  } | null
  counts: { total: number; done: number }
}

type ProjectData = {
  project: {
    id: string
    name: string
    description: string | null
    docId: string | null
    docTitle: string | null
    github: { enabled: boolean; repo: string | null; syncEnabled: boolean }
  }
  phases: Phase[]
  releases: {
    id: string
    phaseId: string
    name: string
    demo_status: string
    demo_command: string | null
    notes: string | null
  }[]
  tasks: {
    id: string
    phaseId: string
    title: string
    status: string
    assignee: string | null
    feature: string | null
    done_means: string | null
    description: string | null
    blockers: string | null
    docId: string | null
  }[]
  counts: { total: number; done: number; doing: number; testing: number; todo: number }
}

type MatrixData = {
  project: { id: string; name: string }
  phases: {
    id: string
    name: string
    status: string
    release: { id: string; name: string; demo_status: string } | null
  }[]
  rows: { feature: string; cells: { phaseId: string; status: string }[] }[]
}

const STATUS_LABEL: Record<string, string> = {
  shipped: 'shipped',
  'in-progress': 'in progress',
  planned: 'planned',
  none: '—',
}

function hqContent(name: string): string {
  return `# ${name} — HQ

## Board

\`\`\`board #tickets
## Todo
## Doing
## Testing
## Done
\`\`\`

## Status

\`\`\`status
state: building
\`\`\`

## Team chat

\`\`\`chat #general
\`\`\`
`
}

function openModal(opts: {
  title: string
  submit: string
  fields: {
    name: string
    label: string
    required?: boolean
    placeholder?: string
    type?: string
    checked?: boolean
    options?: string[]
  }[]
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'ws-modal-overlay'
    overlay.innerHTML = `
      <div class="ws-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title)}">
        <div class="ws-modal-head"><b>${escapeHtml(opts.title)}</b><button type="button" class="btn sm" data-close>×</button></div>
        <form class="ws-modal-form">
          ${opts.fields
            .map(
              (f) =>
                `<label class="ws-modal-field"><span>${escapeHtml(f.label)}${f.required ? ' *' : ''}</span>
                  ${
                    f.type === 'select'
                      ? `<select name="${f.name}">${(f.options ?? []).map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`
                      : `<input name="${f.name}" type="${f.type ?? 'text'}" ${f.required ? 'required' : ''} ${f.checked ? 'checked' : ''} placeholder="${escapeHtml(f.placeholder ?? '')}" />`
                  }</label>`,
            )
            .join('')}
          <div class="ws-modal-actions">
            <button type="button" class="btn" data-cancel>Cancel</button>
            <button type="submit" class="btn primary">${escapeHtml(opts.submit)}</button>
          </div>
        </form>
      </div>`
    document.body.appendChild(overlay)
    const close = (val: Record<string, string> | null) => {
      overlay.remove()
      resolve(val)
    }
    overlay.querySelector('[data-close]')?.addEventListener('click', () => close(null))
    overlay.querySelector('[data-cancel]')?.addEventListener('click', () => close(null))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null)
    })
    overlay.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault()
      const vals: Record<string, string> = {}
      for (const f of opts.fields) {
        const el = overlay.querySelector(`[name="${f.name}"]`) as HTMLInputElement
        vals[f.name] = f.type === 'checkbox' ? (el?.checked ? 'yes' : '') : (el?.value ?? '')
      }
      if (opts.fields.some((f) => f.required && !vals[f.name]?.trim())) return
      close(vals)
    })
    ;(overlay.querySelector('input') as HTMLInputElement | null)?.focus()
  })
}

function openInfoModal(title: string, html: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'ws-modal-overlay'
  overlay.innerHTML = `
    <div class="ws-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="ws-modal-head"><b>${escapeHtml(title)}</b><button type="button" class="btn sm" data-close>×</button></div>
      <div class="ws-modal-body">${html}</div>
      <div class="ws-modal-actions"><button type="button" class="btn primary" data-close>Done</button></div>
    </div>`
  document.body.appendChild(overlay)
  overlay
    .querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', () => overlay.remove()))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove()
  })
  const copyBtn = overlay.querySelector('#copy-prompt')
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const ta = overlay.querySelector('#agent-prompt') as HTMLTextAreaElement | null
      if (!ta) return
      try {
        await navigator.clipboard.writeText(ta.value)
      } catch {
        ta.select()
        document.execCommand('copy')
      }
      copyBtn.textContent = 'Copied ✓'
    })
  }
}

export async function mountWorkspace(root: HTMLElement): Promise<void> {
  const api = new Api()
  let me = (await api.me())?.user ?? null
  let projects: {
    id: string
    name: string
    description: string | null
    phaseCount: number
    releaseCount: number
    total: number
    done: number
  }[] = []
  let projectId: string | null = null
  let phaseId: string | null = null
  let view: 'overview' | 'pipeline' | 'matrix' = 'overview'
  let detail: 'project' | 'release' = 'project'
  let releaseId: string | null = null
  let data: ProjectData | null = null
  let matrixData: MatrixData | null = null
  let releaseDetail: Awaited<ReturnType<Api['releaseDetail']>> | null = null
  let inbox: {
    docId: string
    title: string
    type: string
    message: string
    ts: number
    url?: string
  }[] = []
  let taskId: string | null = null
  let taskDetail: Awaited<ReturnType<Api['taskDetail']>> | null = null
  const burndownCache = new Map<string, Awaited<ReturnType<Api['phaseBurndown']>>>()
  const expanded = new Set<string>()
  let chat: {
    docId: string
    lines: { ts: string; name: string; text: string; kind?: string }[]
  } | null = null
  let skills: { slug: string; name: string; category: string; installs: number }[] = []
  let agentPrompt: { link: string; text: string } | null = null

  const isOpen = (key: string) => expanded.has(key)
  const toggle = (key: string) => {
    if (expanded.has(key)) expanded.delete(key)
    else expanded.add(key)
    render()
  }
  const chevron = (key: string) =>
    `<button class="ws-chev" data-toggle="${key}" aria-expanded="${isOpen(key)}" aria-label="toggle">${isOpen(key) ? '▾' : '▸'}</button>`

  const parseRoute = () => {
    const segs = location.pathname.split('/').filter(Boolean)
    const r: {
      projectId: string | null
      phaseId: string | null
      view: 'overview' | 'pipeline' | 'matrix'
      releaseId: string | null
      taskId: string | null
      detail: 'project' | 'release'
    } = {
      projectId: null,
      phaseId: null,
      view: 'overview',
      releaseId: null,
      taskId: null,
      detail: 'project',
    }
    if (segs[0] === 'p' && segs[1]) {
      r.projectId = segs[1]
      if (segs[2] === 'matrix') r.view = 'matrix'
      else if (segs[2] === 'pipeline') r.view = 'pipeline'
      else if (segs[2] === 'release' && segs[3]) {
        r.releaseId = segs[3]
        r.detail = 'release'
      } else if (segs[2] === 'phase' && segs[3]) {
        r.phaseId = segs[3]
        r.view = 'pipeline'
        if (segs[4] === 'task' && segs[5]) r.taskId = segs[5]
      }
    }
    return r
  }

  const urlFor = () => {
    if (!projectId) return '/'
    if (detail === 'release' && releaseId) return `/p/${projectId}/release/${releaseId}`
    if (view === 'matrix') return `/p/${projectId}/matrix`
    if (view === 'overview') return `/p/${projectId}`
    if (view === 'pipeline' && !phaseId) return `/p/${projectId}/pipeline`
    if (phaseId)
      return taskId
        ? `/p/${projectId}/phase/${phaseId}/task/${taskId}`
        : `/p/${projectId}/phase/${phaseId}`
    return `/p/${projectId}`
  }

  const syncUrl = (push = true) => {
    const url = urlFor()
    if (location.pathname === url) return
    if (push) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  }

  const load = async () => {
    projects = (await api.projects()).projects
    if (me) {
      try {
        inbox = (await api.inbox()).items
      } catch {
        inbox = []
      }
    }
    try {
      skills = (await api.skills()).skills
    } catch {
      skills = []
    }
  }

  const loadChat = async () => {
    if (!data?.project.docId) {
      chat = null
      return
    }
    try {
      const doc = await api.readDoc(data.project.docId, '')
      const fence = findFences(doc.content).find((f) => f.kind === 'chat')
      chat = { docId: data.project.docId, lines: fence ? parseChat(fence.body) : [] }
    } catch {
      chat = null
    }
  }

  const loadProject = async () => {
    if (!projectId) return
    data = await api.project(projectId)
    if (view === 'matrix') matrixData = await api.matrix(projectId)
    if (phaseId && !burndownCache.has(phaseId)) {
      burndownCache.set(phaseId, await api.phaseBurndown(phaseId))
    }
    await loadChat()
  }

  const goHome = () => {
    projectId = null
    phaseId = null
    releaseId = null
    taskId = null
    taskDetail = null
    releaseDetail = null
    data = null
    matrixData = null
    detail = 'project'
    view = 'overview'
    history.pushState(null, '', '/')
    render()
  }

  const selectProject = async (id: string) => {
    projectId = id
    phaseId = null
    releaseId = null
    detail = 'project'
    view = 'overview'
    taskId = null
    taskDetail = null
    await loadProject()
    expanded.add(`project:${id}`)
    if (phaseId) expanded.add(`phase:${phaseId}`)
    syncUrl()
    render()
  }

  const selectPhase = async (id: string) => {
    phaseId = id
    detail = 'project'
    view = 'pipeline'
    taskId = null
    taskDetail = null
    await loadProject()
    expanded.add(`project:${projectId ?? ''}`)
    expanded.add(`phase:${id}`)
    syncUrl()
    render()
  }

  const clearPhase = () => {
    phaseId = null
    detail = 'project'
    syncUrl()
    render()
  }

  const openTask = async (id: string) => {
    taskDetail = await api.taskDetail(id)
    taskId = id
    phaseId = taskDetail.phase.id
    await loadProject()
    expanded.add(`project:${projectId ?? ''}`)
    expanded.add(`phase:${phaseId}`)
    expanded.add(`tasks:${phaseId}`)
    syncUrl()
    render()
  }

  const closeTask = () => {
    taskId = null
    taskDetail = null
    syncUrl()
    render()
  }

  const openRelease = async (id: string) => {
    releaseId = id
    detail = 'release'
    releaseDetail = await api.releaseDetail(id)
    if (projectId) expanded.add(`project:${projectId}`)
    if (releaseDetail) expanded.add(`phase:${releaseDetail.phase.id}`)
    syncUrl()
    render()
  }

  const setView = async (v: 'overview' | 'pipeline' | 'matrix') => {
    view = v
    if (v === 'matrix' && projectId) matrixData = await api.matrix(projectId)
    syncUrl()
    render()
  }

  const render = () => {
    const phase = phaseId ? (data?.phases.find((p) => p.id === phaseId) ?? null) : null
    const phaseTasks = phaseId
      ? (data?.tasks.filter((t) => t.phaseId === phaseId) ?? [])
      : (data?.tasks ?? [])
    root.innerHTML = `
      <div class="ws-topbar">
        <div class="ws-top-left">
          <div class="ws-brand" data-go-home role="button" tabindex="0"><img src="/logo.svg" alt="" class="brand-logo" /> CanBang</div>
          <span class="muted small">${me ? `@${escapeHtml(me.username)}${me.agent_name ? ` · ${escapeHtml(me.agent_name)}` : ''}` : 'not signed in'}</span>
        </div>
        <div class="ws-top-actions">
          ${renderAccount()}
          <button class="btn primary" data-new-project>+ New project</button>
        </div>
      </div>
      <div class="ws-shell">
        <aside class="ws-sidebar">
          ${renderInbox()}
          <div class="ws-tree">
            <button type="button" class="ws-tree-title" data-go-home>Global</button>
            <div class="ws-tree-node">
              <div class="ws-tree-row">
                <button type="button" class="ws-tree-label muted" data-go-home>👤 Account · ${me ? `@${escapeHtml(me.username)}` : 'guest'}</button>
              </div>
              <div class="ws-tree-children">
                ${projects
                  .map((p) => {
                    const pk = `project:${p.id}`
                    const pd = data?.project.id === p.id ? data : null
                    return `
                  <div class="ws-tree-node">
                    <div class="ws-tree-row">
                      ${chevron(pk)}
                      <button class="ws-tree-label ${p.id === projectId ? 'sel' : ''}" data-project="${p.id}">📁 ${escapeHtml(p.name)}
                        <span class="ws-count">${p.done}/${p.total}</span></button>
                    </div>
                    ${
                      isOpen(pk)
                        ? `<div class="ws-tree-children">
                            ${
                              pd
                                ? pd.phases
                                    .map((ph) => {
                                      const phk = `phase:${ph.id}`
                                      const tk = `tasks:${ph.id}`
                                      const phaseReleases = pd.releases.filter(
                                        (rl) => rl.phaseId === ph.id,
                                      )
                                      return `
                              <div class="ws-tree-node">
                                <div class="ws-tree-row">
                                  ${chevron(phk)}
                                  <button class="ws-tree-label ${ph.id === phaseId ? 'sel' : ''}" data-phase="${ph.id}">◈ ${escapeHtml(ph.name)}
                                    <span class="ws-count">${ph.counts.done}/${ph.counts.total}</span></button>
                                </div>
                                ${
                                  isOpen(phk)
                                    ? `<div class="ws-tree-children">
                                        ${phaseReleases
                                          .map(
                                            (rl) =>
                                              `<button class="ws-tree-leaf" data-tree-release="${rl.id}" data-release-phase="${rl.phaseId}">🚀 ${escapeHtml(rl.name)} <span class="status-pill sp-${rl.demo_status}">${rl.demo_status}</span></button>`,
                                          )
                                          .join('')}
                                        ${ph.docId ? `<a class="ws-tree-leaf doc-link" href="/d/${encodeURIComponent(ph.docId)}">📄 ${escapeHtml(ph.docTitle ?? 'phase doc')}</a>` : ''}
                                        <div class="ws-tree-row">
                                          ${chevron(tk)}
                                          <span class="ws-tree-label muted">Tasks · ${ph.counts.total}</span>
                                        </div>
                                        ${
                                          isOpen(tk)
                                            ? `<div class="ws-tree-children">
                                                ${pd.tasks
                                                  .filter((t) => t.phaseId === ph.id)
                                                  .map(
                                                    (t) =>
                                                      `<button class="ws-tree-leaf" data-open-task="${t.id}"><span class="dot ws-${t.status}"></span>${escapeHtml(t.title)}</button>`,
                                                  )
                                                  .join('')}
                                              </div>`
                                            : ''
                                        }
                                      </div>`
                                    : ''
                                }
                              </div>`
                                    })
                                    .join('')
                                : '<div class="muted small" style="padding:4px 8px">Select the project to view its phases.</div>'
                            }
                            ${pd?.project.docId ? `<a class="ws-tree-leaf doc-link" href="/d/${encodeURIComponent(pd.project.docId)}">📄 ${escapeHtml(pd.project.docTitle ?? 'project doc')}</a>` : ''}
                          </div>`
                        : ''
                    }
                  </div>`
                  })
                  .join('')}
              </div>
            </div>
          </div>
        </aside>
        <main class="ws-main">${renderMain(phase, phaseTasks)}</main>
      </div>`
    wire()
  }

  const renderAccount = () => {
    if (me) {
      return `<button class="btn sm" id="agent-name" title="Set agent name">🤖 Agent</button>
        <button class="btn sm" id="mint-token" title="Mint API token">Token</button>
        <button class="btn sm" id="logout">Log out</button>`
    }
    return `<button class="btn sm" id="signup-btn">Create account</button>
      <button class="btn sm" id="login-btn">Sign in</button>`
  }

  const renderInbox = () => `
    <div class="ws-inbox panel">
      <h3>Needs human attention</h3>
      ${
        inbox.length
          ? inbox
              .slice(0, 6)
              .map(
                (i) =>
                  `<div class="ws-inbox-item">${
                    i.url
                      ? `<a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">${escapeHtml(i.title)}</a>`
                      : `<a href="/d/${i.docId}">${escapeHtml(i.title)}</a>`
                  } <span class="tag">${escapeHtml(i.type)}</span><div class="muted small">${escapeHtml(i.message.slice(0, 90))}</div></div>`,
              )
              .join('')
          : '<span class="muted small">Nothing needs you right now.</span>'
      }
    </div>`

  const renderMain = (phase: Phase | null, phaseTasks: ProjectData['tasks']) => {
    if (!me) {
      return `<div class="ws-welcome panel"><h2>Sign in or create an account to get started</h2>
        <p class="muted">Projects, phases, releases, and tasks live in your account. Anonymous docs still work — create one below.</p>
        <div class="ws-quick"><button class="btn" id="new-blank">Blank doc</button><button class="btn" id="new-hq">Agent Team HQ</button></div></div>`
    }
    if (!projectId || !data) {
      return renderGlobalDashboard()
    }
    if (detail === 'release' && releaseDetail) return renderReleaseDetail()
    return `
      <div class="ws-project-head">
        <div>
          <h2>${escapeHtml(data.project.name)}</h2>
          ${data.project.description ? `<div class="muted">${escapeHtml(data.project.description)}</div>` : ''}
        </div>
        <div class="ws-tabs" role="tablist">
          <button class="ws-tab ${view === 'overview' ? 'on' : ''}" data-view="overview">Overview</button>
          <button class="ws-tab ${view === 'pipeline' ? 'on' : ''}" data-view="pipeline">Pipeline</button>
          <button class="ws-tab ${view === 'matrix' ? 'on' : ''}" data-view="matrix">Feature Matrix</button>
        </div>
        <button class="btn sm" id="link-project-doc">Link docs</button>
      </div>
      <div class="ws-project-body">
        ${view === 'overview' ? renderOverview() : view === 'pipeline' ? renderPipeline(phase, phaseTasks) : renderMatrix()}
      </div>
      ${
        taskId
          ? `<div class="ws-drawer" role="dialog" aria-label="Task detail">
              ${renderTaskDrawer()}
            </div>`
          : ''
      }`
  }

  const renderPipeline = (phase: Phase | null, phaseTasks: ProjectData['tasks']) => {
    const columns = [
      ['todo', 'Todo'],
      ['doing', 'Doing'],
      ['testing', 'Testing'],
      ['done', 'Done'],
    ] as const
    const releaseByPhase = new Map(data!.releases.map((r) => [r.phaseId, r.name]))
    const pct =
      phase && phase.counts.total ? Math.round((phase.counts.done / phase.counts.total) * 100) : 0
    return `
      <div class="ws-pipeline-wrap">
        ${
          phase
            ? `<div class="ws-filter-row"><span class="tag">Filtered · ${escapeHtml(phase.name)}</span><button class="btn sm" data-clear-phase>All phases</button></div>`
            : '<div class="ws-filter-row"><span class="tag">All phases</span></div>'
        }
        <div class="ws-pipeline">
        <div class="ws-board">
          ${columns
            .map(
              ([key, label]) => `
            <div class="col">
              <h4>${label} <span class="col-count">${phaseTasks.filter((t) => t.status === key).length}</span></h4>
              ${phaseTasks
                .filter((t) => t.status === key)
                .map(
                  (t) =>
                    `<div class="board-card ${t.status}" data-open-task="${t.id}" data-status="${t.status}">
                       <span class="card-text">${escapeHtml(t.title)}</span>
                       <span class="card-meta">${releaseByPhase.get(t.phaseId) ? `<span class="chip release">🚀 ${escapeHtml(releaseByPhase.get(t.phaseId)!)}</span>` : ''}${t.assignee ? `<span class="chip assignee">@${escapeHtml(t.assignee)}</span>` : ''}${t.feature ? `<span class="chip tag">${escapeHtml(t.feature)}</span>` : ''}</span>
                     </div>`,
                )
                .join('')}
            </div>`,
            )
            .join('')}
        </div>
        <div class="ws-right">
          <div class="panel">
            <h3>Releases / demos</h3>
            ${data!.releases
              .map(
                (rl) =>
                  `<button class="ws-release ${rl.phaseId === phaseId ? 'on' : ''}" data-release="${rl.id}">
                     <span class="status-pill sp-${rl.demo_status}">${rl.demo_status}</span>
                     <span>${escapeHtml(rl.name)}</span></button>`,
              )
              .join('')}
          </div>
          <div class="panel">
            <h3>Burndown · ${phase ? escapeHtml(phase.name) : 'all phases'}</h3>
            ${renderBurndown(phase)}
          </div>
          ${renderChat()}
          <button class="btn sm block" id="add-task">+ Task in ${phase ? escapeHtml(phase.name) : 'phase'}</button>
        </div>
        </div>
      </div>`
  }

  const renderOverview = () => {
    const pct = (ph: Phase) =>
      ph.counts.total ? Math.round((ph.counts.done / ph.counts.total) * 100) : 0
    return `
      <div class="ws-overview">
        <div class="ws-stats">
          ${[
            ['Total', data!.counts.total],
            ['Done', data!.counts.done],
            ['Doing', data!.counts.doing],
            ['Testing', data!.counts.testing],
            ['Todo', data!.counts.todo],
          ]
            .map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`)
            .join('')}
        </div>
        <div class="ws-overview-grid">
          <div class="ws-overview-left">
            <div class="panel">
              <h3>Phases</h3>
              ${
                data!.phases
                  .map(
                    (ph) => `
                  <button class="ws-phase-card" data-phase="${ph.id}">
                    <div class="ws-phase-row"><b>${escapeHtml(ph.name)}</b><span class="status-pill sp-${ph.status === 'done' ? 'ship' : ph.status === 'active' ? 'doing' : 'todo'}">${escapeHtml(ph.status)}</span></div>
                    <div class="bar-track"><div class="bar-fill" style="width:${pct(ph)}%"></div></div>
                    <div class="muted small">${ph.counts.done}/${ph.counts.total} tasks${ph.release ? ` · 🚀 ${escapeHtml(ph.release.name)} <span class="status-pill sp-${ph.release.demo_status}">${ph.release.demo_status}</span>` : ''}${ph.status === 'done' && ph.release && !ph.release.docId ? ' · <span class="tag">review pending</span>' : ''}</div>
                  </button>`,
                  )
                  .join('') || '<span class="muted">No phases yet.</span>'
              }
              <button class="btn sm" id="add-phase">+ New phase</button>
            </div>
            <div class="panel">
              <h3>Releases / demos</h3>
              ${
                data!.releases
                  .map(
                    (rl) =>
                      `<button class="ws-release" data-release="${rl.id}"><span class="status-pill sp-${rl.demo_status}">${rl.demo_status}</span>${escapeHtml(rl.name)}</button>`,
                  )
                  .join('') || '<span class="muted">No releases yet.</span>'
              }
            </div>
            ${renderGithub()}
            ${renderAgents()}
            ${data!.project.docId ? `<div class="panel"><h3>Project doc</h3><a class="btn sm" href="/d/${encodeURIComponent(data!.project.docId)}">Open · ${escapeHtml(data!.project.docTitle ?? 'project doc')}</a></div>` : ''}
          </div>
          <div class="ws-overview-right">${renderChat()}</div>
        </div>
      </div>`
  }

  const renderGlobalDashboard = () => `
    <div class="ws-global">
      <div class="ws-project-head">
        <div>
          <h2>Global · @${escapeHtml(me!.username)}</h2>
          <div class="muted">All projects, releases, and tasks across your account.</div>
        </div>
        <div class="ws-quick" style="flex-direction:row;flex-wrap:wrap">
          <button class="btn primary" data-new-project>+ New project</button>
          <button class="btn" id="new-blank">Blank doc</button>
          <button class="btn" id="new-hq">Agent Team HQ</button>
        </div>
        <p class="muted small">Blank doc — start a plain markdown doc · Agent Team HQ — the agent-coordination template (board, chat, status). The Sprint Review runs at the end of each release.</p>
      </div>
      <div class="ws-global-grid">
        <div class="panel">
          <h3>Projects</h3>
          ${
            projects
              .map(
                (p) => `
              <button class="ws-project-card" data-project="${p.id}">
                <b>${escapeHtml(p.name)}</b>
                <span class="muted small">${p.phaseCount} phases · ${p.releaseCount} releases</span>
                <div class="bar-track"><div class="bar-fill" style="width:${p.total ? Math.round((p.done / p.total) * 100) : 0}%"></div></div>
                <span class="muted small">${p.done}/${p.total} tasks</span>
              </button>`,
              )
              .join('') || '<span class="muted">No projects yet — create one to get started.</span>'
          }
        </div>
        <div class="panel">
          <h3>Skills</h3>
          ${
            skills
              .map(
                (s) =>
                  `<div class="ws-inbox-item"><b>${escapeHtml(s.name)}</b> <span class="tag">${escapeHtml(s.category)}</span> <span class="muted small">${s.installs} installs</span></div>`,
              )
              .join('') || '<span class="muted">No skills published yet.</span>'
          }
        </div>
      </div>
    </div>`

  const renderChat = () => {
    if (!chat) {
      return `<div class="panel"><h3>Team chat</h3><span class="muted small">Link a project doc containing a \`\`\`chat fence to enable chat.</span></div>`
    }
    return `
      <div class="panel ws-chat">
        <h3>Team chat</h3>
        <div class="chat-list">
          ${
            chat.lines
              .map(
                (l) =>
                  `<div class="chat-line"><span class="avatar" style="--hue:${nameHue(l.name)}">${escapeHtml(l.name.slice(0, 1).toUpperCase())}</span><div class="chat-body"><span class="chat-name">@${escapeHtml(l.name)}</span><span class="chat-text">${escapeHtml(l.text)}</span><time>${escapeHtml(l.ts.slice(11, 19))}</time></div></div>`,
              )
              .join('') || '<span class="muted small">No messages yet.</span>'
          }
        </div>
        <div class="chat-compose">
          <input id="chat-input" placeholder="Message…" />
          <button class="btn sm primary" id="chat-send">Send</button>
        </div>
      </div>`
  }

  const renderGithub = () => {
    const g = data!.project.github
    if (g.enabled) {
      return `<div class="panel"><h3>GitHub Issues sync</h3>
        <div class="muted small">Repo: <code>${escapeHtml(g.repo ?? '')}</code>${g.syncEnabled ? ' · synced' : ''}</div>
        <div class="ws-modal-actions" style="margin-top:6px"><button class="btn sm primary" id="sync-github">Sync now</button><span class="muted small" id="sync-result"></span></div>
        <div class="muted small">Tasks push to GitHub issues; CanBang-marked issues import back into this project.</div></div>`
    }
    return `<div class="panel"><h3>GitHub Issues sync <span class="tag">optional</span></h3>
      <div class="ws-modal-field"><span>Repo (owner/name)</span><input id="gh-repo" placeholder="djh00t/can-bang" /></div>
      <div class="ws-modal-field"><span>Personal access token (repo scope)</span><input id="gh-token" type="password" placeholder="ghp_…" /></div>
      <button class="btn sm" id="enable-github">Enable sync</button>
      <div class="muted small">Tasks push to GitHub issues; issues created from CanBang tasks import back.</div></div>`
  }

  const renderAgents = () => {
    if (!data!.project.docId) {
      return `<div class="panel"><h3>Agent onboarding</h3><span class="muted small">Link a project doc first to onboard agents.</span></div>`
    }
    return `<div class="panel"><h3>Agent onboarding</h3>
      ${
        agentPrompt
          ? `<div class="ws-modal-field"><span>Prompt for your Codex instances</span>
              <textarea readonly rows="12" id="agent-prompt">${escapeHtml(agentPrompt.text)}</textarea></div>
             <div class="ws-modal-actions"><button class="btn sm primary" id="copy-agent-prompt">Copy prompt</button><span class="muted small">${escapeHtml(agentPrompt.link)}</span></div>`
          : `<span class="muted small">Mint an edit link to the project doc and generate the onboarding prompt for your Codex instances.</span>
             <button class="btn sm" id="gen-agent-prompt">Generate agent prompt + link</button>`
      }
      <div class="ws-modal-actions" style="margin-top:6px"><button class="btn sm" id="add-agent-briefing">Add AGENTS briefing to project doc</button></div>
      <div class="muted small">Paste the same prompt into each Codex instance — they self-assign roles (one agent per role).</div></div>`
  }

  const renderMatrix = () => {
    if (!matrixData) return '<div class="panel"><span class="muted">loading matrix…</span></div>'
    return `
      <div class="ws-matrix-wrap panel">
        <table class="ws-matrix">
          <thead><tr>
            <th>Feature</th>
            ${matrixData.phases
              .map(
                (ph) =>
                  `<th>${escapeHtml(ph.name)}<br/><button class="ws-matrix-release" data-release="${ph.release?.id ?? ''}">${escapeHtml(ph.release?.name ?? 'no release')} · <span class="status-pill sp-${ph.release?.demo_status ?? 'pending'}">${ph.release?.demo_status ?? '—'}</span></button></th>`,
              )
              .join('')}
          </tr></thead>
          <tbody>
            ${matrixData.rows
              .map(
                (row) =>
                  `<tr><td><b>${escapeHtml(row.feature)}</b></td>${row.cells
                    .map(
                      (c) =>
                        `<td><span class="status-pill sp-${c.status === 'none' ? 'todo' : c.status}">${STATUS_LABEL[c.status] ?? c.status}</span></td>`,
                    )
                    .join('')}</tr>`,
              )
              .join('')}
          </tbody>
        </table>
        <div class="muted small">Click a release column to open that release's detail view.</div>
      </div>`
  }

  const renderBurndown = (phase: Phase | null) => {
    const b = phase ? burndownCache.get(phase.id) : undefined
    const counts = phase ? phase.counts : { done: data!.counts.done, total: data!.counts.total }
    if (!b || !b.points.length) {
      const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0
      return `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="muted small">${counts.done}/${counts.total} tasks done (${pct}%)${phase ? '' : ' · all phases'}</div>`
    }
    const pts = b.points
    const max = Math.max(1, ...pts.map((p) => p.remaining))
    const w = 280
    const h = 70
    const coords = pts
      .map(
        (p, i) =>
          `${pts.length > 1 ? (i / (pts.length - 1)) * w : w / 2},${h - 8 - (p.remaining / max) * (h - 16)}`,
      )
      .join(' ')
    return `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Burndown: remaining tasks over time">
        <polyline points="${coords}" fill="none" stroke="#12b76a" stroke-width="2" />
      </svg>
      <div class="muted small">${b.current} remaining of ${b.total} · ${pts[0]?.date} → ${pts[pts.length - 1]?.date}</div>`
  }

  const renderTaskDrawer = () => {
    const t = taskDetail
    if (!t) return '<span class="muted">loading…</span>'
    return `
      <div class="ws-drawer-head">
        <b>${escapeHtml(t.task.title)}</b>
        <button class="btn sm" data-close-task aria-label="Close task detail">×</button>
      </div>
      <div class="ws-drawer-body">
        <div class="row"><span>Status</span>
          <span class="ws-status-btns">
            ${['todo', 'doing', 'testing', 'done']
              .map(
                (s) =>
                  `<button class="btn sm ${t.task.status === s ? 'primary' : ''}" data-set-status="${s}">${s}</button>`,
              )
              .join('')}
          </span>
        </div>
        <div class="row"><span>Phase</span><b>${escapeHtml(t.phase.name)}</b></div>
        <div class="row"><span>Project</span><b>${escapeHtml(t.project.name)}</b></div>
        ${t.task.assignee ? `<div class="row"><span>Assignee</span><b>@${escapeHtml(t.task.assignee)}</b></div>` : ''}
        ${t.task.feature ? `<div class="row"><span>Feature</span><b>${escapeHtml(t.task.feature)}</b></div>` : ''}
        ${t.task.done_means ? `<div class="ws-field"><span class="muted small">done-means</span><div>${escapeHtml(t.task.done_means)}</div></div>` : ''}
        ${t.task.description ? `<div class="ws-field"><span class="muted small">description</span><div>${escapeHtml(t.task.description)}</div></div>` : ''}
        ${t.task.blockers ? `<div class="ws-field"><span class="muted small">blockers</span><div>${escapeHtml(t.task.blockers)}</div></div>` : ''}
        <div class="ws-drawer-actions">
          ${t.task.docId ? `<a class="btn sm" href="/d/${encodeURIComponent(t.task.docId)}">Open doc · ${escapeHtml(t.task.docTitle ?? 'linked')}</a>` : ''}
          <button class="btn sm" data-link-task-doc>${t.task.docId ? 'Change doc' : 'Link doc'}</button>
          <button class="btn sm" data-edit-task="title">Rename</button>
          <button class="btn sm" data-edit-task="assignee">Assignee</button>
          <button class="btn sm" data-edit-task="feature">Feature</button>
          <button class="btn sm" data-edit-task="done_means">done-means</button>
          <button class="btn sm" data-edit-task="description">Description</button>
          <button class="btn sm" data-edit-task="blockers">Blockers</button>
        </div>
      </div>`
  }

  const renderReleaseDetail = () => {
    const rl = releaseDetail!
    return `
      <div class="ws-release-detail panel">
        <button class="btn sm" id="back-to-project">← Back to ${escapeHtml(rl.project.name)}</button>
        <h2>Release · ${escapeHtml(rl.release.name)}</h2>
        <div class="ws-release-meta">
          <span>Phase: <b>${escapeHtml(rl.phase.name)}</b> (${escapeHtml(rl.phase.status)})</span>
          <span>Demo status:
            ${['pending', 'pass', 'partial', 'fail']
              .map(
                (s) =>
                  `<button class="btn sm ${rl.release.demo_status === s ? 'primary' : ''}" data-demo-status="${s}">${s}</button>`,
              )
              .join('')}
          </span>
        </div>
        ${rl.release.demo_command ? `<div class="muted small">Demo: <code>${escapeHtml(rl.release.demo_command)}</code></div>` : ''}
        ${rl.release.notes ? `<div class="muted small">${escapeHtml(rl.release.notes)}</div>` : ''}
        <div class="ws-release-review">
          ${
            rl.release.docId
              ? `<a class="btn sm primary" href="/d/${encodeURIComponent(rl.release.docId)}">Open review · ${escapeHtml(rl.release.docTitle ?? 'Sprint Review')}</a>`
              : `<button class="btn sm primary" id="run-release-review">Run end-of-release review</button>`
          }
          <span class="muted small">Sprint Review is the last step of each release: evidence → what worked/failed → improvements → never-repeat rules.</span>
        </div>
        <h3>Tasks in this release</h3>
        ${
          rl.tasks
            .map(
              (t) =>
                `<div class="taskline"><span class="dot ws-${t.status}"></span><span>${escapeHtml(t.title)}</span>${t.assignee ? `<span class="chip assignee">@${escapeHtml(t.assignee)}</span>` : ''}<span class="status-pill sp-${t.status === 'done' ? 'ship' : t.status}">${escapeHtml(t.status)}</span></div>`,
            )
            .join('') || '<span class="muted">No tasks yet.</span>'
        }
      </div>`
  }

  const wire = () => {
    document.querySelectorAll<HTMLElement>('[data-go-home]').forEach((el) => {
      el.addEventListener('click', () => goHome())
    })
    document.getElementById('login-btn')?.addEventListener('click', () => void login())
    document.getElementById('signup-btn')?.addEventListener('click', () => void signup())
    document
      .getElementById('logout')
      ?.addEventListener('click', () => void api.logout().then(() => location.reload()))
    document.getElementById('agent-name')?.addEventListener('click', async () => {
      const name = prompt('Agent name (shown as author for token writes):', me?.agent_name ?? '')
      if (name) {
        await api.agentName(name)
        location.reload()
      }
    })
    document.getElementById('mint-token')?.addEventListener('click', async () => {
      const res = await api.createToken()
      alert(`Token (shown once): ${res.token}`)
    })
    document.querySelectorAll<HTMLElement>('[data-new-project]').forEach((el) => {
      el.addEventListener('click', () => void newProject())
    })
    document.getElementById('new-blank')?.addEventListener('click', () => void createDoc())
    document
      .getElementById('new-hq')
      ?.addEventListener('click', () => void createDoc('agent-team-hq'))
    document.querySelectorAll<HTMLButtonElement>('[data-project]').forEach((b) => {
      b.addEventListener('click', () => void selectProject(b.dataset.project!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => {
      b.addEventListener('click', () => toggle(b.dataset.toggle!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-phase]').forEach((b) => {
      b.addEventListener('click', () => void selectPhase(b.dataset.phase!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-release]').forEach((b) => {
      b.addEventListener('click', () => void openRelease(b.dataset.release!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-tree-release]').forEach((b) => {
      b.addEventListener('click', () => {
        if (view === 'pipeline') {
          phaseId = b.dataset.releasePhase ?? null
          if (projectId) expanded.add(`project:${projectId}`)
          if (phaseId) expanded.add(`phase:${phaseId}`)
          syncUrl()
          render()
        } else {
          void openRelease(b.dataset.treeRelease!)
        }
      })
    })
    document.querySelectorAll<HTMLButtonElement>('[data-clear-phase]').forEach((b) => {
      b.addEventListener('click', () => clearPhase())
    })
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      b.addEventListener(
        'click',
        () => void setView(b.dataset.view as 'overview' | 'pipeline' | 'matrix'),
      )
    })
    document.querySelectorAll<HTMLButtonElement>('[data-open-task]').forEach((b) => {
      b.addEventListener('click', () => void openTask(b.dataset.openTask!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-close-task]').forEach((b) => {
      b.addEventListener('click', () => closeTask())
    })
    document.querySelectorAll<HTMLButtonElement>('[data-set-status]').forEach((b) => {
      b.addEventListener('click', () => void setTaskStatus(b.dataset.setStatus!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-edit-task]').forEach((b) => {
      b.addEventListener('click', () => void editTaskField(b.dataset.editTask!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-link-task-doc]').forEach((b) => {
      b.addEventListener('click', () => void linkTaskDoc())
    })
    document
      .getElementById('link-project-doc')
      ?.addEventListener('click', () => void linkProjectDoc())
    document.getElementById('add-task')?.addEventListener('click', () => void addTask())
    document.getElementById('add-phase')?.addEventListener('click', () => void addPhase())
    document.getElementById('chat-send')?.addEventListener('click', () => void sendChat())
    document.getElementById('chat-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void sendChat()
    })
    document.getElementById('enable-github')?.addEventListener('click', () => void enableGithub())
    document.getElementById('sync-github')?.addEventListener('click', () => void runGithubSync())
    document
      .getElementById('gen-agent-prompt')
      ?.addEventListener('click', () => void genAgentPrompt())
    document
      .getElementById('copy-agent-prompt')
      ?.addEventListener('click', () => void copyAgentPrompt())
    document
      .getElementById('add-agent-briefing')
      ?.addEventListener('click', () => void addAgentBriefing())
    document.getElementById('back-to-project')?.addEventListener('click', () => {
      detail = 'project'
      releaseId = null
      syncUrl()
      render()
    })
    document.querySelectorAll<HTMLButtonElement>('[data-demo-status]').forEach((b) => {
      b.addEventListener('click', () => void setDemoStatus(b.dataset.demoStatus!))
    })
    document
      .getElementById('run-release-review')
      ?.addEventListener('click', () => void runReleaseReview())
  }

  const newProject = async () => {
    const vals = await openModal({
      title: 'New project',
      submit: 'Create project',
      fields: [
        { name: 'name', label: 'Project name', required: true, placeholder: 'e.g. PodDown' },
        { name: 'description', label: 'Description', placeholder: 'What is this project about?' },
        { name: 'hq', label: 'Create HQ doc + agent link', type: 'checkbox', checked: true },
      ],
    })
    if (!vals) return
    const name = (vals.name ?? '').trim()
    if (!name) return
    const res = await api.createProject(name, vals.description?.trim() || undefined)
    let shareUrl: string | null = null
    if (vals.hq === 'yes') {
      try {
        const doc = await api.createOwnedDoc(`${name} — HQ`, hqContent(name))
        await api.patchProject(res.project.id, { doc_id: doc.id })
        const s = await api.share(doc.id, 'edit')
        shareUrl = s.share.url
      } catch {
        shareUrl = null
      }
    }
    await load()
    await selectProject(res.project.id)
    const promptText = shareUrl
      ? `Read ${location.origin}/agents.md, then work the project doc at ${shareUrl} — phases, releases, and tasks are in the workspace; claim a task, post progress to the chat, and flag me when you need a human.`
      : null
    openInfoModal(
      'Project created',
      `
      <p><b>${escapeHtml(name)}</b> is ready.${shareUrl ? ' Here is the link to hand your agents.' : ''}</p>
      ${
        shareUrl && promptText
          ? `<div class="ws-modal-field"><span>Agent prompt (copy-paste into Codex / Claude / Cursor)</span>
              <textarea readonly rows="4" id="agent-prompt">${escapeHtml(promptText)}</textarea></div>
             <div class="ws-modal-field"><span>Project doc link (edit)</span>
              <input readonly value="${escapeHtml(shareUrl)}" /></div>
             <button type="button" class="btn primary" id="copy-prompt">Copy prompt</button>`
          : '<p class="muted small">No HQ doc was created — use “Link docs” in the project overview to add one.</p>'
      }
      <p class="muted small">Open the project to add phases, releases, and tasks — or enable GitHub Issues sync.</p>`,
    )
  }

  const createDoc = async (template?: string) => {
    const res: { url: string; id: string; key?: string } = me
      ? await api.createOwnedDoc(
          template ? (template === 'agent-team-hq' ? 'Agent Team HQ' : template) : undefined,
        )
      : await api.createDoc('', undefined, undefined)
    const key = 'key' in res ? (res.key ?? '') : ''
    if (template) {
      const t = await fetch(`/api/templates/${template}`)
      const body = (await t.json()) as { content: string }
      const meta = await api.readDoc(res.id, key)
      await api.writeDoc(res.id, key, body.content, meta.version, 'from template')
    }
    location.href = key ? `/d/${res.id}?key=${encodeURIComponent(key)}` : `/d/${res.id}`
  }

  const addTask = async () => {
    if (!data) return
    if (!phaseId) {
      const vals = await openModal({
        title: 'New task',
        submit: 'Add task',
        fields: [
          {
            name: 'phase',
            label: 'Phase',
            type: 'select',
            options: data.phases.map((p) => p.name),
            required: true,
          },
          { name: 'title', label: 'Task title', required: true },
          { name: 'feature', label: 'Feature (for the matrix)' },
          { name: 'assignee', label: 'Assignee (@name)' },
        ],
      })
      if (!vals) return
      const phase = data.phases.find((p) => p.name === (vals.phase ?? ''))
      if (!phase) return
      await api.createTask(phase.id, {
        title: (vals.title ?? '').trim(),
        feature: vals.feature?.trim() || undefined,
        assignee: vals.assignee?.trim() || undefined,
      })
      await loadProject()
      render()
      return
    }
    const title = prompt('Task title:')
    if (!title) return
    const feature = prompt('Feature (for the matrix):') ?? undefined
    const assignee = prompt('Assignee (@name):') ?? undefined
    await api.createTask(phaseId, {
      title,
      feature: feature || undefined,
      assignee: assignee || undefined,
    })
    await loadProject()
    render()
  }

  const addPhase = async () => {
    if (!projectId) return
    const name = prompt('Phase name:')
    if (!name) return
    await api.createPhase(projectId, name)
    await loadProject()
    render()
  }

  const sendChat = async () => {
    if (!chat) return
    const input = document.getElementById('chat-input') as HTMLInputElement | null
    if (!input || !input.value.trim()) return
    const text = input.value.trim()
    const doc = await api.readDoc(chat.docId, '')
    const fences = findFences(doc.content).filter((f) => f.kind === 'chat')
    await api.chat(chat.docId, '', text, fences[0]?.id, me?.agent_name ?? me?.username)
    input.value = ''
    await loadChat()
    await loadProject()
    render()
  }

  const setDemoStatus = async (status: string) => {
    if (!releaseId) return
    await api.patchRelease(releaseId, { demo_status: status })
    releaseDetail = await api.releaseDetail(releaseId)
    await loadProject()
    render()
  }

  const runReleaseReview = async () => {
    if (!releaseId || !releaseDetail) return
    const t = await fetch('/api/templates/sprint-review')
    const body = (await t.json()) as { content: string }
    const doc = await api.createOwnedDoc(
      `Sprint Review — ${releaseDetail.release.name}`,
      body.content,
    )
    await api.patchRelease(releaseId, { doc_id: doc.id })
    releaseDetail = await api.releaseDetail(releaseId)
    await loadProject()
    render()
    location.href = `/d/${doc.id}`
  }

  const setTaskStatus = async (status: string) => {
    if (!taskId) return
    await api.patchTask(taskId, { status })
    if (phaseId) burndownCache.delete(phaseId)
    taskDetail = await api.taskDetail(taskId)
    await loadProject()
    render()
  }

  const editTaskField = async (field: string) => {
    if (!taskId || !taskDetail) return
    const current = taskDetail.task[field as 'title']
    const value = prompt(`Edit ${field}:`, current ?? '')
    if (value === null) return
    const patch: Record<string, string | null> = {}
    if (value.trim() === '') patch[field] = null
    else patch[field] = value
    await api.patchTask(taskId, patch as never)
    taskDetail = await api.taskDetail(taskId)
    await loadProject()
    render()
  }

  const linkTaskDoc = async () => {
    if (!taskId) return
    const docId = prompt('Document id to link (owned docs open with your session):')
    if (!docId) return
    await api.patchTask(taskId, { doc_id: docId })
    taskDetail = await api.taskDetail(taskId)
    await loadProject()
    render()
  }

  const linkProjectDoc = async () => {
    if (!projectId) return
    const docId = prompt('Project document id (owned docs open with your session):')
    if (!docId) return
    await api.patchProject(projectId, { doc_id: docId })
    await loadProject()
    render()
  }

  const enableGithub = async () => {
    if (!projectId) return
    const repo = (document.getElementById('gh-repo') as HTMLInputElement | null)?.value.trim()
    const token = (document.getElementById('gh-token') as HTMLInputElement | null)?.value.trim()
    if (!repo) {
      alert('Enter the repository as owner/name (e.g. djh00t/can-bang).')
      return
    }
    if (!token) {
      alert('Enter a GitHub personal access token with repo scope.')
      return
    }
    await api.patchGithub(projectId, { enabled: true, repo, token })
    await loadProject()
    render()
  }

  const runGithubSync = async () => {
    if (!projectId) return
    const btn = document.getElementById('sync-github')
    const out = document.getElementById('sync-result')
    if (btn) btn.textContent = 'Syncing…'
    try {
      const r = await api.syncGithub(projectId)
      if (out)
        out.textContent = `created ${r.created} · updated ${r.updated} · closed ${r.closed} · imported ${r.imported}`
    } catch (e) {
      alert(`GitHub sync failed: ${(e as Error).message}`)
    } finally {
      await loadProject()
      render()
    }
  }

  const agentBriefing = () => {
    const name = data!.project.name
    return `You are one of several Codex instances coordinating through this doc. Nobody will brief you beyond this section.

1. Learn the site: the full agent API is at /agents.md.
   - Read — GET <this-doc-url>.md (your ?key= works on it).
   - Write — PUT /api/docs/<id>/content with If-Match set to the X-Doc-Version you read. On 409, re-read and retry.
   - Chat — POST /api/docs/<id>/chat/message with {"text":"...","author":"<your-role>"}.
   - Evidence — POST /api/docs/<id>/assets (raw bytes) returns markdown you can embed on a card.
2. Claim a role from the roster below — one agent per role. Write your role into Claimed by with a versioned write; a 409 means another agent beat you.
3. Work the board: claim a card by flipping [ ] to [>], moving it to Doing, and adding @<your-role>. Every card needs a done-means: line.
4. Never grade your own work: move finished cards to Testing, not Done. The tester re-verifies with fresh eyes.
5. Post progress to chat; set the status to awaiting-human only when you need the human.
6. Don't stop: card done → pull the next one. You're finished when the human says so.

## Roster (${name})
Role | You own | Claimed by
integrator | merging, deploying, keeping main green | 
builder | feature work with evidence | 
scout | fresh-eyes verification and findings | 
tester | verifying Testing cards against done-means | 

## Mission
${data!.project.description ?? 'Ship the current phase, then the next.'}`
  }

  const buildAgentPrompt = (link: string) =>
    `Read ${location.origin}/agents.md, then work this project doc: ${link}

` + agentBriefing()

  const genAgentPrompt = async () => {
    if (!data?.project.docId) return
    const s = await api.share(data.project.docId, 'edit')
    agentPrompt = { link: s.share.url, text: buildAgentPrompt(s.share.url) }
    render()
  }

  const copyAgentPrompt = async () => {
    const ta = document.getElementById('agent-prompt') as HTMLTextAreaElement | null
    if (!ta) return
    try {
      await navigator.clipboard.writeText(ta.value)
    } catch {
      ta.select()
      document.execCommand('copy')
    }
  }

  const addAgentBriefing = async () => {
    if (!data?.project.docId) return
    const doc = await api.readDoc(data.project.docId, '')
    if (doc.content.includes('AGENTS: READ THIS FIRST')) {
      alert('The AGENTS briefing is already in the project doc.')
      return
    }
    const updated = `${doc.content.trimEnd()}\n\n## AGENTS: READ THIS FIRST\n\n${agentBriefing()}`
    await api.writeDoc(data.project.docId, '', updated, doc.version, 'agent briefing')
    await loadProject()
    render()
  }

  const login = async () => {
    const username = prompt('Username:')
    const password = prompt('Password:')
    if (!username || !password) return
    try {
      await api.login(username, password)
      location.reload()
    } catch (e) {
      alert(`Sign in failed: ${(e as Error).message} — use "Create account" if you don't have one.`)
    }
  }

  const signup = async () => {
    const username = prompt('Choose a username (2-60 letters, digits, dash, underscore):')
    if (!username) return
    const password = prompt('Choose a password (at least 8 characters):')
    if (!password) return
    if (password.length < 8) {
      alert('Password must be at least 8 characters.')
      return
    }
    try {
      await api.signup(username, password)
      location.reload()
    } catch (e) {
      const err = e as Error & { body?: { hint?: string } }
      alert(`Signup failed: ${err.message}${err.body?.hint ? ` — ${err.body.hint}` : ''}`)
    }
  }

  const route = parseRoute()
  projectId = route.projectId
  phaseId = route.phaseId
  view = route.view
  releaseId = route.releaseId
  taskId = route.taskId
  detail = route.detail

  await load()
  if (projectId) {
    await loadProject()
    if (detail === 'release' && releaseId) releaseDetail = await api.releaseDetail(releaseId)
    if (taskId) {
      taskDetail = await api.taskDetail(taskId)
      phaseId = taskDetail.phase.id
      await loadProject()
    }
  } else if (me && projects[0]) {
    projectId = projects[0].id
    await loadProject()
  }
  render()

  window.addEventListener('popstate', async () => {
    const r = parseRoute()
    projectId = r.projectId
    phaseId = r.phaseId
    view = r.view
    releaseId = r.releaseId
    taskId = r.taskId
    detail = r.detail
    taskDetail = null
    releaseDetail = null
    if (projectId) {
      await loadProject()
      if (detail === 'release' && releaseId) releaseDetail = await api.releaseDetail(releaseId)
      if (taskId) {
        taskDetail = await api.taskDetail(taskId)
        phaseId = taskDetail.phase.id
        await loadProject()
      }
    }
    render()
  })
}

function nameHue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}
