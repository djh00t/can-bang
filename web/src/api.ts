export interface DocMeta {
  id: string
  title: string
  kind: 'live' | 'plain'
  role: string
  status_state: string | null
  updated_at: number
  folderId: string | null
  unclaimed?: boolean
}

export class Api {
  constructor(public base = '') {}

  private async request(
    path: string,
    opts: RequestInit = {},
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers = new Headers(opts.headers)
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value)
    if (opts.body && typeof opts.body === 'string') headers.set('content-type', 'application/json')
    const res = await fetch(`${this.base}${path}`, { ...opts, headers })
    if (!res.ok) {
      let body: Record<string, unknown> = {}
      try {
        body = await res.json()
      } catch {
        /* ignore */
      }
      const err = new Error(String(body.error ?? `HTTP ${res.status}`)) as Error & {
        status?: number
        body?: Record<string, unknown>
      }
      err.status = res.status
      err.body = body
      throw err
    }
    return res
  }

  async createDoc(
    key: string,
    title?: string,
    content?: string,
  ): Promise<{ url: string; id: string; key: string }> {
    const res = await this.request('/new', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
      headers: { 'x-share-key': key },
    })
    return res.json()
  }

  async createOwnedDoc(title?: string, content?: string): Promise<{ url: string; id: string }> {
    const res = await this.request('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title, content }),
    })
    const body = (await res.json()) as { doc: { id: string; url: string } }
    return { id: body.doc.id, url: body.doc.url }
  }

  async readDoc(
    id: string,
    key: string,
  ): Promise<{ content: string; version: string; unclaimed?: boolean }> {
    const res = await fetch(`${this.base}/api/docs/${id}/content`, {
      headers: { 'x-share-key': key, accept: 'text/markdown' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return {
      content: await res.text(),
      version:
        res.headers.get('x-doc-version') ?? res.headers.get('etag')?.replace(/^"|"$/g, '') ?? '',
      unclaimed: Boolean(res.headers.get('x-workbench-unclaimed')),
    }
  }

  async writeDoc(
    id: string,
    key: string,
    content: string,
    baseVersion: string,
    label?: string,
  ): Promise<string> {
    const res = await this.request(
      `/api/docs/${id}/content`,
      {
        method: 'PUT',
        body: JSON.stringify({ content, ...(label ? { label } : {}) }),
        headers: baseVersion ? { 'if-match': baseVersion } : {},
      },
      { 'x-share-key': key },
    )
    const body = await res.json()
    return body.version as string
  }

  async meta(id: string, key: string): Promise<DocMeta> {
    const res = await this.request(`/api/docs/${id}`, {}, { 'x-share-key': key })
    return res.json()
  }

  async claimDoc(id: string, key: string): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/claim`,
      { method: 'POST', body: '{}' },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async chat(
    id: string,
    key: string,
    text: string,
    fence?: string,
    author?: string,
  ): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/chat/message`,
      {
        method: 'POST',
        body: JSON.stringify({ text, ...(fence ? { fence } : {}), ...(author ? { author } : {}) }),
      },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async setStatus(
    id: string,
    key: string,
    state: string,
    note?: string,
    headline?: string,
  ): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/status`,
      {
        method: 'POST',
        body: JSON.stringify({
          state,
          ...(note ? { note } : {}),
          ...(headline ? { headline } : {}),
        }),
      },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async comments(
    id: string,
    key: string,
  ): Promise<{ comments: unknown[]; suggestions: unknown[] }> {
    const res = await this.request(`/api/docs/${id}/comments`, {}, { 'x-share-key': key })
    return res.json()
  }

  async addComment(id: string, key: string, body: string, find?: string): Promise<{ id: string }> {
    const res = await this.request(
      `/api/docs/${id}/comments`,
      { method: 'POST', body: JSON.stringify({ body, ...(find ? { find } : {}) }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async suggestionAction(
    id: string,
    key: string,
    sid: string,
    action: 'accept' | 'reject',
  ): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/suggestions/${sid}`,
      { method: 'POST', body: JSON.stringify({ action }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async revisions(
    id: string,
    key: string,
  ): Promise<{
    revisions: { id: string; label: string | null; author: string; created_at: number }[]
  }> {
    const res = await this.request(`/api/docs/${id}/revisions`, {}, { 'x-share-key': key })
    return res.json()
  }

  async restore(id: string, key: string, revision: string): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/restore`,
      { method: 'POST', body: JSON.stringify({ revision }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async asks(id: string, key: string): Promise<{ asks: Record<string, unknown>[] }> {
    const res = await this.request(`/api/docs/${id}/asks`, {}, { 'x-share-key': key })
    return res.json()
  }

  async createAsk(id: string, key: string, text: string): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/asks`,
      { method: 'POST', body: JSON.stringify({ text }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async claimAsk(id: string, key: string, askId: string, agent: string): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/asks/${askId}/claim`,
      { method: 'POST', body: JSON.stringify({ agent }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async resolveAsk(id: string, key: string, askId: string, note?: string): Promise<unknown> {
    const res = await this.request(
      `/api/docs/${id}/asks/${askId}/resolve`,
      { method: 'POST', body: JSON.stringify({ ...(note ? { note } : {}) }) },
      { 'x-share-key': key },
    )
    return res.json()
  }

  async events(
    id: string,
    key: string,
    since: number | 'latest',
    wait = 0,
    mention?: string,
  ): Promise<{
    events: {
      seq: number
      type: string
      ts: number
      actor: string
      payload: Record<string, unknown>
    }[]
    latest: number
    typing?: string[]
  }> {
    const q = new URLSearchParams({ since: String(since), wait: String(wait) })
    if (mention) q.set('mention', mention)
    const res = await this.request(`/api/docs/${id}/events?${q}`, {}, { 'x-share-key': key })
    return res.json()
  }

  async me(): Promise<{ user: { username: string; agent_name: string | null } } | null> {
    try {
      const res = await this.request('/api/me')
      return res.json()
    } catch {
      return null
    }
  }

  async login(username: string, password: string): Promise<void> {
    await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async signup(username: string, password: string): Promise<void> {
    await this.request('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  }

  async logout(): Promise<void> {
    await this.request('/api/auth/logout', { method: 'POST', body: '{}' })
  }

  async listDocs(): Promise<{ docs: Record<string, unknown>[] }> {
    const res = await this.request('/api/docs')
    return res.json()
  }

  async folders(): Promise<{ folders: Record<string, unknown>[] }> {
    const res = await this.request('/api/folders')
    return res.json()
  }

  async skills(): Promise<{
    skills: { slug: string; name: string; category: string; installs: number }[]
  }> {
    const res = await this.request('/api/skills')
    return res.json()
  }

  async moveDoc(id: string, folderId: string | null): Promise<unknown> {
    const res = await this.request(`/api/docs/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ folderId }),
    })
    return res.json()
  }

  async inbox(): Promise<{
    items: {
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
    }[]
  }> {
    const res = await this.request('/api/inbox')
    return res.json()
  }

  async dismissInbox(body: {
    docId: string
    type: string
    ref?: string
  }): Promise<{ ok: boolean }> {
    const res = await this.request('/api/inbox/dismiss', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return res.json()
  }

  async tokens(): Promise<{ tokens: { id: string; label: string | null }[] }> {
    const res = await this.request('/api/tokens')
    return res.json()
  }

  async createToken(): Promise<{ id: string; token: string }> {
    const res = await this.request('/api/tokens', { method: 'POST', body: JSON.stringify({}) })
    return res.json()
  }

  async createProjectKey(
    projectId: string,
    label?: string,
  ): Promise<{ key: string; label: string | null }> {
    const res = await this.request(`/api/projects/${projectId}/api-keys`, {
      method: 'POST',
      body: JSON.stringify(label ? { label } : {}),
    })
    return res.json()
  }

  async projectKeys(projectId: string): Promise<{
    keys: { id: string; label: string | null; created_at: number; revoked_at: number | null }[]
  }> {
    const res = await this.request(`/api/projects/${projectId}/api-keys`)
    return res.json()
  }

  async revokeProjectKey(projectId: string, keyId: string): Promise<{ ok: boolean }> {
    const res = await this.request(`/api/projects/${projectId}/api-keys/${keyId}`, {
      method: 'DELETE',
    })
    return res.json()
  }

  async agentName(name: string): Promise<void> {
    await this.request('/api/me/agent-name', { method: 'POST', body: JSON.stringify({ name }) })
  }

  async templates(): Promise<{
    templates: {
      slug: string
      title: string
      description: string | null
      category: string | null
      builtin?: boolean
      scope?: string
    }[]
  }> {
    const res = await this.request('/api/templates')
    return res.json()
  }

  async uploadAsset(
    id: string,
    key: string,
    bytes: Blob,
    ctype: string,
    name?: string,
  ): Promise<{ url: string; markdown: string; kind: string }> {
    const res = await fetch(`${this.base}/api/docs/${id}/assets?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': ctype, ...(name ? { 'x-asset-name': name } : {}) },
      body: bytes,
    })
    if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`)
    return res.json()
  }

  async projects(): Promise<{
    projects: {
      id: string
      name: string
      description: string | null
      phaseCount: number
      releaseCount: number
      total: number
      done: number
    }[]
  }> {
    const res = await this.request('/api/projects')
    return res.json()
  }

  async createProject(
    name: string,
    description?: string,
  ): Promise<{ project: { id: string; name: string; docId: string } }> {
    const res = await this.request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    })
    return res.json()
  }

  async patchGithub(
    projectId: string,
    patch: { enabled?: boolean; repo?: string; token?: string },
  ): Promise<{ ok: boolean; enabled: boolean; repo: string | null; tokenSet: boolean }> {
    const res = await this.request(`/api/projects/${projectId}/github`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  async syncGithub(projectId: string): Promise<{
    ok: boolean
    created: number
    updated: number
    closed: number
    imported: number
    prs: number
  }> {
    const res = await this.request(`/api/projects/${projectId}/sync-github`, {
      method: 'POST',
      body: '{}',
    })
    return res.json()
  }

  async share(id: string, role: string): Promise<{ share: { url: string } }> {
    const res = await this.request(`/api/docs/${id}/shares`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    })
    return res.json()
  }

  async project(id: string): Promise<{
    project: {
      id: string
      name: string
      description: string | null
      docId: string | null
      docTitle: string | null
      github: { enabled: boolean; repo: string | null; syncEnabled: boolean }
      apiKeyCount: number
    }
    phases: {
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
    }[]
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
  }> {
    const res = await this.request(`/api/projects/${id}`)
    return res.json()
  }

  async createPhase(projectId: string, name: string): Promise<unknown> {
    const res = await this.request(`/api/projects/${projectId}/phases`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
    return res.json()
  }

  async patchPhase(
    id: string,
    patch: { name?: string; status?: string; doc_id?: string | null },
  ): Promise<unknown> {
    const res = await this.request(`/api/phases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  async patchProject(
    id: string,
    patch: { name?: string; description?: string | null; doc_id?: string | null },
  ): Promise<unknown> {
    const res = await this.request(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  async createRelease(phaseId: string, name: string, demoCommand?: string): Promise<unknown> {
    const res = await this.request(`/api/phases/${phaseId}/releases`, {
      method: 'POST',
      body: JSON.stringify({ name, ...(demoCommand ? { demo_command: demoCommand } : {}) }),
    })
    return res.json()
  }

  async patchRelease(
    id: string,
    patch: { demo_status?: string; name?: string; notes?: string; doc_id?: string | null },
  ): Promise<unknown> {
    const res = await this.request(`/api/releases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  async releaseDetail(id: string): Promise<{
    release: {
      id: string
      name: string
      demo_status: string
      demo_command: string | null
      notes: string | null
      docId: string | null
      docTitle: string | null
    }
    phase: { id: string; name: string; status: string }
    project: { id: string; name: string }
    tasks: {
      id: string
      title: string
      status: string
      assignee: string | null
      feature: string | null
    }[]
  }> {
    const res = await this.request(`/api/releases/${id}`)
    return res.json()
  }

  async createTask(
    phaseId: string,
    task: {
      title: string
      assignee?: string
      feature?: string
      done_means?: string
      priority?: string
    },
  ): Promise<unknown> {
    const res = await this.request(`/api/phases/${phaseId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(task),
    })
    return res.json()
  }

  async patchTask(
    id: string,
    patch: {
      status?: string
      assignee?: string | null
      feature?: string | null
      description?: string | null
      blockers?: string | null
      doc_id?: string | null
      priority?: string | null
    },
  ): Promise<unknown> {
    const res = await this.request(`/api/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    })
    return res.json()
  }

  async taskDetail(id: string): Promise<{
    task: {
      id: string
      title: string
      status: string
      assignee: string | null
      feature: string | null
      done_means: string | null
      description: string | null
      blockers: string | null
      docId: string | null
      docTitle: string | null
      priority: string | null
      acceptance: string | null
      context: string | null
    }
    phase: { id: string; name: string }
    project: { id: string; name: string }
  }> {
    const res = await this.request(`/api/tasks/${id}`)
    return res.json()
  }

  async phaseBurndown(
    phaseId: string,
    days = 30,
  ): Promise<{ points: { date: string; remaining: number }[]; total: number; current: number }> {
    const res = await this.request(`/api/phases/${phaseId}/burndown?days=${days}`)
    return res.json()
  }

  async projectBurndown(
    projectId: string,
    days = 30,
  ): Promise<{ points: { date: string; remaining: number }[]; total: number; current: number }> {
    const res = await this.request(`/api/projects/${projectId}/burndown?days=${days}`)
    return res.json()
  }

  async matrix(projectId: string): Promise<{
    project: { id: string; name: string }
    phases: {
      id: string
      name: string
      status: string
      release: { id: string; name: string; demo_status: string } | null
    }[]
    rows: { feature: string; cells: { phaseId: string; status: string }[] }[]
  }> {
    const res = await this.request(`/api/projects/${projectId}/matrix`)
    return res.json()
  }
}
