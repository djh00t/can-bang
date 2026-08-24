import express, { type Request, type Response } from 'express'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ApiError,
  badRequest,
  forbidden,
  newToken,
  newHookSecret,
  notFound,
  randomId,
  secret,
  sha256,
  statusState,
} from '@can-bang/core'
import type { AppServices } from '../service.js'
import type { Db, DocRow, Role } from '../db.js'
import { docVersion } from '../db.js'
import {
  accountFromSession,
  accountFromToken,
  bearerToken,
  requireRole,
  resolveAccess,
  sessionCookie,
} from '../auth.js'
import { hashPassword, hashSecret, verifyPassword } from '../crypto.js'
import { asyncHandler, clientUrl } from '../util.js'
import { getDoc, docUrl } from './docs.js'
import { now } from '@can-bang/core'
import { seedSkillsIfFirst, seedWorkspaceIfFirst } from '../seed.js'

const SESSION_MS = 30 * 24 * 60 * 60 * 1000

function setSession(res: Response, id: string): void {
  res.setHeader(
    'Set-Cookie',
    `wb_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  )
}

export function orgRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  // ---- Accounts ----
  r.post(
    '/api/auth/signup',
    asyncHandler(async (req: Request, res: Response) => {
      const username =
        typeof req.body?.username === 'string' ? req.body.username.trim().slice(0, 60) : ''
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      if (!/^[A-Za-z0-9_-]{2,60}$/.test(username))
        throw badRequest('invalid username', 'Use 2-60 letters, digits, dash, underscore.')
      if (password.length < 8) throw badRequest('password too short', 'Use at least 8 characters.')
      const exists = db
        .prepare('SELECT 1 FROM accounts WHERE username=? COLLATE NOCASE')
        .get(username)
      if (exists) throw new ApiError(409, 'username taken')
      const id = randomId(16)
      db.prepare(
        'INSERT INTO accounts (id, username, password_hash, created_at) VALUES (?,?,?,?)',
      ).run(id, username, await hashPassword(password), now())
      const sessionId = randomId(24)
      db.prepare(
        'INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?,?,?,?)',
      ).run(sessionId, id, now(), now() + SESSION_MS)
      setSession(res, sessionId)
      seedSkillsIfFirst(services, id, username)
      seedWorkspaceIfFirst(services, id)
      res.status(201).json({ user: { username, agent_name: null } })
    }),
  )

  r.post(
    '/api/auth/login',
    asyncHandler(async (req: Request, res: Response) => {
      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
      const password = typeof req.body?.password === 'string' ? req.body.password : ''
      const account = db
        .prepare('SELECT * FROM accounts WHERE username=? COLLATE NOCASE')
        .get(username) as
        | { id: string; username: string; password_hash: string; agent_name: string | null }
        | undefined
      if (!account || !(await verifyPassword(password, account.password_hash))) {
        throw new ApiError(401, 'invalid username or password')
      }
      const sessionId = randomId(24)
      db.prepare(
        'INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?,?,?,?)',
      ).run(sessionId, account.id, now(), now() + SESSION_MS)
      setSession(res, sessionId)
      res.json({ user: { username: account.username, agent_name: account.agent_name } })
    }),
  )

  r.post(
    '/api/auth/logout',
    asyncHandler((req: Request, res: Response) => {
      const sid = sessionCookie(req)
      if (sid) db.prepare('DELETE FROM sessions WHERE id=?').run(sid)
      res.setHeader('Set-Cookie', 'wb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
      res.json({ ok: true })
    }),
  )

  r.get(
    '/api/me',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId)
        throw new ApiError(401, 'not signed in', 'Login or pass Authorization: Bearer mgn_…')
      const account = db
        .prepare('SELECT username, agent_name FROM accounts WHERE id=?')
        .get(access.identity.accountId) as
        { username: string; agent_name: string | null } | undefined
      res.json({ user: account })
    }),
  )

  r.post(
    '/api/me/agent-name',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'not signed in')
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 60) : ''
      if (!name) throw badRequest('name required')
      db.prepare('UPDATE accounts SET agent_name=? WHERE id=?').run(name, access.identity.accountId)
      res.json({ ok: true, name })
    }),
  )

  // ---- Tokens ----
  r.post(
    '/api/tokens',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId)
        throw new ApiError(401, 'account required', 'Sign in to mint API tokens.')
      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 80) : undefined
      const token = newToken()
      const id = randomId(14)
      db.prepare(
        'INSERT INTO tokens (token_hash, account_id, label, created_at) VALUES (?,?,?,?)',
      ).run(hashSecret(token), access.identity.accountId, label ?? null, now())
      res.status(201).json({ id, token, label: label ?? null })
    }),
  )

  r.get(
    '/api/tokens',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const rows = db
        .prepare(
          'SELECT token_hash, label, created_at, last_seen_at FROM tokens WHERE account_id=?',
        )
        .all(access.identity.accountId) as {
        token_hash: string
        label: string | null
        created_at: number
        last_seen_at: number | null
      }[]
      res.json({
        tokens: rows.map((t) => ({
          id: t.token_hash.slice(0, 10),
          label: t.label,
          created_at: t.created_at,
          last_seen_at: t.last_seen_at,
        })),
      })
    }),
  )

  r.delete(
    '/api/tokens/:id',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const prefix = req.params.id!
      db.prepare('DELETE FROM tokens WHERE account_id=? AND substr(token_hash,1,10)=?').run(
        access.identity.accountId,
        prefix,
      )
      res.json({ ok: true })
    }),
  )

  // ---- Inbox ----
  r.get(
    '/api/inbox',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId)
        throw new ApiError(401, 'account required', 'GET /api/inbox needs a token.')
      const accountId = access.identity.accountId
      const items: {
        docId: string
        title: string
        type: string
        message: string
        ts: number
        level?: string
        url?: string
      }[] = []
      const awaiting = db.prepare('SELECT * FROM docs WHERE owner_id=?').all(accountId) as DocRow[]
      for (const d of awaiting) {
        if (statusState(d.content) === 'awaiting-human') {
          items.push({
            docId: d.id,
            title: d.title,
            type: 'status',
            message: 'Agent needs a human (awaiting-human)',
            ts: d.updated_at,
          })
        }
      }
      const asks = db
        .prepare(
          `SELECT a.*, d.title FROM asks a JOIN docs d ON d.id=a.doc_id WHERE d.owner_id=? AND a.state='open'`,
        )
        .all(accountId) as (import('./asks.js').AskRow & { title: string })[]
      for (const a of asks) {
        items.push({
          docId: a.doc_id,
          title: a.title,
          type: 'ask',
          message: a.text,
          ts: a.created_at,
        })
      }
      const logs = db
        .prepare(
          `SELECT n.*, d.title FROM notify_log n JOIN docs d ON d.id=n.doc_id WHERE d.owner_id=? ORDER BY n.created_at DESC LIMIT 200`,
        )
        .all(accountId) as {
        doc_id: string
        title: string
        level: string
        message: string
        created_at: number
      }[]
      for (const l of logs) {
        items.push({
          docId: l.doc_id,
          title: l.title,
          type: 'notify',
          message: l.message,
          ts: l.created_at,
          level: l.level,
        })
      }
      const prs = db
        .prepare(
          `SELECT p.id AS project_id, p.name AS project_name, w.pr_number, w.title, w.url, w.updated_at
           FROM pr_watch w JOIN projects p ON p.id = w.project_id
           WHERE p.owner_id=? ORDER BY w.updated_at DESC`,
        )
        .all(accountId) as {
        project_id: string
        project_name: string
        pr_number: number
        title: string
        url: string
        updated_at: number
      }[]
      for (const pr of prs) {
        items.push({
          docId: pr.project_id,
          title: `${pr.project_name} · PR #${pr.pr_number}`,
          type: 'pr',
          message: pr.title,
          ts: pr.updated_at,
          url: pr.url,
        })
      }
      items.sort((a, b) => b.ts - a.ts)
      res.json({ items: items.slice(0, 200) })
    }),
  )

  // ---- Folders ----
  r.post(
    '/api/folders',
    asyncHandler((req: Request, res: Response) => {
      const access = requireAccount(services, req)
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : ''
      if (!name) throw badRequest('name required')
      const parentId =
        typeof req.body?.parentId === 'string' && req.body.parentId !== ''
          ? req.body.parentId
          : null
      if (parentId) {
        const parent = db
          .prepare('SELECT parent_id FROM folders WHERE id=? AND owner_id=?')
          .get(parentId, access) as { parent_id: string | null } | undefined
        if (!parent) throw notFound('folder not found')
        if (parent.parent_id)
          throw badRequest(
            'folders accept one level of nesting',
            'A child folder cannot have children.',
          )
      }
      const id = randomId(12)
      db.prepare(
        'INSERT INTO folders (id, owner_id, name, parent_id, created_at) VALUES (?,?,?,?,?)',
      ).run(id, access, name, parentId, now())
      res.status(201).json({ folder: { id, name, parentId, created_at: now() } })
    }),
  )

  r.get(
    '/api/folders',
    asyncHandler((req: Request, res: Response) => {
      const accountId = requireAccount(services, req)
      const rows = db.prepare('SELECT * FROM folders WHERE owner_id=?').all(accountId) as {
        id: string
        name: string
        parent_id: string | null
        created_at: number
      }[]
      const counts = new Map<string, { direct: number; recursive: number; last: number }>()
      for (const f of rows) counts.set(f.id, { direct: 0, recursive: 0, last: 0 })
      const docs = db
        .prepare('SELECT folder_id, updated_at FROM docs WHERE owner_id=?')
        .all(accountId) as {
        folder_id: string | null
        updated_at: number
      }[]
      for (const d of docs) {
        if (d.folder_id) {
          const c = counts.get(d.folder_id)
          if (c) {
            c.direct++
            c.recursive++
            c.last = Math.max(c.last, d.updated_at)
          }
        }
      }
      type FolderNode = {
        id: string
        name: string
        parentId: string | null
        created_at: number
        directDocCount: number
        docCount: number
        lastActivity: number
        children: FolderNode[]
      }
      const children = (id: string | null): FolderNode[] =>
        rows
          .filter((f) => f.parent_id === id)
          .map((f) => {
            const kids = children(f.id)
            const direct = counts.get(f.id)!
            const recursive = direct.direct + kids.reduce((sum, k) => sum + k.docCount, 0)
            const last = kids.reduce((max, k) => Math.max(max, k.lastActivity), direct.last)
            return {
              id: f.id,
              name: f.name,
              parentId: f.parent_id,
              created_at: f.created_at,
              directDocCount: direct.direct,
              docCount: recursive,
              lastActivity: last,
              children: kids,
            }
          })
      res.json({ folders: children(null) })
    }),
  )

  r.get(
    '/api/folders/:id',
    asyncHandler((req: Request, res: Response) => {
      const token = bearerToken(req)
      const session = sessionCookie(req)
      const accountId = token
        ? (accountFromToken(db, token)?.id ?? null)
        : session
          ? (accountFromSession(db, session)?.id ?? null)
          : null
      const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(req.params.id!) as
        | {
            id: string
            owner_id: string
            name: string
            parent_id: string | null
            created_at: number
          }
        | undefined
      if (!folder) throw notFound('folder not found')
      const folderKey = shareKeyOf(req)
      const role: Role | null =
        accountId === folder.owner_id
          ? 'edit'
          : (activeFolderRole(db, folder.id, folderKey) ?? null)
      const subfolders = db
        .prepare('SELECT id, name, parent_id, created_at FROM folders WHERE parent_id=?')
        .all(folder.id) as {
        id: string
        name: string
        parent_id: string | null
        created_at: number
      }[]
      const docs = db.prepare('SELECT * FROM docs WHERE folder_id=?').all(folder.id) as DocRow[]
      res.json({
        folder: {
          id: folder.id,
          name: folder.name,
          parentId: folder.parent_id,
          created_at: folder.created_at,
          role,
        },
        subfolders: subfolders.map((s) => ({
          id: s.id,
          name: s.name,
          parentId: s.parent_id,
          created_at: s.created_at,
        })),
        docs: docs.map((d) => ({
          id: d.id,
          title: d.title,
          status_state: statusState(d.content),
          updated_at: d.updated_at,
          last_actor: null,
          last_activity: d.updated_at,
        })),
      })
    }),
  )

  r.patch(
    '/api/folders/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = requireAccount(services, req)
      const folder = db
        .prepare('SELECT * FROM folders WHERE id=? AND owner_id=?')
        .get(req.params.id!, accountId) as
        { id: string; name: string; parent_id: string | null } | undefined
      if (!folder) throw notFound('folder not found')
      const name =
        typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 100) : undefined
      const parentId =
        req.body?.parentId === null
          ? null
          : typeof req.body?.parentId === 'string'
            ? req.body.parentId
            : undefined
      if (name) db.prepare('UPDATE folders SET name=? WHERE id=?').run(name, folder.id)
      if (parentId !== undefined) {
        if (parentId !== null) {
          const parent = db
            .prepare('SELECT parent_id FROM folders WHERE id=? AND owner_id=?')
            .get(parentId, accountId) as { parent_id: string | null } | undefined
          if (!parent || parent.parent_id) throw badRequest('folders accept one level of nesting')
        }
        db.prepare('UPDATE folders SET parent_id=? WHERE id=?').run(parentId, folder.id)
      }
      res.json({ ok: true })
    }),
  )

  r.delete(
    '/api/folders/:id',
    asyncHandler((req: Request, res: Response) => {
      const accountId = requireAccount(services, req)
      const folder = db
        .prepare('SELECT id FROM folders WHERE id=? AND owner_id=?')
        .get(req.params.id!, accountId)
      if (!folder) throw notFound('folder not found')
      db.prepare('UPDATE docs SET folder_id=NULL WHERE folder_id=?').run(req.params.id!)
      db.prepare('UPDATE folders SET parent_id=NULL WHERE parent_id=?').run(req.params.id!)
      db.prepare('DELETE FROM folders WHERE id=?').run(req.params.id!)
      res.json({ ok: true })
    }),
  )

  r.post(
    '/api/docs/:id/move',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (access.role !== 'owner') throw forbidden('only the owner can move this document')
      const folderId =
        req.body?.folderId === null
          ? null
          : typeof req.body?.folderId === 'string'
            ? req.body.folderId
            : undefined
      if (folderId !== undefined && folderId !== null) {
        const folder = db
          .prepare('SELECT id FROM folders WHERE id=? AND owner_id=?')
          .get(folderId, access.identity.accountId)
        if (!folder) throw notFound('folder not found')
      }
      db.prepare('UPDATE docs SET folder_id=?, updated_at=? WHERE id=?').run(
        folderId ?? null,
        now(),
        doc.id,
      )
      res.json({ ok: true })
    }),
  )

  r.post(
    '/api/folders/:id/shares',
    asyncHandler((req: Request, res: Response) => {
      const accountId = requireAccount(services, req)
      const folder = db
        .prepare('SELECT id FROM folders WHERE id=? AND owner_id=?')
        .get(req.params.id!, accountId)
      if (!folder) throw notFound('folder not found')
      const role = req.body?.role
      if (!['view', 'comment', 'suggest', 'edit'].includes(role)) throw badRequest('invalid role')
      const existing = db
        .prepare(
          'SELECT secret FROM folder_shares WHERE folder_id=? AND role=? AND revoked_at IS NULL',
        )
        .get(req.params.id!, role) as { secret: string } | undefined
      const key = existing?.secret ?? secret(24)
      if (!existing) {
        db.prepare(
          'INSERT INTO folder_shares (secret, folder_id, role, created_at) VALUES (?,?,?,?)',
        ).run(key, req.params.id!, role, now())
      }
      const base = clientUrl(req, services.config.publicUrl)
      res.json({
        share: {
          secret: key,
          role,
          folderId: req.params.id!,
          url: `${base}/folders/${req.params.id}?key=${encodeURIComponent(key)}`,
          api_url: `${base}/api/folders/${req.params.id}?key=${encodeURIComponent(key)}`,
        },
      })
    }),
  )

  r.get(
    '/api/folders/:id/shares',
    asyncHandler((req: Request, res: Response) => {
      requireAccount(services, req)
      const rows = db
        .prepare(
          'SELECT secret, role, created_at FROM folder_shares WHERE folder_id=? AND revoked_at IS NULL',
        )
        .all(req.params.id!) as { secret: string; role: string; created_at: number }[]
      res.json({ shares: rows.map((s) => ({ secret: s.secret, role: s.role })) })
    }),
  )

  r.delete(
    '/api/folders/:id/shares/:secret',
    asyncHandler((req: Request, res: Response) => {
      requireAccount(services, req)
      db.prepare('UPDATE folder_shares SET revoked_at=? WHERE folder_id=? AND secret=?').run(
        now(),
        req.params.id!,
        req.params.secret!,
      )
      res.json({ ok: true })
    }),
  )

  // ---- Search ----
  r.get(
    '/api/search',
    asyncHandler((req: Request, res: Response) => {
      const q = typeof req.query.q === 'string' ? req.query.q : ''
      if (!q.trim()) throw badRequest('q required', 'Send ?q=launch+plan')
      const folderFilter = /folder:"([^"]+)"|folder:([A-Za-z0-9_-]+)/.exec(q)
      const query = q.replace(/folder:"[^"]+"|folder:[A-Za-z0-9_-]+/g, '').trim()
      const access = resolveAccess(db, req, '')
      const key = req.query.key
      const keyStr = typeof key === 'string' ? key : undefined
      let candidates: DocRow[]
      if (keyStr) {
        const docShare = db
          .prepare('SELECT doc_id FROM shares WHERE secret=? AND revoked_at IS NULL')
          .get(keyStr) as { doc_id: string } | undefined
        if (docShare) {
          const d = db.prepare('SELECT * FROM docs WHERE id=?').get(docShare.doc_id) as
            DocRow | undefined
          candidates = d ? [d] : []
        } else {
          const fShare = db
            .prepare('SELECT folder_id FROM folder_shares WHERE secret=? AND revoked_at IS NULL')
            .get(keyStr) as { folder_id: string } | undefined
          candidates = fShare
            ? (db.prepare('SELECT * FROM docs WHERE folder_id=?').all(fShare.folder_id) as DocRow[])
            : []
        }
      } else if (access.identity.accountId) {
        candidates = db
          .prepare('SELECT * FROM docs WHERE owner_id=?')
          .all(access.identity.accountId) as DocRow[]
        const sharedFolders = db
          .prepare(
            'SELECT folder_id FROM folder_shares WHERE revoked_at IS NULL AND folder_id IN (SELECT id FROM folders WHERE owner_id=?)',
          )
          .all(access.identity.accountId) as { folder_id: string }[]
        for (const f of sharedFolders) {
          candidates.push(
            ...(db.prepare('SELECT * FROM docs WHERE folder_id=?').all(f.folder_id) as DocRow[]),
          )
        }
        const seen = new Set(candidates.map((c) => c.id))
        candidates = candidates.filter((c) => !seen.has(c.id) || seen.delete(c.id))
      } else {
        throw new ApiError(
          401,
          'account or key required',
          'Search needs a token or a document/folder key.',
        )
      }
      if (folderFilter) {
        const fname = (folderFilter[1] ?? folderFilter[2] ?? '').toLowerCase()
        const folderIds = new Set(
          (
            db.prepare('SELECT id FROM folders WHERE lower(name)=?').all(fname) as { id: string }[]
          ).map((f) => f.id),
        )
        candidates = candidates.filter((c) => c.folder_id && folderIds.has(c.folder_id))
      }
      const scored = candidates
        .map((d) => ({ doc: d, score: scoreDoc(d, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.doc.updated_at - a.doc.updated_at)
        .slice(0, 50)
      const results = scored.map((x) => ({
        docId: x.doc.id,
        title: x.doc.title,
        folderId: x.doc.folder_id,
        snippet: snippet(x.doc.content, query),
        score: x.score,
        updated_at: x.doc.updated_at,
        status_state: statusState(x.doc.content),
      }))
      res.json({ query: q, results })
    }),
  )

  // ---- Agents ----
  r.post(
    '/api/agents/register',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (access.identity.kind !== 'token' || !access.identity.accountId) {
        throw new ApiError(
          401,
          'account token required',
          'Register with Authorization: Bearer mgn_…',
        )
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 40) : ''
      if (!name) throw badRequest('name required')
      const role = req.body?.role === 'chief' ? 'chief' : 'agent'
      const harness =
        typeof req.body?.harness === 'string' ? req.body.harness.slice(0, 80) : undefined
      const machine =
        typeof req.body?.machine === 'string' ? req.body.machine.slice(0, 120) : undefined
      const accountId = access.identity.accountId
      const existing = db
        .prepare('SELECT id FROM agents WHERE account_id=? AND name=?')
        .get(accountId, name) as { id: string } | undefined
      if (role === 'chief') {
        db.prepare("UPDATE agents SET role='agent' WHERE account_id=? AND role='chief'").run(
          accountId,
        )
      }
      if (existing) {
        db.prepare('UPDATE agents SET harness=?, machine=?, role=?, last_seen_at=? WHERE id=?').run(
          harness ?? null,
          machine ?? null,
          role,
          now(),
          existing.id,
        )
      } else {
        db.prepare(
          'INSERT INTO agents (id, account_id, name, harness, machine, role, registered_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(randomId(14), accountId, name, harness ?? null, machine ?? null, role, now(), now())
      }
      res.json({ agent: { id: existing?.id ?? name, name, freshness: 'live', role } })
    }),
  )

  r.post(
    '/api/agents/heartbeat',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (access.identity.kind !== 'token' || !access.identity.accountId) {
        throw new ApiError(401, 'account token required')
      }
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 40) : ''
      if (!name) throw badRequest('name required')
      const agent = db
        .prepare('SELECT id FROM agents WHERE account_id=? AND name=?')
        .get(access.identity.accountId, name) as { id: string } | undefined
      if (!agent)
        throw notFound('agent not registered', 'Register first with POST /api/agents/register.')
      const currentDoc =
        req.body?.currentDoc === null
          ? null
          : typeof req.body?.currentDoc === 'string'
            ? req.body.currentDoc
            : undefined
      const currentTask =
        req.body?.currentTask === null
          ? null
          : typeof req.body?.currentTask === 'string'
            ? req.body.currentTask
            : undefined
      db.prepare(
        'UPDATE agents SET last_seen_at=?, current_doc=COALESCE(?, current_doc), current_task=COALESCE(?, current_task) WHERE id=?',
      ).run(now(), currentDoc ?? null, currentTask ?? null, agent.id)
      res.json({ ok: true })
    }),
  )

  r.get(
    '/api/agents',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const rows = db
        .prepare('SELECT * FROM agents WHERE account_id=?')
        .all(access.identity.accountId) as {
        id: string
        name: string
        harness: string | null
        machine: string | null
        role: string
        current_doc: string | null
        current_task: string | null
        last_seen_at: number
      }[]
      res.json({
        agents: rows.map((a) => ({
          id: a.id,
          name: a.name,
          harness: a.harness,
          machine: a.machine,
          role: a.role,
          currentDoc: a.current_doc,
          currentTask: a.current_task,
          freshness: freshness(a.last_seen_at),
        })),
      })
    }),
  )

  r.delete(
    '/api/agents/:name',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      db.prepare('DELETE FROM agents WHERE account_id=? AND name=?').run(
        access.identity.accountId,
        req.params.name!,
      )
      res.json({ ok: true })
    }),
  )

  // ---- Hooks ----
  r.post(
    '/api/docs/:id/hooks',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
      if (!/^https?:\/\//.test(url))
        throw badRequest(
          'url must be an http(s) URL',
          'Private/LAN URLs are allowed for local use.',
        )
      const events = Array.isArray(req.body?.events)
        ? req.body.events.filter((e: unknown) => typeof e === 'string')
        : null
      const excludeActor =
        typeof req.body?.excludeActor === 'string' ? req.body.excludeActor : undefined
      const id = randomId(14)
      const hookSecret = newHookSecret()
      db.prepare(
        'INSERT INTO hooks (id, doc_id, url, secret, events, exclude_actor, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        id,
        doc.id,
        url,
        hookSecret,
        events ? JSON.stringify(events) : null,
        excludeActor ?? null,
        now(),
      )
      res.status(201).json({ hook: { id, secret: hookSecret } })
    }),
  )

  r.get(
    '/api/docs/:id/hooks',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const rows = db
        .prepare('SELECT id, url, events, exclude_actor, created_at FROM hooks WHERE doc_id=?')
        .all(doc.id)
      res.json({ hooks: rows })
    }),
  )

  r.delete(
    '/api/docs/:id/hooks/:hid',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      db.prepare('DELETE FROM hooks WHERE id=? AND doc_id=?').run(req.params.hid!, doc.id)
      res.json({ ok: true })
    }),
  )

  // ---- Assets ----
  const rawBody = express.raw({ type: () => true, limit: '50mb' })
  r.post(
    '/api/docs/:id/assets',
    rawBody,
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const ctype = (req.headers['content-type'] ?? 'application/octet-stream')
        .split(';')[0]!
        .trim()
        .toLowerCase()
      const spec = MIME_TABLE[ctype]
      if (!spec) {
        throw new ApiError(
          415,
          'asset type not accepted',
          'Upload an allowed image, video, audio, or readable code/text type.',
          {
            code: 'asset_not_readable',
          },
        )
      }
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      if (bytes.length === 0) throw badRequest('empty upload')
      if (bytes.length > spec.max)
        throw badRequest('asset too large', `Maximum is ${Math.floor(spec.max / 1024 / 1024)} MB.`)
      const rawName = (req.headers['x-asset-name'] ??
        (typeof req.query.name === 'string' ? req.query.name : undefined)) as string | undefined
      const name = rawName ? validateAssetName(rawName) : null
      const digest = sha256(bytes)
      const dir = join(services.config.dataDir, 'assets')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, digest)
      if (!existsSync(file)) writeFileSync(file, bytes)
      db.prepare(
        'INSERT OR IGNORE INTO assets (sha256, doc_id, kind, mime, name, size, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(digest, doc.id, spec.kind, ctype, name, bytes.length, now())
      const base = clientUrl(req, services.config.publicUrl)
      const ext = name?.split('.').pop() ?? ctype.split('/')[1] ?? 'bin'
      const url = `${base}/f/${digest}.${ext}`
      const markdown =
        spec.kind === 'code' ? url : spec.kind === 'video' ? `![](${url}.mp4)` : `![](${url})`
      res.json({
        url,
        name: name ?? null,
        kind: spec.kind,
        size: bytes.length,
        markdown,
        ...(name ? { manifestPath: name } : {}),
      })
    }),
  )

  r.get(
    '/f/:file',
    asyncHandler((req: Request, res: Response) => {
      const file = req.params.file!
      const digest = file.split('.')[0]!
      const row = db.prepare('SELECT * FROM assets WHERE sha256=?').get(digest) as
        { mime: string; kind: string; size: number } | undefined
      if (!row) throw notFound('asset not found')
      const path = join(services.config.dataDir, 'assets', digest)
      if (!existsSync(path)) throw notFound('asset not found')
      const stat = statSync(path)
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Cache-Control', 'public, max-age=31536000, immutable')
      const range = req.headers.range
      if (range && /^bytes=(\d+)-(\d*)$/.test(range)) {
        const m = /^bytes=(\d+)-(\d*)$/.exec(range)!
        const start = Number(m[1])
        const end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1
        res.status(206)
        res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        res.set('Content-Length', String(end - start + 1))
        res.set('Content-Type', row.mime)
        createReadStream(path, { start, end }).pipe(res)
      } else {
        res.set('Content-Length', String(stat.size))
        res.set('Content-Type', row.mime)
        createReadStream(path).pipe(res)
      }
    }),
  )

  return r
}

function requireAccount(services: AppServices, req: Request): string {
  const access = resolveAccess(services.db, req, '')
  if (!access.identity.accountId)
    throw new ApiError(401, 'account required', 'Sign in or pass an account token.')
  return access.identity.accountId
}

function activeFolderRole(db: Db, folderId: string, key: string | undefined): Role | null {
  if (!key) return null
  const row = db
    .prepare('SELECT role FROM folder_shares WHERE folder_id=? AND secret=? AND revoked_at IS NULL')
    .get(folderId, key) as { role: Role } | undefined
  return row?.role ?? null
}

function shareKeyOf(req: Request): string | undefined {
  const q = req.query.key
  const h = req.headers['x-share-key']
  const v = typeof q === 'string' ? q : typeof h === 'string' ? h : undefined
  return v && v.length > 0 ? v : undefined
}

function freshness(ts: number): 'live' | 'idle' | 'stale' {
  const age = now() - ts
  if (age < 2 * 60_000) return 'live'
  if (age < 30 * 60_000) return 'idle'
  return 'stale'
}

function scoreDoc(doc: DocRow, query: string): number {
  const q = query.toLowerCase()
  const title = doc.title.toLowerCase()
  const id = doc.id.toLowerCase()
  if (id === q) return 1000
  if (title.startsWith(q)) return 900
  if (title.includes(q)) return 800
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 700
  const content = doc.content.toLowerCase()
  if (content.includes(q)) return 100 + Math.min(content.indexOf(q), 100)
  return 0
}

function snippet(content: string, query: string): string {
  const idx = content.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return content.slice(0, 200)
  const start = Math.max(0, idx - 60)
  const before = start > 0 ? '…' : ''
  const after = idx + query.length + 60 < content.length ? '…' : ''
  const piece = content.slice(start, Math.min(content.length, idx + query.length + 60))
  const marked = piece.replace(new RegExp(`(${escapeRegExp(query)})`, 'gi'), '<mark>$1</mark>')
  return `${before}${escapeHtml(marked)}${after}`
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const MIME_TABLE: Record<string, { kind: string; max: number }> = {
  'image/png': { kind: 'image', max: 10 * 1024 * 1024 },
  'image/jpeg': { kind: 'image', max: 10 * 1024 * 1024 },
  'image/gif': { kind: 'image', max: 10 * 1024 * 1024 },
  'image/webp': { kind: 'image', max: 10 * 1024 * 1024 },
  'video/mp4': { kind: 'video', max: 50 * 1024 * 1024 },
  'video/webm': { kind: 'video', max: 50 * 1024 * 1024 },
  'audio/mpeg': { kind: 'audio', max: 50 * 1024 * 1024 },
  'audio/wav': { kind: 'audio', max: 50 * 1024 * 1024 },
  'audio/ogg': { kind: 'audio', max: 50 * 1024 * 1024 },
  'application/javascript': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/css': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/wasm': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/json': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/plain': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/markdown': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/x-python': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/x-sh': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/x-shellscript': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/x-typescript': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/typescript': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/yaml': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/yaml': { kind: 'code', max: 10 * 1024 * 1024 },
  'application/toml': { kind: 'code', max: 10 * 1024 * 1024 },
  'text/csv': { kind: 'code', max: 10 * 1024 * 1024 },
}

function validateAssetName(name: string): string {
  const n = name.trim()
  if (n.length > 240) throw badRequest('asset name too long', 'Maximum 240 characters.')
  if (n.startsWith('/') || n.includes('..') || n.split('/').some((s) => s.length === 0)) {
    throw badRequest('invalid asset name', 'Use a safe relative path like scripts/foo.py')
  }
  if (!/^[A-Za-z0-9._/ -]+$/.test(n))
    throw badRequest('invalid asset name', 'Only letters, numbers, . _ - / and spaces.')
  return n
}
