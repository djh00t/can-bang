import { Api } from './api.js'
import { escapeHtml, findFences, parseChat, renderMarkdown } from './markdown.js'

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
    apiKeyCount: number
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
    priority: string | null
  }[]
  counts: { total: number; done: number; doing: number; testing: number; todo: number }
}

export type MatrixData = {
  project: { id: string; name: string }
  phases: {
    id: string
    name: string
    status: string
    release: { id: string; name: string; demo_status: string } | null
  }[]
  rows: { feature: string; cells: { phaseId: string; status: string }[] }[]
}

export type WorkspaceRoute = {
  projectId: string | null
  phaseId: string | null
  view: 'overview' | 'pipeline' | 'matrix' | 'settings'
  releaseId: string | null
  taskId: string | null
  detail: 'project' | 'release'
}

export function parseWorkspaceRoute(pathname: string): WorkspaceRoute {
  const segs = pathname.split('/').filter(Boolean)
  const route: WorkspaceRoute = {
    projectId: null,
    phaseId: null,
    view: 'overview',
    releaseId: null,
    taskId: null,
    detail: 'project',
  }
  if (segs[0] === 'p' && segs[1]) {
    route.projectId = segs[1]
    if (segs[2] === 'matrix') route.view = 'matrix'
    else if (segs[2] === 'pipeline') route.view = 'pipeline'
    else if (segs[2] === 'settings') route.view = 'settings'
    else if (segs[2] === 'release' && segs[3]) {
      route.releaseId = segs[3]
      route.detail = 'release'
    } else if (segs[2] === 'phase' && segs[3]) {
      route.phaseId = segs[3]
      route.view = 'pipeline'
      if (segs[4] === 'task' && segs[5]) route.taskId = segs[5]
    }
  }
  return route
}

export function workspacePathFor(route: WorkspaceRoute): string {
  if (!route.projectId) return '/'
  if (route.detail === 'release' && route.releaseId)
    return `/p/${route.projectId}/release/${route.releaseId}`
  if (route.view === 'matrix') return `/p/${route.projectId}/matrix`
  if (route.view === 'settings') return `/p/${route.projectId}/settings`
  if (route.view === 'overview') return `/p/${route.projectId}`
  if (route.view === 'pipeline' && !route.phaseId) return `/p/${route.projectId}/pipeline`
  if (route.phaseId)
    return route.taskId
      ? `/p/${route.projectId}/phase/${route.phaseId}/task/${route.taskId}`
      : `/p/${route.projectId}/phase/${route.phaseId}`
  return `/p/${route.projectId}`
}

export function workspaceAncestorKeys(
  route: WorkspaceRoute,
  releasePhaseId: string | null = null,
): string[] {
  const keys: string[] = []
  if (route.projectId) keys.push(`project:${route.projectId}`)
  const phaseId = route.detail === 'release' ? releasePhaseId : route.phaseId
  if (phaseId) keys.push(`phase:${phaseId}`)
  if (route.taskId && route.phaseId) keys.push(`tasks:${route.phaseId}`)
  return keys
}

export type WorkspaceAgent = {
  id: string
  name: string
  harness: string | null
  machine: string | null
  role: string
  currentDoc: string | null
  currentTask: string | null
  freshness: 'live' | 'idle' | 'stale'
}

const STATUS_LABEL: Record<string, string> = {
  shipped: 'shipped',
  'in-progress': 'in progress',
  planned: 'planned',
  none: '—',
}

export function renderFeatureMatrix(matrixData: MatrixData | null): string {
  if (!matrixData) return '<div class="panel"><span class="muted">loading matrix…</span></div>'
  const releaseColumns = matrixData.phases
    .map((phase) => {
      const control = phase.release
        ? '<button type="button" class="ws-matrix-release" data-release="' +
          escapeHtml(phase.release.id) +
          '" aria-label="Open release ' +
          escapeHtml(phase.release.name) +
          '"><span>' +
          escapeHtml(phase.release.name) +
          '</span><span class="status-pill sp-' +
          escapeHtml(phase.release.demo_status) +
          '">' +
          escapeHtml(phase.release.demo_status) +
          '</span></button>'
        : '<span class="ws-matrix-release ws-matrix-no-release">No release</span>'
      return (
        '<th scope="col"><span class="ws-matrix-phase">' +
        escapeHtml(phase.name) +
        '</span>' +
        control +
        '</th>'
      )
    })
    .join('')
  const rows = matrixData.rows.length
    ? matrixData.rows
        .map(
          (row) =>
            '<tr><th scope="row"><b>' +
            escapeHtml(row.feature) +
            '</b></th>' +
            row.cells
              .map((cell) => {
                const statusClass = cell.status === 'none' ? 'todo' : cell.status
                return (
                  '<td data-status="' +
                  escapeHtml(cell.status) +
                  '"><span class="status-pill sp-' +
                  escapeHtml(statusClass) +
                  '">' +
                  escapeHtml(STATUS_LABEL[cell.status] ?? cell.status) +
                  '</span></td>'
                )
              })
              .join('') +
            '</tr>',
        )
        .join('')
    : '<tr><td colspan="' +
      String(matrixData.phases.length + 1) +
      '" class="muted">No feature data yet.</td></tr>'
  return (
    '<div class="ws-matrix-wrap panel" aria-label="Feature status matrix">' +
    '<table class="ws-matrix"><thead><tr><th scope="col">Feature</th>' +
    releaseColumns +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table><div class="muted small">Open a release from its phase column to review its tasks and demo status.</div></div>'
  )
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

export function renderAgentPromptModal(link: string, text: string, kickoff: string): string {
  return `
    <p class="muted small">Give each agent the same kickoff so they can join this project with the shared briefing.</p>
    <div class="ws-modal-field"><span>One-line kickoff</span>
      <textarea readonly rows="2" id="agent-kickoff">${escapeHtml(kickoff)}</textarea></div>
    <div class="ws-modal-field"><span>Markdown URL for agents</span>
      <input readonly value="${escapeHtml(link)}.md" /></div>
    <div class="ws-modal-field"><span>Full briefing</span>
      <textarea readonly rows="9" id="agent-prompt">${escapeHtml(text)}</textarea></div>
    <div class="ws-modal-actions">
      <button type="button" class="btn sm" id="copy-agent-kickoff">Copy kickoff</button>
      <button type="button" class="btn sm" id="copy-agent-prompt">Copy briefing</button>
    </div>`
}

export function renderProjectTreeLabel(
  project: { id: string; name: string; done: number; total: number },
  selected: boolean,
  expanded: boolean,
): string {
  const id = escapeHtml(project.id)
  return `<button class="ws-tree-label ${selected ? 'sel' : ''}" data-project-toggle="${id}" aria-expanded="${expanded}" aria-controls="project-children-${id}">📁 ${escapeHtml(project.name)}
    <span class="ws-count">${project.done}/${project.total}</span></button>`
}

export type WorkspaceNavigationState = {
  projectId: string | null
  phaseId: string | null
  view: 'overview' | 'pipeline' | 'matrix' | 'settings'
  detail: 'project' | 'release'
  releaseId: string | null
  taskId: string | null
}

export function navigateToTreeTask(
  state: WorkspaceNavigationState,
  ownerProjectId: string,
  phaseId: string,
  taskId: string,
): WorkspaceNavigationState {
  return {
    ...state,
    projectId: ownerProjectId,
    phaseId,
    view: 'pipeline',
    detail: 'project',
    releaseId: null,
    taskId,
  }
}

export function navigateToTreeRelease(
  state: WorkspaceNavigationState,
  ownerProjectId: string,
  phaseId: string,
  releaseId: string | null,
): WorkspaceNavigationState {
  return {
    ...state,
    projectId: ownerProjectId,
    phaseId,
    detail: releaseId ? 'release' : 'project',
    releaseId,
    taskId: null,
  }
}

export function shouldReloadProjectMatrix(
  state: Pick<WorkspaceNavigationState, 'projectId' | 'view'>,
  ownerProjectId: string,
): boolean {
  return state.view === 'matrix' && state.projectId !== ownerProjectId
}

export function shouldLoadPhaseBurndown(
  phaseId: string | null,
  cache: ReadonlyMap<string, unknown>,
): boolean {
  return phaseId !== null && !cache.has(phaseId)
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
  const wireCopy = (buttonSelector: string, fieldSelector: string) => {
    const copyBtn = overlay.querySelector(buttonSelector)
    if (!copyBtn) return
    copyBtn.addEventListener('click', async () => {
      const ta = overlay.querySelector(fieldSelector) as HTMLTextAreaElement | null
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
  wireCopy('#copy-agent-kickoff', '#agent-kickoff')
  wireCopy('#copy-agent-prompt', '#agent-prompt')
}

export function agentPresenceStatus(
  agent: WorkspaceAgent,
  tasks: { id: string; title?: string; description?: string | null; blockers: string | null }[],
): 'online' | 'offline' | 'working' | 'blocked' {
  if (agent.freshness === 'stale') return 'offline'
  if (agent.currentTask) {
    const task = findAgentTask(agent.currentTask, tasks)
    return task?.blockers ? 'blocked' : 'working'
  }
  return agent.freshness === 'live' ? 'online' : 'offline'
}

function findAgentTask(
  currentTask: string,
  tasks: { id: string; title?: string; description?: string | null; blockers: string | null }[],
) {
  const normalized = currentTask.trim().toLowerCase()
  return tasks.find(
    (candidate) =>
      candidate.id === currentTask ||
      candidate.title?.trim().toLowerCase() === normalized ||
      candidate.description?.trim().toLowerCase() === normalized,
  )
}

export function renderAgentPresence(
  agents: WorkspaceAgent[],
  tasks: { id: string; title?: string; description?: string | null; blockers: string | null }[],
): string {
  if (!agents.length) return '<span class="muted small">No registered agents yet.</span>'
  return `<div class="ws-agent-list">${agents
    .map((agent) => {
      const status = agentPresenceStatus(agent, tasks)
      const statusClass =
        status === 'online'
          ? 'sp-pass'
          : status === 'working'
            ? 'sp-doing'
            : status === 'blocked'
              ? 'sp-blocked'
              : 'sp-none'
      const task = agent.currentTask ? findAgentTask(agent.currentTask, tasks) : undefined
      return `<div class="ws-agent-row">
        <div class="ws-agent-ident"><b>@${escapeHtml(agent.name)}</b>${agent.role === 'chief' ? '<span class="muted small">chief</span>' : ''}${task || agent.currentTask ? `<span class="muted small">${escapeHtml(task?.title ?? agent.currentTask ?? '')}</span>` : ''}</div>
        <span class="status-pill ${statusClass}">${status}</span>
      </div>`
    })
    .join('')}</div>`
}

export function renderProjectSettingsPanel(project: {
  id: string
  name: string
  description: string | null
  docId: string | null
  docTitle: string | null
  github: { enabled: boolean; repo: string | null; syncEnabled: boolean }
}): string {
  return [
    '<div class="ws-project-settings">',
    '<form class="panel ws-settings-form" id="project-settings-form">',
    '<div><div class="eyebrow">Project settings</div><h3>Project details</h3><p class="muted">Keep the project identity and description current for every agent working here.</p></div>',
    '<label>Name<input id="project-name" name="name" required maxlength="120" value="',
    escapeHtml(project.name),
    '"></label>',
    '<label>Description<textarea id="project-description" name="description" maxlength="500" rows="5">',
    escapeHtml(project.description ?? ''),
    '</textarea></label>',
    '<div class="ws-settings-actions"><button class="btn" type="submit">Save settings</button><span class="muted" id="project-settings-status" role="status"></span></div>',
    '</form>',
    '<div class="ws-project-settings-side">',
    '<section class="panel ws-project-doc"><div class="eyebrow">Project document</div><h3>Working brief</h3>',
    project.docId
      ? '<a href="/d/' +
        encodeURIComponent(project.docId) +
        '">' +
        escapeHtml(project.docTitle ?? 'Open project document') +
        '</a>'
      : '<span class="muted">No project document linked.</span>',
    '<p class="muted">Use the Link docs control above to change the linked document.</p></section>',
    '<section class="panel ws-project-github"><div class="eyebrow">Integrations</div><h3>GitHub Issues sync</h3>',
    project.github.enabled
      ? '<div class="muted">Repository <strong>' +
        escapeHtml(project.github.repo ?? 'configured') +
        '</strong></div><div class="muted">Sync is ' +
        (project.github.syncEnabled ? 'enabled' : 'disabled') +
        '.</div><button class="btn sm" id="sync-github" type="button">Sync now</button><span class="muted" id="sync-result" role="status"></span>'
      : '<label>Repository<input id="gh-repo" placeholder="owner/name"></label><label>Personal access token<input id="gh-token" type="password" autocomplete="off"></label><button class="btn sm" id="enable-github" type="button">Enable GitHub</button>',
    '</section>',
    '<section class="panel ws-project-key"><div class="eyebrow">Automation</div><h3>Project API key</h3><p class="muted">Mint a project-scoped key for automation. The secret is shown once.</p><label>Label<input id="project-key-label" maxlength="80" placeholder="e.g. CI"></label><button class="btn sm" id="mint-project-key" type="button">Mint project key</button><span class="muted" id="project-key-status" role="status"></span><div id="project-key-output" class="ws-project-key-output" hidden></div></section>',
    '</div></div>',
  ].join('')
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
  let view: 'overview' | 'pipeline' | 'matrix' | 'settings' = 'overview'
  let detail: 'project' | 'release' = 'project'
  let releaseId: string | null = null
  let data: ProjectData | null = null
  const projectTreeData = new Map<string, ProjectData>()
  let matrixData: MatrixData | null = null
  let releaseDetail: Awaited<ReturnType<Api['releaseDetail']>> | null = null
  let projectKeys: Awaited<ReturnType<Api['projectKeys']>>['keys'] = []
  let inbox: {
    docId: string
    title: string
    type: string
    message: string
    ts: number
    url?: string
    ref?: string
    projectId?: string
    taskId?: string
    phaseId?: string
  }[] = []
  let taskId: string | null = null
  let taskDetail: Awaited<ReturnType<Api['taskDetail']>> | null = null
  const burndownCache = new Map<string, Awaited<ReturnType<Api['phaseBurndown']>>>()
  const expanded = new Set<string>()
  let chat: {
    docId: string
    lines: { ts: string; name: string; text: string; kind?: string }[]
  } | null = null
  let agents: WorkspaceAgent[] = []
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
  const projectChevron = (id: string) => {
    const key = `project:${id}`
    return `<button class="ws-chev" data-project-toggle="${escapeHtml(id)}" aria-expanded="${isOpen(key)}" aria-controls="project-children-${escapeHtml(id)}" aria-label="toggle">${isOpen(key) ? '▾' : '▸'}</button>`
  }

  const parseRoute = () => parseWorkspaceRoute(location.pathname)

  const urlFor = () => workspacePathFor({ projectId, phaseId, view, releaseId, taskId, detail })

  const syncExpanded = () => {
    const route: WorkspaceRoute = { projectId, phaseId, view, releaseId, taskId, detail }
    for (const key of workspaceAncestorKeys(route, releaseDetail?.phase.id ?? null)) {
      expanded.add(key)
    }
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

  const loadProjectData = async (id: string): Promise<ProjectData> => {
    const project = await api.project(id)
    projectTreeData.set(id, project)
    return project
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

  const loadAgents = async () => {
    if (!me) {
      agents = []
      return
    }
    try {
      agents = (await api.agents()).agents
    } catch {
      agents = []
    }
  }

  const loadPhaseBurndown = async (id: string | null) => {
    if (!id || !shouldLoadPhaseBurndown(id, burndownCache)) return
    burndownCache.set(id, await api.phaseBurndown(id))
  }

  const loadProject = async () => {
    if (!projectId) return
    data = await loadProjectData(projectId)
    try {
      projectKeys = (await api.projectKeys(projectId)).keys
    } catch {
      projectKeys = []
    }
    if (view === 'matrix') matrixData = await api.matrix(projectId)
    await loadPhaseBurndown(phaseId)
    await loadAgents()
    await loadChat()
  }

  const refreshAgents = async () => {
    const refreshingProject = projectId
    if (!refreshingProject || !data) return
    await loadAgents()
    if (projectId === refreshingProject) render()
  }

  const toggleProject = async (id: string) => {
    const key = `project:${id}`
    if (expanded.has(key)) {
      expanded.delete(key)
      render()
      return
    }
    if (!projectTreeData.has(id)) await loadProjectData(id)
    expanded.add(key)
    render()
  }

  const goHome = () => {
    projectId = null
    phaseId = null
    releaseId = null
    taskId = null
    taskDetail = null
    releaseDetail = null
    data = null
    projectKeys = []
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
    releaseDetail = null
    detail = 'project'
    view = 'overview'
    taskId = null
    taskDetail = null
    projectKeys = []
    await loadProject()
    syncExpanded()
    syncUrl()
    render()
  }

  const selectPhase = async (id: string, ownerProjectId = projectId) => {
    if (ownerProjectId) projectId = ownerProjectId
    phaseId = id
    releaseId = null
    releaseDetail = null
    detail = 'project'
    view = 'pipeline'
    taskId = null
    taskDetail = null
    await loadProject()
    syncExpanded()
    syncUrl()
    render()
  }

  const clearPhase = () => {
    phaseId = null
    detail = 'project'
    syncUrl()
    render()
  }

  const openTask = async (id: string, ownerProjectId = projectId) => {
    if (!ownerProjectId) return
    taskDetail = await api.taskDetail(id)
    const next = navigateToTreeTask(
      { projectId, phaseId, view, detail, releaseId, taskId },
      ownerProjectId,
      taskDetail.phase.id,
      id,
    )
    projectId = next.projectId
    phaseId = next.phaseId
    view = next.view
    detail = next.detail
    releaseId = next.releaseId
    taskId = next.taskId
    await loadProject()
    syncExpanded()
    syncUrl()
    render()
  }

  const closeTask = () => {
    taskId = null
    taskDetail = null
    syncUrl()
    render()
  }

  const openRelease = async (id: string, ownerProjectId = projectId) => {
    const reloadMatrix = ownerProjectId
      ? shouldReloadProjectMatrix({ projectId, view }, ownerProjectId)
      : false
    if (ownerProjectId) projectId = ownerProjectId
    if (ownerProjectId && data?.project.id !== ownerProjectId) {
      data = await loadProjectData(ownerProjectId)
      await loadChat()
    }
    if (reloadMatrix && ownerProjectId) matrixData = await api.matrix(ownerProjectId)
    releaseDetail = await api.releaseDetail(id)
    if (projectId && releaseDetail) {
      const next = navigateToTreeRelease(
        { projectId, phaseId, view, detail, releaseId, taskId },
        projectId,
        releaseDetail.phase.id,
        id,
      )
      projectId = next.projectId
      phaseId = next.phaseId
      view = next.view
      detail = next.detail
      releaseId = next.releaseId
      taskId = next.taskId
      taskDetail = null
      await loadPhaseBurndown(phaseId)
      expanded.add(`project:${projectId}`)
      expanded.add(`phase:${phaseId}`)
    }
    syncUrl()
    render()
  }

  const setView = async (v: 'overview' | 'pipeline' | 'matrix' | 'settings') => {
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
          <span class="product-tagline muted small">Multi-Agent Canvas</span>
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
                    const pd =
                      projectTreeData.get(p.id) ?? (data?.project.id === p.id ? data : null)
                    return `
                  <div class="ws-tree-node">
                    <div class="ws-tree-row">
                      ${projectChevron(p.id)}
                      ${renderProjectTreeLabel(p, p.id === projectId, isOpen(pk))}
                    </div>
                    ${
                      isOpen(pk)
                        ? `<div id="project-children-${escapeHtml(p.id)}" class="ws-tree-children">
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
                                  <button class="ws-tree-label ${ph.id === phaseId ? 'sel' : ''}" data-phase="${ph.id}" data-phase-project="${escapeHtml(p.id)}">◈ ${escapeHtml(ph.name)}
                                    <span class="ws-count">${ph.counts.done}/${ph.counts.total}</span></button>
                                </div>
                                ${
                                  isOpen(phk)
                                    ? `<div class="ws-tree-children">
                                        ${phaseReleases
                                          .map(
                                            (rl) =>
                                              `<button class="ws-tree-leaf" data-tree-release="${rl.id}" data-release-project="${escapeHtml(p.id)}" data-release-phase="${rl.phaseId}">🚀 ${escapeHtml(rl.name)} <span class="status-pill sp-${rl.demo_status}">${rl.demo_status}</span></button>`,
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
                                                      `<button class="ws-tree-leaf" data-open-task="${t.id}" data-task-project="${escapeHtml(p.id)}"><span class="dot ws-${t.status}"></span>${escapeHtml(t.title)}</button>`,
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
        <a class="btn sm" href="/settings">Settings</a>
        <button class="btn sm" id="logout">Log out</button>`
    }
    return `<button class="btn sm" id="signup-btn">Create account</button>
      <button class="btn sm" id="login-btn">Sign in</button>`
  }

  const renderInbox = () => `
    <div class="ws-inbox panel">
      <h3>Needs human attention${inbox.length ? ` <span class="col-count">${inbox.length}</span>` : ''}</h3>
      ${
        inbox.length
          ? inbox
              .slice(0, 20)
              .map(
                (i, idx) =>
                  `<button class="ws-inbox-item" data-inbox-item="${idx}" title="open actions">
                     <span class="ws-inbox-title">${escapeHtml(i.title)}${i.url ? ' ↗' : ''}</span>
                     <span class="tag">${escapeHtml(i.type)}</span>
                     <div class="muted small">${escapeHtml(i.message.slice(0, 90))}</div>
                   </button>`,
              )
              .join('')
          : '<span class="muted small">Nothing needs you right now.</span>'
      }
    </div>`

  const wireInboxItems = () => {
    root.querySelectorAll<HTMLButtonElement>('[data-inbox-item]').forEach((b) => {
      b.addEventListener('click', () => {
        const item = inbox[Number(b.dataset.inboxItem)]
        if (item) openAttentionModal(item)
      })
    })
  }

  const openAttentionModal = (item: {
    docId: string
    title: string
    type: string
    message: string
    url?: string
    ref?: string
    projectId?: string
    taskId?: string
    phaseId?: string
  }) => {
    const openHref =
      item.type === 'pr'
        ? null
        : item.projectId && item.taskId && item.phaseId
          ? `/p/${item.projectId}/phase/${item.phaseId}/task/${item.taskId}`
          : item.projectId
            ? `/p/${item.projectId}`
            : `/d/${item.docId}`
    const openLabel = item.projectId && item.taskId ? 'Open task' : 'Open doc'
    const overlay = document.createElement('div')
    overlay.className = 'ws-modal-overlay'
    overlay.innerHTML = `
      <div class="ws-modal" role="dialog" aria-modal="true" aria-label="Attention">
        <div class="ws-modal-head"><b>${escapeHtml(item.title)}</b><button type="button" class="btn sm" data-close>×</button></div>
        <div class="ws-modal-body">
          <div class="muted small"><span class="tag">${escapeHtml(item.type)}</span> · ${escapeHtml(item.message)}</div>
          <div class="ws-modal-actions">
            ${item.url ? `<button type="button" class="btn primary" id="att-open">Open ↗</button>` : ''}
            ${item.type !== 'pr' && openHref ? `<a class="btn" href="${escapeHtml(openHref)}">${openLabel}</a>` : ''}
            <button type="button" class="btn" id="att-dismiss">Dismiss</button>
            <button type="button" class="btn" data-close>Close</button>
          </div>
        </div>
      </div>`
    document.body.appendChild(overlay)
    const close = () => overlay.remove()
    overlay.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close()
    })
    const openBtn = overlay.querySelector('#att-open')
    if (openBtn && item.url) {
      openBtn.addEventListener('click', () => {
        window.open(item.url, '_blank', 'noopener')
        close()
      })
    }
    const dismissBtn = overlay.querySelector('#att-dismiss')
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        void api.dismissInbox({ docId: item.docId, type: item.type, ref: item.ref }).then(() => {
          close()
          return refreshInbox()
        })
      })
    }
  }

  const refreshInbox = async () => {
    if (!me) return
    try {
      inbox = (await api.inbox()).items
    } catch {
      return
    }
    const el = root.querySelector('.ws-inbox')
    if (el) {
      el.outerHTML = renderInbox()
      wireInboxItems()
    }
  }

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
    if (taskId && taskDetail) return renderTaskDetail()
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
          <button class="ws-tab ${view === 'settings' ? 'on' : ''}" data-view="settings">Settings</button>
        </div>
        <button class="btn sm" id="link-project-doc">Link docs</button>
      </div>
      <div class="ws-project-body">
        ${view === 'overview' ? renderOverview() : view === 'pipeline' ? renderPipeline(phase, phaseTasks) : view === 'settings' ? renderProjectSettingsPanel(data.project) : renderMatrix()}
      </div>`
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
        <div class="panel ws-burndown-top">
          ${renderBurndown(phase)}
        </div>
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
                       <span class="card-meta">${t.priority ? `<span class="chip priority-${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span>` : ''}${releaseByPhase.get(t.phaseId) ? `<span class="chip release">🚀 ${escapeHtml(releaseByPhase.get(t.phaseId)!)}</span>` : ''}${t.assignee ? `<span class="chip assignee">@${escapeHtml(t.assignee)}</span>` : ''}${t.feature ? `<span class="chip tag">${escapeHtml(t.feature)}</span>` : ''}</span>
                     </div>`,
                )
                .join('')}
            </div>`,
            )
            .join('')}
        </div>
        <div class="ws-right">
          ${renderAgentsPanel()}
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
            ${renderProjectKeys()}
            ${renderAgents()}
            ${data!.project.docId ? `<div class="panel"><h3>Project doc</h3><a class="btn sm" href="/d/${encodeURIComponent(data!.project.docId)}">Open · ${escapeHtml(data!.project.docTitle ?? 'project doc')}</a></div>` : ''}
          </div>
          <div class="ws-overview-right">${renderAgentsPanel()}</div>
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
        <div class="panel marketplace-dashboard-card">
          <h3>Marketplace</h3>
          <p class="muted small">Browse reusable widgets and templates for your next project.</p>
          <div class="ws-modal-actions">
            <a class="btn sm" href="/marketplace/widgets">Browse widgets</a>
            <a class="btn sm" href="/marketplace/templates">Browse templates</a>
          </div>
        </div>
      </div>
    </div>`

  const renderChat = () => {
    if (!chat) {
      return `<div class="panel"><h3>Chat</h3><span class="muted small">Link a project doc containing a \`\`\`chat fence to enable chat.</span></div>`
    }
    return `
      <div class="panel ws-chat">
        <h3>Chat</h3>
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

  const renderAgentsPanel = () => `
    <div class="panel ws-agents-panel">
      <h3>AGENTS</h3>
      ${renderAgentPresence(agents, data!.tasks)}
    </div>
    ${renderChat()}`

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

  const renderProjectKeys = () => {
    const count = data!.project.apiKeyCount
    const keyRows = projectKeys.length
      ? projectKeys
          .map(
            (key) =>
              `<div class="muted small"><code>${escapeHtml(key.id)}</code>${key.label ? ` · ${escapeHtml(key.label)}` : ''}${key.revoked_at ? ' · revoked' : ` <button class="btn sm" data-revoke-project-key="${escapeHtml(key.id)}">Revoke</button>`}</div>`,
          )
          .join('')
      : '<div class="muted small">No project keys minted yet.</div>'
    return `<div class="panel"><h3>Project settings</h3>
      <div class="muted small">Mint a project-scoped API key for agents. It can read and update this project's workspace, but cannot access account routes or other projects.</div>
      <div class="ws-modal-actions" style="margin-top:6px"><button class="btn sm" id="mint-project-key">Mint project API key</button><span class="muted small">${count} active key${count === 1 ? '' : 's'}</span></div>
      <div style="margin-top:6px">${keyRows}</div>
      <div class="muted small">The secret is shown once after minting. Store it as <code>Authorization: Bearer pk_...</code>.</div>
    </div>`
  }

  const renderAgents = () => {
    if (!data!.project.docId) {
      return `<div class="panel"><h3>Agent onboarding</h3>
        <span class="muted small">This project has no linked doc yet.</span>
        <button class="btn sm" id="create-project-hq">Create HQ doc + prompt</button></div>`
    }
    return `<div class="panel"><h3>Agent onboarding</h3>
      <span class="muted small">Open a ready-to-paste kickoff, markdown link, and full briefing for a new agent.</span>
      <button class="btn sm primary" id="onboard-agent">Onboard Agent</button>
      ${agentPrompt ? '<div class="muted small">Prompt link ready for this project.</div>' : ''}
      <div class="ws-modal-actions" style="margin-top:6px"><button class="btn sm" id="add-agent-briefing">Add AGENTS briefing to project doc</button></div>
      <div class="muted small">Paste the same prompt into each Codex instance — they self-assign roles (one agent per role).</div></div>`
  }

  const renderMatrix = () => renderFeatureMatrix(matrixData)

  const renderBurndown = (phase: Phase | null) => {
    const b = phase ? burndownCache.get(phase.id) : undefined
    const counts = phase ? phase.counts : { done: data!.counts.done, total: data!.counts.total }
    const pct = counts.total ? Math.round((counts.done / counts.total) * 100) : 0
    const heading = `<div class="ws-burndown-top-head"><h3>Burndown${phase ? ` · ${escapeHtml(phase.name)}` : ' · all phases'}</h3></div>`
    const bar = `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`
    const summary = `<div class="muted small">${counts.done}/${counts.total} tasks done (${pct}%)${phase ? '' : ' · all phases'}</div>`
    if (!b || !b.points || b.points.length < 2)
      return `<div class="ws-burndown-top-row">${heading}${summary}</div>${bar}`
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
      <div class="ws-burndown-top-row">${heading}${summary}</div>
      ${bar}
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="Burndown: remaining tasks over time">
        <polyline points="${coords}" fill="none" stroke="#12b76a" stroke-width="2" />
      </svg>
      <div class="muted small">${b.current} remaining of ${b.total} · ${pts[0]?.date} → ${pts[pts.length - 1]?.date}</div>`
  }

  const renderTaskDetail = () => {
    const t = taskDetail
    if (!t) return '<span class="muted">loading…</span>'
    const release = data?.releases.find((r) => r.phaseId === t.phase.id) ?? null
    const specSections: [string, string | null][] = [
      ['Acceptance criteria', t.task.acceptance],
      ['Context', t.task.context],
      ['Done means', t.task.done_means],
      ['Description', t.task.description],
      ['Blockers', t.task.blockers],
    ]
    return `
      <div class="ws-task-detail panel">
        <button class="btn sm" data-close-task>← Back</button>
        <h2>${escapeHtml(t.task.title)}</h2>
        <div class="ws-task-meta">
          <span class="chip">${escapeHtml(t.task.status)}</span>
          ${t.task.priority ? `<span class="chip priority-${escapeHtml(t.task.priority)}">${escapeHtml(t.task.priority)}</span>` : ''}
          ${t.task.assignee ? `<span class="chip assignee">@${escapeHtml(t.task.assignee)}</span>` : ''}
          ${t.task.feature ? `<span class="chip tag">${escapeHtml(t.task.feature)}</span>` : ''}
          <span class="muted small">${escapeHtml(t.project.name)} · ${escapeHtml(t.phase.name)}${release ? ` · 🚀 ${escapeHtml(release.name)}` : ''}</span>
        </div>
        <div class="ws-task-actions">
          <span class="muted small">Status</span>
          ${['todo', 'doing', 'testing', 'done']
            .map(
              (s) =>
                `<button class="btn sm ${t.task.status === s ? 'primary' : ''}" data-set-status="${s}">${s}</button>`,
            )
            .join('')}
        </div>
        <div class="ws-task-body">
          ${
            specSections
              .filter(([, v]) => v)
              .map(
                ([label, v]) => `
                <section class="ws-field">
                  <h4>${label}</h4>
                  <div class="markdown-body">${renderMarkdown(v!)}</div>
                </section>`,
              )
              .join('') ||
            '<p class="muted">No spec written yet. Add acceptance criteria so agents know what “done” means.</p>'
          }
          <section class="ws-field">
            <h4>Linked doc</h4>
            ${t.task.docId ? `<a class="btn sm" href="/d/${encodeURIComponent(t.task.docId)}">Open doc · ${escapeHtml(t.task.docTitle ?? 'linked')}</a>` : '<span class="muted">None linked</span>'}
          </section>
        </div>
        <div class="ws-drawer-actions">
          <button class="btn sm" data-link-task-doc>${t.task.docId ? 'Change doc' : 'Link doc'}</button>
          <button class="btn sm" data-edit-task="title">Rename</button>
          <button class="btn sm" data-edit-task="assignee">Assignee</button>
          <button class="btn sm" data-edit-task="feature">Feature</button>
          <button class="btn sm" data-edit-task="priority">Priority</button>
          <button class="btn sm" data-edit-task="done_means">Done means</button>
          <button class="btn sm" data-edit-task="acceptance">Acceptance</button>
          <button class="btn sm" data-edit-task="context">Context</button>
          <button class="btn sm" data-edit-task="description">Description</button>
          <button class="btn sm" data-edit-task="blockers">Blockers</button>
        </div>
      </div>
    `
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
    document.querySelectorAll<HTMLButtonElement>('[data-project-toggle]').forEach((b) => {
      b.addEventListener('click', () => void toggleProject(b.dataset.projectToggle!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-project]').forEach((b) => {
      b.addEventListener('click', () => void selectProject(b.dataset.project!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => {
      b.addEventListener('click', () => toggle(b.dataset.toggle!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-phase]').forEach((b) => {
      b.addEventListener('click', () => {
        const ownerProjectId = b.dataset.phaseProject ?? projectId
        if (ownerProjectId) void selectPhase(b.dataset.phase!, ownerProjectId)
      })
    })
    document.querySelectorAll<HTMLButtonElement>('[data-release]').forEach((b) => {
      b.addEventListener('click', () => void openRelease(b.dataset.release!))
    })
    document.querySelectorAll<HTMLButtonElement>('[data-tree-release]').forEach((b) => {
      b.addEventListener('click', () => {
        const ownerProjectId = b.dataset.releaseProject ?? projectId
        if (view === 'pipeline') {
          void (async () => {
            if (ownerProjectId) {
              projectId = ownerProjectId
              if (data?.project.id !== ownerProjectId) {
                data = await loadProjectData(ownerProjectId)
                await loadChat()
              }
            }
            const targetPhaseId = b.dataset.releasePhase
            if (projectId && targetPhaseId) {
              const next = navigateToTreeRelease(
                { projectId, phaseId, view, detail, releaseId, taskId },
                projectId,
                targetPhaseId,
                null,
              )
              projectId = next.projectId
              phaseId = next.phaseId
              view = next.view
              detail = next.detail
              releaseId = next.releaseId
              taskId = next.taskId
              taskDetail = null
              releaseDetail = null
              await loadPhaseBurndown(phaseId)
              expanded.add(`project:${projectId}`)
              expanded.add(`phase:${phaseId}`)
            }
            syncUrl()
            render()
          })()
        } else {
          if (ownerProjectId) void openRelease(b.dataset.treeRelease!, ownerProjectId)
        }
      })
    })
    document.querySelectorAll<HTMLButtonElement>('[data-clear-phase]').forEach((b) => {
      b.addEventListener('click', () => clearPhase())
    })
    document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      b.addEventListener(
        'click',
        () => void setView(b.dataset.view as 'overview' | 'pipeline' | 'matrix' | 'settings'),
      )
    })
    document
      .querySelector<HTMLFormElement>('#project-settings-form')
      ?.addEventListener('submit', (event) => {
        event.preventDefault()
        void saveProjectSettings()
      })
    document
      .querySelector<HTMLButtonElement>('#mint-project-key')
      ?.addEventListener('click', () => void mintProjectKey())
    document.querySelectorAll<HTMLButtonElement>('[data-open-task]').forEach((b) => {
      b.addEventListener('click', () => {
        const ownerProjectId = b.dataset.taskProject ?? projectId
        if (ownerProjectId) void openTask(b.dataset.openTask!, ownerProjectId)
      })
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
      .getElementById('mint-project-key')
      ?.addEventListener('click', () => void mintProjectKey())
    document.querySelectorAll<HTMLButtonElement>('[data-revoke-project-key]').forEach((button) => {
      button.addEventListener(
        'click',
        () => void revokeProjectKey(button.dataset.revokeProjectKey!),
      )
    })
    document.getElementById('onboard-agent')?.addEventListener('click', () => void onboardAgent())
    document
      .getElementById('create-project-hq')
      ?.addEventListener('click', () => void createProjectHq())
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
    wireInboxItems()
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
        const s = await api.share((res.project as { docId?: string }).docId ?? '', 'edit')
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

  const mintProjectKey = async () => {
    if (!projectId) return
    const labelInput = document.getElementById('project-key-label') as HTMLInputElement | null
    const status = document.getElementById('project-key-status')
    const output = document.getElementById('project-key-output')
    let label = labelInput?.value.trim() ?? ''
    if (!labelInput) {
      const asked = prompt('Optional project key label:', 'agent')
      if (asked === null) return
      label = asked.trim()
    }
    try {
      const result = await api.createProjectKey(projectId, label || undefined)
      await loadProject()
      render()
      if (output && status) {
        output.hidden = false
        output.innerHTML =
          '<strong>New project key (shown once)</strong><code>' + escapeHtml(result.key) + '</code>'
        status.textContent = 'Store this secret securely before leaving the page.'
      } else {
        openInfoModal(
          'Project API key',
          `<p>Copy this key now. It will not be shown again.</p>
           <div class="ws-modal-field"><span>Authorization header</span><textarea readonly rows="2">Bearer ${escapeHtml(result.key)}</textarea></div>
           <p class="muted small">This key is scoped to <b>${escapeHtml(data?.project.name ?? 'this project')}</b>. Keep it out of source control and chat logs.</p>`,
        )
      }
    } catch (e) {
      alert(`Project key mint failed: ${(e as Error).message}`)
    }
  }

  const revokeProjectKey = async (keyId: string) => {
    if (!projectId || !confirm('Revoke this project key? Agents using it will lose access.')) return
    try {
      await api.revokeProjectKey(projectId, keyId)
      await loadProject()
      render()
    } catch (e) {
      alert(`Project key revoke failed: ${(e as Error).message}`)
    }
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

  const saveProjectSettings = async () => {
    if (!projectId) return
    const name =
      (document.getElementById('project-name') as HTMLInputElement | null)?.value.trim() ?? ''
    const description =
      (
        document.getElementById('project-description') as HTMLTextAreaElement | null
      )?.value.trim() ?? ''
    const status = document.getElementById('project-settings-status')
    if (!name) {
      if (status) status.textContent = 'Name is required.'
      return
    }
    try {
      await api.patchProject(projectId, { name, description: description || null })
      await loadProject()
      render()
    } catch (e) {
      if (status) status.textContent = 'Save failed: ' + (e as Error).message
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
7. Build in your own git worktree — git worktree add ../can-bang-<role> -b <role>/<card>; never commit on main. Once your PR is pushed, remove the worktree (git worktree remove ../can-bang-<role>) — never leave worktrees behind. Use Conventional Commits (feat:/fix:/refactor:/docs:/chore:/test:), one logical change per commit, never commit secrets, and never claim evidence you did not run.
8. Open one PR per card against main when it is complete: title = the commit subject, body = what/why/evidence + card reference, ready for review (not draft). Never approve or merge your own PR — that is the human's call. Move the card to Testing and add the PR link as evidence.
9. Fetch the helper skills over HTTP and follow them: GET /skills/commit-helper/manifest?v=1 and /skills/pr-helper/manifest?v=1 — verify each sha256, read every file, and do not install them into your config.
10. Loop, and ask only when you must: never pause after one card — pull the next. Do not ask for permission for in-scope work. When a human decision is genuinely required, create an ASK (POST /api/docs/<id>/asks with the decision) or set status awaiting-human with a plain note, then continue on other cards; the human acts on the Needs Human Attention queue.
11. Start each task with a cleared context: when you claim a card, close the previous task's context, create a fresh worktree for the card, and re-read the card, its done-means, and the current repo state from scratch. Do not carry assumptions or partial work from earlier tasks.

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

  const onboardAgent = async () => {
    if (!data?.project.docId) return
    if (!agentPrompt) {
      const s = await api.share(data.project.docId, 'edit')
      agentPrompt = { link: s.share.url, text: buildAgentPrompt(s.share.url) }
    }
    const kickoff = `Read ${location.origin}/agents.md, then work the project doc at ${agentPrompt.link} — follow AGENTS: READ THIS FIRST.`
    openInfoModal(
      'Onboard Agent',
      renderAgentPromptModal(agentPrompt.link, agentPrompt.text, kickoff),
    )
  }

  const createProjectHq = async () => {
    if (!projectId) return
    const name = data?.project.name ?? 'Project'
    const doc = await api.createOwnedDoc(`${name} — HQ`, hqContent(name))
    await api.patchProject(projectId, { doc_id: doc.id })
    const s = await api.share(doc.id, 'edit')
    agentPrompt = { link: s.share.url, text: buildAgentPrompt(s.share.url) }
    await loadProject()
    render()
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
  setInterval(() => void refreshInbox(), 60_000)
  if (projectId) {
    await loadProject()
    if (detail === 'release' && releaseId) releaseDetail = await api.releaseDetail(releaseId)
    if (taskId) {
      taskDetail = await api.taskDetail(taskId)
      phaseId = taskDetail.phase.id
      await loadProject()
    }
  }
  syncExpanded()
  render()
  window.setInterval(() => void refreshAgents(), 30_000)

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
    syncExpanded()
    render()
  })
}

function nameHue(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}
