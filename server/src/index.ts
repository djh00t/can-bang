import { createServer, type IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { loadConfig } from './config.js'
import { openDb } from './db.js'
import { EventBus } from './events.js'
import { AppServices } from './service.js'
import { createApp } from './app.js'
import { resolveAccess } from './auth.js'
import { escalateAsks } from './routes/asks.js'
import {
  dedupeSeededProjects,
  renameSeededProjects,
  repairSeededSkills,
  seedSkillsIfFirst,
  seedWorkspaceIfFirst,
} from './seed.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const config = loadConfig()
  const db = openDb(join(config.dataDir, 'workbench.db'))
  const bus = new EventBus()

  const wsClients = new Map<string, Set<{ name: string; send: (s: string) => void }>>()
  let services!: AppServices
  const presence = {
    setTyping: (docId: string, name: string) => {
      services.setTyping(docId, name)
      broadcast(docId, { type: 'typing', names: services.getTyping(docId) })
    },
    getTyping: (docId: string) => services.getTyping(docId),
    broadcast,
  }
  services = new AppServices(db, bus, config, presence)

  function broadcast(docId: string, payload: Record<string, unknown>): void {
    const clients = wsClients.get(docId)
    if (!clients) return
    const msg = JSON.stringify(payload)
    for (const c of clients) c.send(msg)
  }

  const app = createApp(services)
  const server = createServer(app)
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const docId = url.searchParams.get('doc') ?? ''
    const key = url.searchParams.get('key') ?? undefined
    if (!docId) {
      socket.destroy()
      return
    }
    const fakeReq = {
      headers: { ...req.headers, ...(key ? { 'x-share-key': key } : {}) },
      query: key ? { key } : {},
      ip: req.socket.remoteAddress,
    } as never
    try {
      const access = resolveAccess(db, fakeReq as never, docId)
      if (!access.role) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, docId, access.identity.name || 'Guest')
      })
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
    }
  })

  wss.on('connection', (ws: WebSocket, _req: IncomingMessage, docId: string, name: string) => {
    if (!wsClients.has(docId)) wsClients.set(docId, new Set())
    const client = { name, send: (s: string) => ws.readyState === WebSocket.OPEN && ws.send(s) }
    wsClients.get(docId)!.add(client)
    const onEvent = (ev: {
      seq: number
      type: string
      ts: number
      actor: string
      guest: boolean
      payload: Record<string, unknown>
    }) => {
      client.send(JSON.stringify({ type: 'event', event: ev }))
    }
    bus.on(docId, onEvent)
    ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>
        if (msg.type === 'typing') presence.setTyping(docId, name)
        if (msg.type === 'cursor') broadcast(docId, { type: 'cursor', name, cursor: msg.cursor })
        if (msg.type === 'editing') services.debouncedEdited(docId)
      } catch {
        // ignore malformed frames
      }
    })
    ws.on('close', () => {
      bus.off(docId, onEvent)
      wsClients.get(docId)?.delete(client)
    })
  })

  // Seed default widgets so /new?widget= works out of the box
  seedWidgets(db)

  // Seed starter skills for existing installs (new installs seed on first signup)
  const firstAccount = db
    .prepare('SELECT id, username FROM accounts ORDER BY created_at ASC LIMIT 1')
    .get() as { id: string; username: string } | undefined
  if (firstAccount) seedSkillsIfFirst(services, firstAccount.id, firstAccount.username)
  if (firstAccount) seedWorkspaceIfFirst(services, firstAccount.id)
  repairSeededSkills(db)
  dedupeSeededProjects(db)
  renameSeededProjects(db)

  services.startWebhookLoop()
  const escalationTimer = setInterval(() => {
    escalateAsks(services)
  }, 60_000)
  escalationTimer.unref()

  server.listen(config.port, () => {
    console.log(`can-bang listening on http://localhost:${config.port}`)
  })

  const shutdown = () => {
    services.stop()
    clearInterval(escalationTimer)
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function seedWidgets(db: ReturnType<typeof openDb>): void {
  const widgets: [string, string, string, string][] = [
    [
      'click-counter',
      'Click Counter',
      'tool',
      `<div style="font:16px sans-serif;padding:12px"><button onclick="margin.setState({count:(margin.state.count||0)+1})" style="font-size:18px;padding:8px 16px">Vote</button><p>Count: <b id="c"></b></p><script>function r(){document.getElementById("c").textContent=margin.state.count||0}margin.onChange=r;r()</script></div>`,
    ],
    [
      'dice-roller',
      'Dice Roller',
      'game',
      `<div style="font:16px sans-serif;padding:12px"><button onclick="margin.setState({value:1+Math.floor(Math.random()*6)})" style="font-size:18px;padding:8px 16px">Roll</button><p>Result: <b id="d"></b></p><script>function r(){document.getElementById("d").textContent=margin.state.value||"—"}margin.onChange=r;r()</script></div>`,
    ],
    [
      'quick-poll',
      'Quick Poll',
      'tool',
      `<div style="font:16px sans-serif;padding:12px"><p id="p"></p><button onclick="margin.setState({yes:(margin.state.yes||0)+1})">Yes</button> <button onclick="margin.setState({no:(margin.state.no||0)+1})">No</button><p id="r"></p><script>function r(){const s=margin.state||{};document.getElementById("p").textContent=(s.yes||0)+" yes / "+(s.no||0)+" no";document.getElementById("r").textContent=""}margin.onChange=r;r()</script></div>`,
    ],
    [
      'stopwatch',
      'Stopwatch',
      'tool',
      `<div style="font:16px sans-serif;padding:12px"><p id="t">0.0s</p><button onclick="margin.setState({start:Date.now(),base:(margin.state&&margin.state.base)||0})">Start</button> <button onclick="margin.setState({base:(margin.state&&margin.state.base)+((margin.state&&margin.state.start)?(Date.now()-margin.state.start)/1000:0),start:null})">Stop</button><script>function r(){const s=margin.state||{};const el=document.getElementById("t");if(!el)return;const sec=(s.base||0)+(s.start?(Date.now()-s.start)/1000:0);el.textContent=sec.toFixed(1)+"s"}setInterval(r,100);margin.onChange=r;r()</script></div>`,
    ],
  ]
  for (const [slug, title, category, html] of widgets) {
    db.prepare(
      `INSERT INTO widgets (slug, title, category, html, state, status, created_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO NOTHING`,
    ).run(slug, title, category, html, '{}', 'approved', Date.now())
  }
}

void main().catch((err) => {
  console.error('fatal', err)
  process.exit(1)
})
