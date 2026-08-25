#!/usr/bin/env node

import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomId } from '@can-bang/core'

const CONFIG_DIR = join(homedir(), '.config', 'mde')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

interface Config {
  url?: string
  token?: string
  author?: string
  cursors?: Record<string, number>
}

function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Config
  } catch {
    return {}
  }
}

function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function env(): { url: string; token?: string; author?: string } {
  const cfg = loadConfig()
  return {
    url: (process.env.MDE_URL ?? cfg.url ?? 'http://localhost:8080').replace(/\/+$/, ''),
    token: process.env.MDE_TOKEN ?? cfg.token,
    author: process.env.MDE_AUTHOR ?? cfg.author,
  }
}

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown>; text: string; headers: Headers }> {
  const { url, token } = env()
  const h: Record<string, string> = { accept: 'application/json', ...headers }
  if (token) h.authorization = `Bearer ${token}`
  if (body !== undefined) h['content-type'] = 'application/json'
  const res = await fetch(`${url}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    /* keep empty */
  }
  return { status: res.status, json, text, headers: res.headers }
}

function fail(res: { status: number; json: Record<string, unknown> }): never {
  console.error(`error ${res.status}: ${String(res.json.error ?? 'request failed')}`)
  if (res.json.hint) console.error(String(res.json.hint))
  process.exit(1)
}

function parseDoc(doc: string): string {
  const url = /^https?:\/\//.test(doc) ? new URL(doc) : null
  if (url) {
    const m = url.pathname.match(/^\/(?:d|pub)\/([^/]+)/)
    if (!m) fail({ status: 400, json: { error: 'doc URL must point to /d/<id>' } })
    return m![1]!
  }
  return doc
}

async function readMarkdown(id: string): Promise<{ content: string; version: string }> {
  const { token } = env()
  const h: Record<string, string> = { accept: 'text/markdown' }
  if (token) h.authorization = `Bearer ${token}`
  const res = await fetch(`${env().url}/api/docs/${id}/content`, { headers: h })
  if (!res.ok) fail({ status: res.status, json: { error: `read failed (HTTP ${res.status})` } })
  return {
    content: await res.text(),
    version: res.headers.get('x-doc-version') ?? '',
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const verb = args[0]
  if (!verb || verb === '--help' || verb === 'help') {
    console.log(`mde — collaborative markdown docs, from the terminal

Setup
  mde login [url] [--token t]   sign in (agents/CI: pass --token)
  mde whoami
  mde --version

Documents
  mde new <title> [-f file]
  mde cat <doc>
  mde pull <doc> [-o file]
  mde push <doc> -f file [--label msg] [--force]
  mde ls [--json]
  mde search <query> [--folder name]
  mde share <doc> [role]
  mde rm <doc>
  mde open <doc>

Collaboration
  mde ask <doc> <text>
  mde claim <doc> <askId> [--as name]
  mde resolve <doc> <askId> [-m note]
  mde comments <doc> [--json]
  mde comment <doc> <text> [--line N]
  mde reply <doc> <commentId> <text>
  mde chat <doc> <text> [--fence id]
  mde suggest <doc> --replace <old> --with <new>
  mde accept <doc> <id...>
  mde reject <doc> <id...>
  mde history <doc> [--json]
  mde events <doc> [--since N] [--json]
  mde watch <doc> [--since N] [--json] [--exec cmd] [--skip-self] [--cursor] [--daemon|--daemon-off]

Folders and skills
  mde folders
  mde folder new <name> [--parent id]
  mde move <doc> <folderId|none>
  mde skill manifest <url|slug> [--v N]
  mde skill release <folderId> [-m notes]

Presence
  mde register <name> [--role chief] [--harness x]
  mde heartbeat <name>
  mde activity <name>

Chief supervision
  mde chief-supervisor [--chief name] [--interval sec]   (help: mde chief-supervisor help)

Feedback
  mde papercut <doc> <summary> [--category api|cli|docs|handoff|other]

Tasks
  mde projects [--json]
  mde tasks <projectId> [--json]
  mde task <taskId> [--json]
  mde task new <phaseId> <title> [--status s] [--assignee a] [--feature f] [--priority p]
      [--done-means m] [--acceptance a] [--context c] [--description d] [--blockers b]
  mde task edit <taskId> [same flags; an empty value clears the field]
  mde task comment <taskId> <text> [--kind comment|pr|note]

Environment: MDE_URL, MDE_TOKEN, MDE_AUTHOR
`)
    return
  }
  if (verb === '--version') {
    console.log('mde 0.1.0 (can-bang)')
    return
  }

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const has = (name: string): boolean => args.includes(name)
  const pos = (offset: number): string | undefined => args.filter((a) => !a.startsWith('-'))[offset]

  if (verb === 'login') {
    const url = (pos(1) ?? env().url).replace(/\/+$/, '')
    const token = flag('--token') ?? ''
    saveConfig({ ...loadConfig(), url, token: token || undefined })
    if (token) console.log(`signed in to ${url} with token`)
    else console.log(`saved server ${url}; run again with --token for agents`)
    return
  }
  if (verb === 'whoami') {
    const r = await req('GET', '/api/me')
    if (r.status !== 200) fail(r)
    const u = r.json.user as { username?: string; agent_name?: string | null }
    console.log(
      `@${u.username ?? 'anonymous'}${u.agent_name ? ` (agent name: ${u.agent_name})` : ''}`,
    )
    return
  }
  if (verb === 'new') {
    const title = pos(1) ?? 'Untitled'
    const file = flag('-f')
    const content = file ? readFileSync(file, 'utf8') : ''
    if (env().token) {
      const r = await req('POST', '/api/docs', { title, content })
      if (r.status !== 201) fail(r)
      console.log(String((r.json.doc as { url?: string }).url ?? ''))
    } else {
      const r = await req('POST', '/new', { title, content })
      if (r.status !== 201) fail(r)
      console.log(
        `${env().url}/d/${String(r.json.id)}?key=${encodeURIComponent(String(r.json.key))}`,
      )
    }
    return
  }
  if (verb === 'ls') {
    const r = await req('GET', '/api/docs')
    if (r.status !== 200) fail(r)
    const docs = r.json.docs as {
      id: string
      title: string
      status_state: string | null
      updated_at: number
    }[]
    if (has('--json')) console.log(JSON.stringify(docs, null, 2))
    else for (const d of docs) console.log(`${d.id}\t${d.status_state ?? '—'}\t${d.title}`)
    return
  }
  if (verb === 'cat') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const { content } = await readMarkdown(parseDoc(doc))
    process.stdout.write(content)
    return
  }
  if (verb === 'pull') {
    const doc = pos(1)
    const file = flag('-o')
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const { content, version } = await readMarkdown(parseDoc(doc))
    if (file) writeFileSync(file, content)
    else process.stdout.write(content)
    console.error(`pulled ${parseDoc(doc)} version ${version}`)
    return
  }
  if (verb === 'push') {
    const doc = pos(1)
    const file = flag('-f')
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const content = file ? readFileSync(file, 'utf8') : ''
    const id = parseDoc(doc)
    const { version } = await readMarkdown(id)
    const label = flag('--label')
    const r = await req(
      'PUT',
      `/api/docs/${id}/content`,
      { content, ...(label ? { label } : {}) },
      version ? { 'if-match': version } : {},
    )
    if (r.status === 409 && has('--force')) {
      const r2 = await req('PUT', `/api/docs/${id}/content`, { content, allowClear: true })
      if (r2.status !== 200) fail(r2)
      console.log('pushed (forced)')
      return
    }
    if (r.status !== 200) fail(r)
    console.log(`pushed ${id} version ${String(r.json.version ?? '')}`)
    return
  }
  if (verb === 'share') {
    const doc = pos(1)
    const role = pos(2) ?? 'view'
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const id = parseDoc(doc)
    const r = await req('POST', `/api/docs/${id}/shares`, { role })
    if (r.status !== 200) fail(r)
    const s = r.json.share as { url?: string }
    console.log(s.url ?? '')
    return
  }
  if (verb === 'rm') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const r = await req('DELETE', `/api/docs/${parseDoc(doc)}`)
    if (r.status !== 200) fail(r)
    console.log('deleted')
    return
  }
  if (verb === 'open') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    console.log(`${env().url}/d/${parseDoc(doc)}`)
    return
  }
  if (verb === 'search') {
    const q = pos(1) ?? ''
    const folder = flag('--folder')
    const path = `/api/search?q=${encodeURIComponent(folder ? `${q} folder:"${folder}"` : q)}`
    const r = await req('GET', path)
    if (r.status !== 200) fail(r)
    const results = r.json.results as { docId: string; title: string; score: number }[]
    for (const x of results) console.log(`${x.docId}\t${x.title}`)
    return
  }
  if (verb === 'chat') {
    const doc = pos(1)
    const text = pos(2)
    if (!doc || !text) fail({ status: 400, json: { error: 'doc and text required' } })
    const fence = flag('--fence')
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/chat/message`, {
      text,
      ...(fence ? { fence } : {}),
      ...(env().author ? { author: env().author } : {}),
    })
    if (r.status !== 200) fail(r)
    console.log('posted')
    return
  }
  if (verb === 'comment') {
    const doc = pos(1)
    const text = pos(2)
    if (!doc || !text) fail({ status: 400, json: { error: 'doc and text required' } })
    const line = Number(flag('--line'))
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/comments`, {
      body: text,
      ...(Number.isFinite(line) ? { line } : {}),
    })
    if (r.status !== 201) fail(r)
    console.log(String(r.json.id ?? ''))
    return
  }
  if (verb === 'reply') {
    const doc = pos(1)
    const cid = pos(2)
    const text = pos(3)
    if (!doc || !cid || !text)
      fail({ status: 400, json: { error: 'doc, commentId, and text required' } })
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/comments/${cid}/replies`, {
      body: text,
    })
    if (r.status !== 201) fail(r)
    console.log(String(r.json.id ?? ''))
    return
  }
  if (verb === 'comments') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const r = await req('GET', `/api/docs/${parseDoc(doc)}/comments`)
    if (r.status !== 200) fail(r)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (verb === 'suggest') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const replace = flag('--replace')
    const withText = flag('--with')
    const del = flag('--delete')
    const append = flag('--append')
    let body: Record<string, unknown>
    if (replace !== undefined && withText !== undefined)
      body = { type: 'replace', find: replace, text: withText }
    else if (del !== undefined) body = { type: 'delete', find: del }
    else if (append !== undefined) body = { type: 'insert', at: 'end', text: append }
    else fail({ status: 400, json: { error: 'use --replace/--with, --delete, or --append' } })
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/suggestions`, body)
    if (r.status !== 201) fail(r)
    console.log((r.json.ids as string[]).join(' '))
    return
  }
  if (verb === 'accept' || verb === 'reject') {
    const doc = pos(1)
    const ids = args.slice(2).filter((a) => !a.startsWith('-'))
    if (!doc || !ids.length)
      fail({ status: 400, json: { error: 'doc and suggestion ids required' } })
    for (const id of ids) {
      const r = await req('POST', `/api/docs/${parseDoc(doc)}/suggestions/${id}`, {
        action: verb === 'accept' ? 'accept' : 'reject',
      })
      if (r.status !== 200) fail(r)
    }
    console.log(`${verb}ed ${ids.length} suggestion(s)`)
    return
  }
  if (verb === 'history') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const r = await req('GET', `/api/docs/${parseDoc(doc)}/revisions`)
    if (r.status !== 200) fail(r)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (verb === 'events') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const since = flag('--since')
    const r = await req('GET', `/api/docs/${parseDoc(doc)}/events${since ? `?since=${since}` : ''}`)
    if (r.status !== 200) fail(r)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (verb === 'watch') {
    const doc = pos(1)
    if (!doc) fail({ status: 400, json: { error: 'doc required' } })
    const id = parseDoc(doc)
    const execCmd = flag('--exec')
    const persist = has('--cursor')
    const daemon = has('--daemon')
    const daemonOff = has('--daemon-off')
    const skipSelf = has('--skip-self')
    if (daemonOff) {
      removeDaemon(id)
      console.log('daemon removed')
      return
    }
    if (daemon) {
      installDaemon(id, execCmd ?? '', persist)
      console.log(`daemon installed for ${id}`)
      return
    }
    let since: number | 'latest' = 'latest'
    if (persist) {
      const cfg = loadConfig()
      since = cfg.cursors?.[id] ?? 'latest'
    }
    const start = flag('--since')
    if (start) since = Number(start)
    for (;;) {
      const mention =
        skipSelf && env().author ? `&mention=${encodeURIComponent(env().author!)}` : ''
      const r = await req('GET', `/api/docs/${id}/events?since=${String(since)}&wait=55${mention}`)
      if (r.status !== 200) {
        console.error(`watch error ${r.status} — retrying`)
        await new Promise((x) => setTimeout(x, 2000))
        continue
      }
      const evs = r.json.events as {
        seq: number
        type: string
        ts: number
        actor: string
        payload: Record<string, unknown>
      }[]
      const latest = Number(r.json.latest ?? since)
      if (evs.length) {
        if (execCmd) {
          await runHandler(execCmd, {
            MDE_EVENTS: JSON.stringify(evs),
            MDE_DOC: id,
            MDE_LATEST: String(latest),
          })
        } else {
          for (const e of evs) console.log(JSON.stringify(e))
        }
        since = latest
        if (persist) {
          const cfg = loadConfig()
          cfg.cursors = { ...cfg.cursors, [id]: latest }
          saveConfig(cfg)
        }
      }
    }
  }
  if (verb === 'activity') {
    const name = pos(1)
    if (!name) fail({ status: 400, json: { error: 'name required' } })
    console.error(`watching activity for ${name}…`)
    for (;;) {
      const r = await req('GET', '/api/agents')
      if (r.status !== 200) {
        await new Promise((x) => setTimeout(x, 5000))
        continue
      }
      const agents = r.json.agents as { name: string; currentDoc: string | null }[]
      const agent = agents.find((a) => a.name === name)
      const doc = agent?.currentDoc
      if (!doc) {
        await new Promise((x) => setTimeout(x, 5000))
        continue
      }
      const ev = await req(
        'GET',
        `/api/docs/${doc}/events?since=latest&wait=55&mention=${encodeURIComponent(name)}`,
      )
      if (ev.status === 200) {
        const events = ev.json.events as {
          seq: number
          type: string
          ts: number
          payload: Record<string, unknown>
        }[]
        for (const e of events)
          console.log(`${new Date(e.ts).toISOString()} ${e.type} ${JSON.stringify(e.payload)}`)
      }
    }
  }
  if (verb === 'chief-supervisor') {
    if (pos(1) === 'help') {
      console.log(`chief-supervisor — between-conversations chief daemon

Usage: mde chief-supervisor [--chief <name>] [--interval <seconds>]

Loops: heartbeat the chief, sweep the owner's inbox, and print briefs for
anything needing a human. Ctrl-C to stop.`)
      return
    }
    const chief = flag('--chief') ?? env().author ?? 'chief'
    const interval = Math.max(Number(flag('--interval') ?? 60), 10)
    console.error(`chief supervisor running as ${chief} (every ${interval}s)`)
    for (;;) {
      const hb = await req('POST', '/api/agents/heartbeat', { name: chief })
      if (hb.status !== 200)
        console.error(`heartbeat failed: ${String(hb.json.error ?? hb.status)}`)
      const inbox = await req('GET', '/api/inbox')
      if (inbox.status === 200) {
        const items = inbox.json.items as {
          docId: string
          title: string
          type: string
          message: string
          ts: number
        }[]
        for (const item of items) {
          console.log(
            `BRIEF ${new Date(item.ts).toISOString()} [${item.type}] ${item.title}: ${item.message}`,
          )
        }
      }
      await new Promise((x) => setTimeout(x, interval * 1000))
    }
  }
  if (verb === 'ask') {
    const doc = pos(1)
    const text = pos(2)
    if (!doc || !text) fail({ status: 400, json: { error: 'doc and text required' } })
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/asks`, { text })
    if (r.status !== 201) fail(r)
    console.log(String((r.json.ask as { id?: string }).id ?? ''))
    return
  }
  if (verb === 'claim') {
    const doc = pos(1)
    const askId = pos(2)
    if (!doc || !askId) fail({ status: 400, json: { error: 'doc and askId required' } })
    const agent = flag('--as') ?? env().author ?? 'agent'
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/asks/${askId}/claim`, { agent })
    if (r.status !== 200) fail(r)
    console.log(`claimed ${askId} as ${agent}`)
    return
  }
  if (verb === 'resolve') {
    const doc = pos(1)
    const askId = pos(2)
    if (!doc || !askId) fail({ status: 400, json: { error: 'doc and askId required' } })
    const note = flag('-m')
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/asks/${askId}/resolve`, {
      ...(note ? { note } : {}),
    })
    if (r.status !== 200) fail(r)
    console.log('resolved')
    return
  }
  if (verb === 'register') {
    const name = pos(1)
    if (!name) fail({ status: 400, json: { error: 'name required' } })
    const r = await req('POST', '/api/agents/register', {
      name,
      ...(flag('--role') ? { role: flag('--role') } : {}),
      ...(flag('--harness') ? { harness: flag('--harness') } : {}),
    })
    if (r.status !== 200) fail(r)
    console.log(`registered ${name}`)
    return
  }
  if (verb === 'heartbeat') {
    const name = pos(1)
    if (!name) fail({ status: 400, json: { error: 'name required' } })
    const r = await req('POST', '/api/agents/heartbeat', { name })
    if (r.status !== 200) fail(r)
    console.log('heartbeat sent')
    return
  }
  if (verb === 'folders') {
    const r = await req('GET', '/api/folders')
    if (r.status !== 200) fail(r)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (verb === 'folder' && pos(1) === 'new') {
    const name = pos(2)
    if (!name) fail({ status: 400, json: { error: 'name required' } })
    const r = await req('POST', '/api/folders', {
      name,
      ...(flag('--parent') ? { parentId: flag('--parent') } : {}),
    })
    if (r.status !== 201) fail(r)
    console.log(String((r.json.folder as { id?: string }).id ?? ''))
    return
  }
  if (verb === 'move') {
    const doc = pos(1)
    const folder = pos(2)
    if (!doc || !folder)
      fail({ status: 400, json: { error: 'doc and folder required (use none to unfile)' } })
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/move`, {
      folderId: folder === 'none' ? null : folder,
    })
    if (r.status !== 200) fail(r)
    console.log('moved')
    return
  }
  if (verb === 'skill' && pos(1) === 'manifest') {
    const target = pos(2)
    if (!target) fail({ status: 400, json: { error: 'url or slug required' } })
    const v = flag('--v')
    const path = target.startsWith('http')
      ? target
      : `/skills/${encodeURIComponent(target)}/manifest${v ? `?v=${v}` : ''}`
    const r = await req('GET', path)
    if (r.status !== 200) fail(r)
    console.log(JSON.stringify(r.json, null, 2))
    return
  }
  if (verb === 'skill' && pos(1) === 'release') {
    const folder = pos(2)
    if (!folder) fail({ status: 400, json: { error: 'folderId required' } })
    const r = await req('POST', `/api/folders/${folder}/releases`, {
      ...(flag('-m') ? { notes: flag('-m') } : {}),
    })
    if (r.status !== 201) fail(r)
    console.log(`release ${String(r.json.version ?? '')}`)
    return
  }
  if (verb === 'papercut') {
    const doc = pos(1)
    const summary = pos(2)
    if (!doc || !summary) fail({ status: 400, json: { error: 'doc and summary required' } })
    const r = await req('POST', `/api/docs/${parseDoc(doc)}/feedback`, {
      summary,
      ...(flag('--category') ? { category: flag('--category') } : {}),
    })
    if (r.status !== 200) fail(r)
    console.log('reported')
    return
  }

  const taskSpecFlags = [
    '--status',
    '--assignee',
    '--feature',
    '--priority',
    '--done-means',
    '--acceptance',
    '--context',
    '--description',
    '--contract',
    '--workflow',
    '--scenarios',
    '--dependencies',
    '--blockers',
  ] as const
  const taskSpecBody = (): Record<string, string | null> => {
    const body: Record<string, string | null> = {}
    for (const name of taskSpecFlags) {
      const value = flag(name)
      if (value === undefined) continue
      body[name === '--done-means' ? 'done_means' : name.slice(2)] = value === '' ? null : value
    }
    return body
  }

  if (verb === 'projects') {
    const r = await req('GET', '/api/projects')
    if (r.status !== 200) fail(r)
    const projects = r.json.projects as {
      id: string
      name: string
      counts: { total: number; done: number }
    }[]
    if (has('--json')) console.log(JSON.stringify(projects, null, 2))
    else
      for (const p of projects)
        console.log(`${p.id}\t${p.name}\t${p.counts.done}/${p.counts.total}`)
    return
  }
  if (verb === 'tasks') {
    const project = pos(1)
    if (!project) fail({ status: 400, json: { error: 'projectId required' } })
    const r = await req('GET', `/api/projects/${project}`)
    if (r.status !== 200) fail(r)
    const tasks = (r.json as { tasks?: Record<string, unknown>[] }).tasks ?? []
    if (has('--json')) console.log(JSON.stringify(tasks, null, 2))
    else
      for (const t of tasks as {
        id: string
        title: string
        status: string
        assignee?: string | null
      }[])
        console.log(`${t.id}\t${t.status}\t${t.assignee ? `@${t.assignee} ` : ''}${t.title}`)
    return
  }
  if (verb === 'task') {
    const sub = pos(1)
    if (sub === 'comment') {
      const id = pos(2)
      const text = pos(3)
      if (!id || !text)
        fail({ status: 400, json: { error: 'task comment <taskId> <text> required' } })
      const kind = flag('--kind') ?? 'comment'
      if (!['comment', 'pr', 'note'].includes(kind))
        fail({ status: 400, json: { error: '--kind must be comment, pr, or note' } })
      const r = await req('POST', `/api/tasks/${id}/activity`, {
        message: text,
        kind,
      })
      if (r.status !== 201) fail(r)
      console.log('logged')
      return
    }
    if (sub === 'new' || sub === 'edit') {
      const id = pos(2)
      const title = sub === 'new' ? pos(3) : undefined
      if (!id || (sub === 'new' && !title))
        fail({
          status: 400,
          json: { error: `task ${sub} <id>${sub === 'new' ? ' <title>' : ''} required` },
        })
      const body = taskSpecBody()
      if (title) body.title = title
      if (sub === 'new') {
        const r = await req('POST', `/api/phases/${id}/tasks`, body)
        if (r.status !== 201) fail(r)
        console.log(`created ${String((r.json.task as { id?: string }).id ?? '')}`)
      } else {
        const r = await req('PATCH', `/api/tasks/${id}`, body)
        if (r.status !== 200) fail(r)
        console.log('updated')
      }
      return
    }
    if (!sub) fail({ status: 400, json: { error: 'task <taskId> required' } })
    const r = await req('GET', `/api/tasks/${sub}`)
    if (r.status !== 200) fail(r)
    if (has('--json')) {
      console.log(JSON.stringify(r.json, null, 2))
    } else {
      const body = r.json as {
        task: Record<string, unknown>
        phase: { name: string }
        project: { name: string }
      }
      const t = body.task
      const show = (label: string, v: unknown) => {
        if (v) console.log(`${label}: ${String(v)}`)
      }
      console.log(
        `${String(t.title ?? '')} [${String(t.status ?? '')}] · ${String(body.project.name)} / ${String(body.phase.name)}`,
      )
      show('assignee', t.assignee)
      show('feature', t.feature)
      show('priority', t.priority)
      show('done-means', t.done_means)
      show('acceptance', t.acceptance)
      show('context', t.context)
      show('description', t.description)
      show('blockers', t.blockers)
      const activity =
        (
          body as {
            activity?: {
              kind: string
              author: string | null
              message: string
              created_at: number
            }[]
          }
        ).activity ?? []
      if (activity.length) {
        console.log('')
        for (const a of activity)
          console.log(
            `[${a.kind}] ${a.author ?? 'system'} ${new Date(a.created_at).toLocaleString()}: ${a.message.replace(/\n/g, ' ')}`,
          )
      }
    }
    return
  }

  fail({ status: 400, json: { error: `unknown command: ${verb}` } })
}

function runHandler(cmd: string, extraEnv: Record<string, string>): Promise<void> {
  return new Promise((resolvePromise) => {
    const child = spawn('sh', ['-c', cmd], {
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    })
    child.on('exit', () => resolvePromise())
    child.on('error', () => resolvePromise())
  })
}

function serviceId(docId: string): string {
  return `mde-watch-${docId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

function installDaemon(docId: string, execCmd: string, persist: boolean): void {
  const cliPath = resolve(process.argv[1] ?? '')
  const cmdArgs = [cliPath, 'watch', docId]
  if (execCmd) cmdArgs.push('--exec', execCmd)
  if (persist) cmdArgs.push('--cursor')
  const logsDir = join(homedir(), '.config', 'mde', 'logs')
  mkdirSync(logsDir, { recursive: true })
  const id = serviceId(docId)
  if (process.platform === 'darwin') {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents')
    mkdirSync(plistDir, { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${id}</string>
  <key>ProgramArguments</key><array>${cmdArgs.map((a) => `<string>${a}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(logsDir, `${id}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(logsDir, `${id}.log`)}</string>
</dict></plist>`
    writeFileSync(join(plistDir, `${id}.plist`), plist)
    spawn('launchctl', ['load', '-w', join(plistDir, `${id}.plist`)], { stdio: 'inherit' })
  } else {
    const unitDir = join(homedir(), '.config', 'systemd', 'user')
    mkdirSync(unitDir, { recursive: true })
    const escape = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`
    const unit = `[Unit]
Description=mde watch ${docId}

[Service]
ExecStart=/usr/bin/env node ${cmdArgs.map(escape).join(' ')}
Restart=on-failure

[Install]
WantedBy=default.target
`
    writeFileSync(join(unitDir, `${id}.service`), unit)
    spawn('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' })
    spawn('systemctl', ['--user', 'enable', '--now', `${id}.service`], { stdio: 'inherit' })
  }
}

function removeDaemon(docId: string): void {
  const id = serviceId(docId)
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${id}.plist`)
    spawn('launchctl', ['unload', '-w', plist], { stdio: 'inherit' })
    rmSync(plist, { force: true })
  } else {
    const unit = join(homedir(), '.config', 'systemd', 'user', `${id}.service`)
    spawn('systemctl', ['--user', 'disable', '--now', `${id}.service`], { stdio: 'inherit' })
    rmSync(unit, { force: true })
  }
}

void main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
