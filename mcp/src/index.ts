#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const DEFAULT_URL = 'http://localhost:8080'
const POLL_SECONDS = 15
const REQUEST_TIMEOUT_MS = 30_000

const configuredUrl = String(process.env.WORKBENCH_URL || DEFAULT_URL)
  .trim()
  .replace(/\/+$/, '')
const token = String(process.env.WORKBENCH_TOKEN || '').trim()

function baseUrl(): string {
  let parsed: URL | undefined
  try {
    parsed = new URL(configuredUrl)
  } catch {
    /* shaped below */
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('WORKBENCH_URL must be an http(s) URL')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function resolveDoc(value: string | undefined, explicitKey: string | undefined) {
  const input = String(value || '').trim()
  if (!input) return { error: inputError('doc required') }
  let id = input
  let key = explicitKey
  try {
    const url = new URL(input)
    const match =
      url.pathname.match(/^\/(?:d|pub)\/([^/]+)(?:\/(?:agent))?(?:\.md)?$/) ||
      url.pathname.match(/^\/api\/docs\/([^/]+)(?:\/.*)?$/)
    if (!match)
      return { error: inputError('doc URL must point to /d/<id>, /pub/<id>, or /api/docs/<id>') }
    id = match[1]!
    if (key === undefined) key = url.searchParams.get('key') ?? undefined
  } catch {
    if (/[/?#]/.test(input))
      return { error: inputError('doc must be a document ID or CanBang document URL') }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id))
    return { error: inputError('doc contains an invalid document ID') }
  return { id, key }
}

function resolveEntity(value: string | undefined, patterns: RegExp[]) {
  const input = String(value || '').trim()
  if (!input) return { error: inputError('id required') }
  let id = input
  try {
    const url = new URL(input)
    const match = patterns.map((p) => url.pathname.match(p)).find(Boolean)
    if (!match) return { error: inputError('URL must point to a known project/phase/task path') }
    id = match[1]!
  } catch {
    if (/[/?#]/.test(input))
      return { error: inputError('value must be an id or a CanBang project/phase/task URL') }
  }
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { error: inputError('id contains an invalid character') }
  return { id }
}

function inputError(message: string) {
  return { ok: false, status: 400, error: message }
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function resultFrom(value: unknown) {
  return toolResult(value, (value as { ok?: boolean })?.ok === false)
}

async function parseResponse(res: Response) {
  const text = await res.text()
  if (!text) return {}
  if (res.headers.get('content-type')?.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      /* preserve malformed body below */
    }
  }
  return { body: text }
}

async function request(
  path: string,
  {
    method = 'GET',
    key,
    body,
    headers = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: {
    method?: string
    key?: string
    body?: Record<string, unknown>
    headers?: Record<string, string>
    timeoutMs?: number
  } = {},
) {
  const requestHeaders: Record<string, string> = { accept: 'application/json', ...headers }
  if (token) requestHeaders.authorization = `Bearer ${token}`
  if (key !== undefined) requestHeaders['x-share-key'] = String(key)
  if (body !== undefined) requestHeaders['content-type'] = 'application/json'
  let res: Response
  try {
    const target = /^https?:\/\//i.test(path) ? path : `${baseUrl()}${path}`
    if (new URL(target).origin !== new URL(baseUrl()).origin) delete requestHeaders.authorization
    res = await fetch(target, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: 'Could not reach CanBang',
      hint: `Check WORKBENCH_URL (${configuredUrl}) and network access, then retry.`,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  const payload = await parseResponse(res)
  if (!res.ok) {
    return {
      ...(payload && typeof payload === 'object' ? payload : { body: payload }),
      ok: false,
      status: res.status,
      ...(res.headers.get('retry-after') ? { retryAfter: res.headers.get('retry-after') } : {}),
    }
  }
  return { ok: true, status: res.status, payload, headers: res.headers }
}

async function jsonRequest(path: string, options?: Parameters<typeof request>[1]) {
  const response = await request(path, options)
  if (!response.ok) return response
  return response.payload
}

const docArg = z.string().min(1).describe('Document ID or CanBang document/share URL')
const keyArg = z
  .string()
  .min(1)
  .optional()
  .describe('Share key for this call; overrides token access just as the REST API does')

const server = new McpServer({ name: 'can-bang', version: '0.1.0' })

server.registerTool(
  'create_doc',
  {
    description:
      'When a plan, spec, or decision needs to outlive this session, create a CanBang doc. With a configured token it belongs to the user; otherwise the returned key is the anonymous edit capability.',
    inputSchema: {
      title: z.string().max(200).optional(),
      content: z.string().optional(),
      kind: z.enum(['live', 'plain']).optional(),
    },
  },
  async ({ title, content, kind }) => {
    const body = {
      ...(title !== undefined ? { title } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(kind !== undefined ? { kind } : {}),
    }
    if (!token) return resultFrom(await jsonRequest('/new', { method: 'POST', body }))
    const created = (await jsonRequest('/api/docs', { method: 'POST', body })) as {
      ok?: boolean
      doc?: { id: string; url: string; kind: string }
    }
    if (created?.ok === false) return resultFrom(created)
    return resultFrom({
      id: created.doc?.id,
      url: created.doc?.url,
      key: null,
      kind: created.doc?.kind,
    })
  },
)

server.registerTool(
  'read_doc',
  {
    description:
      'Read the current canonical markdown; returns the version/ETag required for a concurrency-safe write.',
    inputSchema: { doc: docArg, key: keyArg },
  },
  async ({ doc, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    const response = await request(`/api/docs/${encodeURIComponent(resolved.id!)}/content`, {
      key: resolved.key,
      headers: { accept: 'text/markdown' },
    })
    if (!response.ok) return resultFrom(response)
    const content = (response.payload as { body?: string })?.body ?? ''
    const version =
      response.headers.get('x-doc-version') ||
      response.headers
        .get('etag')
        ?.replace(/^W\//, '')
        .replace(/^"(.*)"$/, '$1') ||
      null
    return resultFrom({
      doc: resolved.id,
      content,
      version,
      etag: response.headers.get('etag'),
      ...(response.headers.get('x-workbench-unclaimed')
        ? { unclaimedNotice: response.headers.get('x-workbench-unclaimed') }
        : {}),
    })
  },
)

server.registerTool(
  'write_doc',
  {
    description:
      'Replace the complete shared markdown. Pass baseVersion from read_doc for optimistic concurrency; on a 409, follow the server hint.',
    inputSchema: {
      doc: docArg,
      content: z.string(),
      baseVersion: z.string().min(1).optional(),
      key: keyArg,
    },
  },
  async ({ doc, content, baseVersion, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    const response = await request(`/api/docs/${encodeURIComponent(resolved.id!)}/content`, {
      method: 'PUT',
      key: resolved.key,
      body: { content },
      headers: baseVersion ? { 'if-match': baseVersion } : {},
    })
    if (!response.ok) return resultFrom(response)
    return resultFrom({
      ...(response.payload as Record<string, unknown>),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') } : {}),
    })
  },
)

server.registerTool(
  'post_chat',
  {
    description: 'Append one agent message to a chat fence without replacing the doc.',
    inputSchema: {
      doc: docArg,
      text: z.string().min(1).max(2000),
      fence: z.string().min(1).optional(),
      author: z.string().min(1).optional(),
      key: keyArg,
    },
  },
  async ({ doc, text, fence, author, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/docs/${encodeURIComponent(resolved.id!)}/chat/message`, {
        method: 'POST',
        key: resolved.key,
        body: { text, kind: 'agent', ...(fence ? { fence } : {}), ...(author ? { author } : {}) },
      }),
    )
  },
)

server.registerTool(
  'set_status',
  {
    description:
      'Update a status fence. awaiting-human places the doc in the owner’s needs-me inbox.',
    inputSchema: {
      doc: docArg,
      state: z.enum(['building', 'blocked', 'awaiting-human', 'done']).optional(),
      note: z.string().min(1).max(500).optional(),
      headline: z.string().max(200).optional(),
      author: z.string().min(1).optional(),
      key: keyArg,
    },
  },
  async ({ doc, state, note, headline, author, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/docs/${encodeURIComponent(resolved.id!)}/status`, {
        method: 'POST',
        key: resolved.key,
        body: {
          ...(state !== undefined ? { state } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(headline !== undefined ? { headline } : {}),
          ...(author !== undefined ? { author } : {}),
        },
      }),
    )
  },
)

server.registerTool(
  'poll_events',
  {
    description:
      'One bounded 15-second long-poll for collaborator activity or an @mention; reuse the returned latest as since on the next call.',
    inputSchema: {
      doc: docArg,
      since: z.union([z.number().int().nonnegative(), z.literal('latest')]).optional(),
      mention: z.string().min(1).optional(),
      key: keyArg,
    },
  },
  async ({ doc, since, mention, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    const query = new URLSearchParams({ wait: String(POLL_SECONDS) })
    if (since !== undefined) query.set('since', String(since))
    if (mention !== undefined) query.set('mention', mention)
    return resultFrom(
      await jsonRequest(`/api/docs/${encodeURIComponent(resolved.id!)}/events?${query}`, {
        key: resolved.key,
        timeoutMs: (POLL_SECONDS + 5) * 1000,
      }),
    )
  },
)

server.registerTool(
  'my_inbox',
  { description: 'Owner needs-me queue (account-scoped).', inputSchema: {} },
  async () => resultFrom(await jsonRequest('/api/inbox')),
)

server.registerTool(
  'list_docs',
  { description: 'List the account’s documents (account-scoped).', inputSchema: {} },
  async () => resultFrom(await jsonRequest('/api/docs')),
)

server.registerTool(
  'search',
  {
    description:
      'Ranked title/markdown search; results keep the server ranking with plain-text snippets.',
    inputSchema: { q: z.string().min(1).max(500), folder: z.string().min(1).max(100).optional() },
  },
  async ({ q, folder }) => {
    const filter =
      folder === undefined ? '' : ` folder:"${String(folder).replace(/"/g, '').trim()}"`
    const query = `${String(q || '').trim()}${filter}`.trim()
    const payload = (await jsonRequest(`/api/search?q=${encodeURIComponent(query)}`)) as {
      results?: { snippet?: string }[]
    }
    if (Array.isArray(payload?.results)) {
      payload.results = payload.results.map((r) => ({
        ...r,
        snippet: String(r.snippet || '').replace(/<\/?mark>/gi, ''),
      }))
    }
    return resultFrom(payload)
  },
)

server.registerTool(
  'list_folders',
  { description: 'Recursive owner folder tree with counts (account-scoped).', inputSchema: {} },
  async () => resultFrom(await jsonRequest('/api/folders')),
)

const taskSpecFields = {
  title: z.string().min(1).max(200).optional(),
  status: z.enum(['todo', 'doing', 'testing', 'done']).optional(),
  assignee: z.string().max(40).nullable().optional(),
  feature: z.string().max(80).nullable().optional(),
  priority: z.string().max(20).nullable().optional(),
  doneMeans: z.string().max(500).nullable().optional(),
  acceptance: z.string().max(500).nullable().optional(),
  context: z.string().max(2000).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  contract: z.string().max(2000).nullable().optional(),
  workflow: z.string().max(2000).nullable().optional(),
  scenarios: z.string().max(2000).nullable().optional(),
  dependencies: z.string().max(500).nullable().optional(),
  blockers: z.string().max(500).nullable().optional(),
}

function taskBody(args: Record<string, unknown>) {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue
    body[k === 'doneMeans' ? 'done_means' : k] = v
  }
  return body
}

server.registerTool(
  'mint_project_key',
  {
    description:
      'Mint a project-scoped API key. The returned secret is shown once and must be stored securely by the caller.',
    inputSchema: {
      project: z.string().min(1),
      label: z.string().max(80).optional(),
    },
  },
  async ({ project, label }) => {
    const resolved = resolveEntity(project, [/^\/p\/([^/]+)/, /^\/api\/projects\/([^/]+)/])
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest('/api/projects/' + encodeURIComponent(resolved.id!) + '/key', {
        method: 'POST',
        body: label ? { label } : {},
      }),
    )
  },
)

server.registerTool(
  'list_tasks',
  {
    description:
      'List every task in a project (all phases) with the full spec: status, assignee, feature, priority, done-means, acceptance, context, description, blockers.',
    inputSchema: { project: z.string().min(1) },
  },
  async ({ project }) => {
    const resolved = resolveEntity(project, [/^\/p\/([^/]+)/])
    if (resolved.error) return resultFrom(resolved.error)
    const payload = (await jsonRequest(`/api/projects/${encodeURIComponent(resolved.id!)}`)) as {
      tasks?: unknown[]
    }
    return resultFrom(Array.isArray(payload?.tasks) ? { tasks: payload.tasks } : payload)
  },
)

server.registerTool(
  'get_task',
  {
    description:
      'Read one task with its full spec (acceptance criteria, context, done-means, description, blockers) plus phase and project.',
    inputSchema: { task: z.string().min(1) },
  },
  async ({ task }) => {
    const resolved = resolveEntity(task, [
      /^\/api\/tasks\/([^/]+)/,
      /^\/p\/[^/]+\/phase\/[^/]+\/task\/([^/]+)/,
    ])
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(await jsonRequest(`/api/tasks/${encodeURIComponent(resolved.id!)}`))
  },
)

server.registerTool(
  'create_task',
  {
    description:
      'Create a task in a phase with the full spec contract (title required; acceptance/context/done-means/priority/feature/assignee/description/blockers optional).',
    inputSchema: { phase: z.string().min(1), ...taskSpecFields },
  },
  async ({ phase, ...spec }) => {
    const resolved = resolveEntity(phase, [/^\/p\/[^/]+\/phase\/([^/]+)/])
    if (resolved.error) return resultFrom(resolved.error)
    const body = taskBody(spec)
    if (!body.title) return resultFrom(inputError('title required'))
    const missing = [
      !String(body.acceptance ?? '').trim() && 'acceptance',
      !String(body.done_means ?? '').trim() && 'done_means',
    ].filter(Boolean)
    if (missing.length)
      return resultFrom(
        inputError(`task spec incomplete: add ${missing.join(', ')} before creating`),
      )
    return resultFrom(
      await jsonRequest(`/api/phases/${encodeURIComponent(resolved.id!)}/tasks`, {
        method: 'POST',
        body,
      }),
    )
  },
)

server.registerTool(
  'update_task',
  {
    description:
      'Patch any task spec field (status, title, assignee, feature, priority, done-means, acceptance, context, description, blockers). Pass null to clear a field.',
    inputSchema: { task: z.string().min(1), ...taskSpecFields },
  },
  async ({ task, ...spec }) => {
    const resolved = resolveEntity(task, [
      /^\/api\/tasks\/([^/]+)/,
      /^\/p\/[^/]+\/phase\/[^/]+\/task\/([^/]+)/,
    ])
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/tasks/${encodeURIComponent(resolved.id!)}`, {
        method: 'PATCH',
        body: taskBody(spec),
      }),
    )
  },
)

server.registerTool(
  'post_task_activity',
  {
    description:
      'Log a comment, action, or PR link on a task. Kinds: comment (default), pr, note. The full task history is returned by get_task.',
    inputSchema: {
      task: z.string().min(1),
      message: z.string().min(1).max(2000),
      kind: z.enum(['comment', 'pr', 'note']).optional(),
      author: z.string().max(80).optional(),
    },
  },
  async ({ task, message, kind, author }) => {
    const resolved = resolveEntity(task, [
      /^\/api\/tasks\/([^/]+)/,
      /^\/p\/[^/]+\/phase\/[^/]+\/task\/([^/]+)/,
    ])
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/tasks/${encodeURIComponent(resolved.id!)}/activity`, {
        method: 'POST',
        body: { message, ...(kind ? { kind } : {}), ...(author ? { author } : {}) },
      }),
    )
  },
)

server.registerTool(
  'create_folder',
  {
    description: 'Create a root or one-level child folder (account-scoped).',
    inputSchema: {
      name: z.string().min(1).max(100),
      parentId: z.string().min(1).nullable().optional(),
    },
  },
  async ({ name, parentId }) =>
    resultFrom(
      await jsonRequest('/api/folders', {
        method: 'POST',
        body: { name, ...(parentId !== undefined ? { parentId } : {}) },
      }),
    ),
)

server.registerTool(
  'move_doc',
  {
    description: 'File an owned document into a folder (folderId null unfiles).',
    inputSchema: { doc: docArg, folderId: z.string().min(1).nullable() },
  },
  async ({ doc, folderId }) => {
    const resolved = resolveDoc(doc, undefined)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/docs/${encodeURIComponent(resolved.id!)}/move`, {
        method: 'POST',
        body: { folderId },
      }),
    )
  },
)

server.registerTool(
  'skill_manifest',
  {
    description:
      'Fetch an install manifest for a folder-share or directory skill. Read SKILL.md and EVERY file, verify hashes, before executing anything.',
    inputSchema: {
      url: z.string().min(1).optional(),
      slug: z.string().min(1).optional(),
      version: z.number().int().positive().optional(),
    },
  },
  async ({ url, slug, version }) => {
    if ((!url && !slug) || (url && slug))
      return resultFrom(inputError('pass exactly one of url or slug'))
    let target: URL
    if (slug) {
      if (!/^[A-Za-z0-9_-]+$/.test(slug))
        return resultFrom(inputError('slug contains invalid characters'))
      target = new URL(`/skills/${encodeURIComponent(slug)}/manifest`, `${baseUrl()}/`)
    } else {
      try {
        target = new URL(url!)
      } catch {
        return resultFrom(inputError('url must be an http(s) CanBang skill URL'))
      }
      const directory = target.pathname.match(/^\/skills\/([^/]+)\/?$/)
      if (directory) target.pathname = `/skills/${directory[1]!}/manifest`
      else if (
        !/^\/folders\/[A-Za-z0-9_-]+\/?$/.test(target.pathname) &&
        !/^\/skills\/[^/]+\/manifest\/?$/.test(target.pathname)
      ) {
        return resultFrom(
          inputError('url must point to /folders/<id> or /skills/<slug>[/manifest]'),
        )
      }
      if (/^\/folders\//.test(target.pathname)) target.searchParams.set('format', 'install.json')
    }
    if (version !== undefined) target.searchParams.set('v', String(version))
    return resultFrom(
      await jsonRequest(target.toString(), { headers: { accept: 'application/json' } }),
    )
  },
)

server.registerTool(
  'create_ask',
  {
    description: 'Create an open ASK offered for atomic claiming (comment access or better).',
    inputSchema: { doc: docArg, text: z.string().min(1), key: keyArg },
  },
  async ({ doc, text, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(`/api/docs/${encodeURIComponent(resolved.id!)}/asks`, {
        method: 'POST',
        key: resolved.key,
        body: { text },
      }),
    )
  },
)

server.registerTool(
  'claim_ask',
  {
    description:
      'Atomically claim an open ASK. A 409 is returned verbatim with claimedBy/claimedAt or chief-window reason/windowEndsAt; stand down on either.',
    inputSchema: {
      doc: docArg,
      askId: z.string().min(1),
      agent: z.string().min(1).max(40),
      key: keyArg,
    },
  },
  async ({ doc, askId, agent, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(
        `/api/docs/${encodeURIComponent(resolved.id!)}/asks/${encodeURIComponent(askId)}/claim`,
        {
          method: 'POST',
          key: resolved.key,
          body: { agent },
        },
      ),
    )
  },
)

server.registerTool(
  'resolve_ask',
  {
    description: 'Resolve an ASK (claimant or asker).',
    inputSchema: {
      doc: docArg,
      askId: z.string().min(1),
      note: z.string().max(2000).optional(),
      key: keyArg,
    },
  },
  async ({ doc, askId, note, key }) => {
    const resolved = resolveDoc(doc, key)
    if (resolved.error) return resultFrom(resolved.error)
    return resultFrom(
      await jsonRequest(
        `/api/docs/${encodeURIComponent(resolved.id!)}/asks/${encodeURIComponent(askId)}/resolve`,
        {
          method: 'POST',
          key: resolved.key,
          body: { ...(note !== undefined ? { note } : {}) },
        },
      ),
    )
  },
)

server.registerTool(
  'register_agent',
  {
    description:
      'Announce this agent process with its identity and role (chief registers the sole chief).',
    inputSchema: {
      name: z.string().min(1).max(40),
      harness: z.string().min(1).max(80).optional(),
      machine: z.string().min(1).max(120).optional(),
      role: z.enum(['agent', 'chief']).optional(),
    },
  },
  async ({ name, harness, machine, role }) =>
    resultFrom(
      await jsonRequest('/api/agents/register', {
        method: 'POST',
        body: {
          name,
          ...(harness !== undefined ? { harness } : {}),
          ...(machine !== undefined ? { machine } : {}),
          ...(role !== undefined ? { role } : {}),
        },
      }),
    ),
)

server.registerTool(
  'heartbeat',
  {
    description: 'Refresh presence every minute or two while active; null clears work context.',
    inputSchema: {
      name: z.string().min(1).max(40),
      currentDoc: z.string().min(1).max(120).nullable().optional(),
      currentTask: z.string().min(1).max(500).nullable().optional(),
    },
  },
  async ({ name, currentDoc, currentTask }) =>
    resultFrom(
      await jsonRequest('/api/agents/heartbeat', {
        method: 'POST',
        body: {
          name,
          ...(currentDoc !== undefined ? { currentDoc } : {}),
          ...(currentTask !== undefined ? { currentTask } : {}),
        },
      }),
    ),
)

if (process.argv.includes('--health') || process.argv.includes('doctor')) {
  const problems: string[] = []
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 22) console.error(`ok  node ${process.versions.node}`)
  else problems.push(`node ${process.versions.node} — this server needs Node 22+`)
  try {
    const r = await fetch(`${configuredUrl}/health`, { signal: AbortSignal.timeout(8000) })
    if (r.ok) console.error(`ok  ${configuredUrl} reachable`)
    else problems.push(`${configuredUrl}/health answered HTTP ${r.status}`)
  } catch (e) {
    problems.push(`${configuredUrl} unreachable (${(e as Error).cause ?? (e as Error).name})`)
  }
  if (!token) {
    console.error(
      '--  WORKBENCH_TOKEN not set: document and ASK tools work via share keys; account search, folders, registry, my_inbox, and list_docs need the account token',
    )
  } else {
    try {
      const projectKey = /^pk_[A-Za-z0-9_-]+$/.test(token)
      const r = await fetch(`${configuredUrl}${projectKey ? '/api/project-key' : '/api/me'}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok) {
        const body = (await r.json()) as { user?: { username?: string }; projectId?: string }
        console.error(
          projectKey
            ? `ok  project token valid (project ${body.projectId || 'scoped'})`
            : `ok  token valid (@${body.user?.username || 'account'})`,
        )
      } else problems.push(`WORKBENCH_TOKEN rejected (HTTP ${r.status})`)
    } catch (e) {
      problems.push(`token check failed (${(e as Error).message})`)
    }
  }
  for (const p of problems) console.error(`BAD ${p}`)
  console.error(problems.length ? 'health: PROBLEMS FOUND' : 'health: all good')
  process.exit(problems.length ? 1 : 0)
}

const transport = new StdioServerTransport()
await server.connect(transport)
