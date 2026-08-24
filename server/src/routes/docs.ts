import express, { type Request, type Response } from 'express'
import {
  ApiError,
  badRequest,
  conflict,
  contentVersion,
  forbidden,
  hasComponents,
  notFound,
  randomId,
  statusState,
} from '@can-bang/core'
import type { AppServices } from '../service.js'
import type { Db, DocRow } from '../db.js'
import { bumpContent, docVersion } from '../db.js'
import {
  attribution,
  mintShare,
  requireRole,
  resolveAccess,
  shareKey,
  touchAgent,
} from '../auth.js'
import { asyncHandler, clientUrl, jsonError, pick } from '../util.js'
import { now } from '@can-bang/core'

export function getDoc(db: Db, id: string): DocRow {
  const row = db.prepare('SELECT * FROM docs WHERE id=?').get(id) as DocRow | undefined
  if (!row) throw notFound('document not found', 'Check the document id in the URL.')
  return row
}

export function docUrl(req: Request, services: AppServices, docId: string, key?: string): string {
  const base = clientUrl(req, services.config.publicUrl)
  return key ? `${base}/d/${docId}?key=${encodeURIComponent(key)}` : `${base}/d/${docId}`
}

function unclaimedNotice(doc: DocRow): string | null {
  if (doc.owner_id) return null
  const valuable =
    doc.content.length > 500 || statusState(doc.content) === 'awaiting-human' || doc.content_seq > 2
  return valuable
    ? 'This document belongs to no account. Open the link in a browser, sign in free, and click "Claim this doc" to protect it.'
    : null
}

function metadata(doc: DocRow, role: string, notice: string | null) {
  return {
    id: doc.id,
    title: doc.title,
    kind: doc.kind,
    role,
    status_state: statusState(doc.content),
    updated_at: doc.updated_at,
    created_at: doc.created_at,
    last_actor: null,
    last_activity: doc.updated_at,
    folderId: doc.folder_id,
    ...(notice ? { unclaimed: true } : {}),
  }
}

export function docsRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  // POST /new — anonymous doc creation (JSON)
  r.post(
    '/new',
    asyncHandler((req: Request, res: Response) => {
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : 'Untitled'
      const content = typeof req.body?.content === 'string' ? req.body.content : ''
      const kind = req.body?.kind === 'plain' ? 'plain' : 'live'
      const id = randomId(22)
      db.prepare(
        'INSERT INTO docs (id, title, kind, content, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(id, title, kind, content, now(), now())
      const key = mintShare(db, id, 'edit').secret
      bumpContent(db, id, content, 'Guest', true, kind, 'initial')
      res.status(201).json({ url: docUrl(req, services, id, key), id, key, kind })
    }),
  )

  // POST /api/docs — owned doc creation (token auth)
  r.post(
    '/api/docs',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (access.identity.kind !== 'token' && access.identity.kind !== 'session') {
        throw new ApiError(
          401,
          'account token required',
          'POST /api/docs needs Authorization: Bearer mgn_…',
        )
      }
      const accountId = access.identity.accountId!
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : 'Untitled'
      const content = typeof req.body?.content === 'string' ? req.body.content : ''
      const kind = req.body?.kind === 'plain' ? 'plain' : 'live'
      const id = randomId(22)
      db.prepare(
        'INSERT INTO docs (id, title, kind, owner_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, title, kind, accountId, content, now(), now())
      bumpContent(db, id, content, access.identity.name, false, kind, 'initial')
      res.status(201).json({ doc: { id, url: docUrl(req, services, id), kind } })
    }),
  )

  // GET /api/docs — account-scoped listing
  r.get(
    '/api/docs',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      const accountId = access.identity.accountId
      if (!accountId)
        throw new ApiError(401, 'account token required', 'GET /api/docs needs a token.')
      const rows = db
        .prepare('SELECT * FROM docs WHERE owner_id=? ORDER BY updated_at DESC LIMIT 500')
        .all(accountId) as DocRow[]
      const docs = rows.map((d) => ({
        id: d.id,
        title: d.title,
        kind: d.kind,
        status_state: statusState(d.content),
        updated_at: d.updated_at,
        last_actor: null,
        last_activity: d.updated_at,
        folderId: d.folder_id,
      }))
      res.json({ docs })
    }),
  )

  // GET /api/docs/:id — metadata with role
  r.get(
    '/api/docs/:id',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role)
        throw forbidden('you do not have access to this document', 'Ask for a share link.')
      res.json(metadata(doc, access.role, unclaimedNotice(doc)))
    }),
  )

  // GET /api/docs/:id/content — raw markdown
  r.get(
    '/api/docs/:id/content',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role)
        throw forbidden('you do not have access to this document', 'Ask for a share link.')
      const version = docVersion(doc)
      const notice = unclaimedNotice(doc)
      res
        .set('ETag', `"${version}"`)
        .set('X-Doc-Version', version)
        .set('Cache-Control', 'private, no-store')
        .set('X-Robots-Tag', 'noindex')
        .set('Vary', 'Accept, Authorization, X-Share-Key')
        .type('text/markdown')
      if (notice) res.set('X-Workbench-Unclaimed', notice)
      res.send(doc.content)
    }),
  )

  // PUT /api/docs/:id/content — replace with optimistic concurrency + wipe guard
  const textBody = express.text({ type: ['text/markdown', 'text/plain'], limit: '2mb' })
  r.put(
    '/api/docs/:id/content',
    textBody,
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const isText = typeof req.body === 'string'
      const content = isText
        ? req.body
        : typeof req.body?.content === 'string'
          ? req.body.content
          : undefined
      if (content === undefined) {
        throw badRequest(
          'content required',
          'Send {"content": "…"} or PUT raw markdown. Empty body clears the doc.',
        )
      }
      const current = docVersion(doc)
      const ifMatch = req.headers['if-match']?.toString()
      const baseVersion =
        typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined
      const allowClear = req.headers['x-allow-clear'] === '1' || req.body?.allowClear === true
      const hasProof = Boolean(ifMatch || baseVersion || allowClear)
      if ((ifMatch || baseVersion) && (ifMatch ?? baseVersion) !== current) {
        throw conflict(
          'document changed since you read it',
          'Re-read, reapply your changes, and retry with the new version.',
          {
            currentVersion: current,
            use: {
              read: 'GET /api/docs/:id/content',
              replace: 'PUT /api/docs/:id/content',
              confirmClear: 'PUT with X-Allow-Clear: 1',
            },
          },
        )
      }
      const shrink = doc.content.length > 2000 && content.length < doc.content.length * 0.1
      if (shrink && !hasProof) {
        throw conflict(
          'blind-wipe guard',
          'Prove intent with If-Match/baseVersion, or opt in with X-Allow-Clear: 1.',
          {
            currentVersion: current,
            use: {
              read: 'GET /api/docs/:id/content',
              replace: 'PUT /api/docs/:id/content',
              confirmClear: 'PUT with X-Allow-Clear: 1',
            },
          },
        )
      }
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const label = typeof req.body?.label === 'string' ? req.body.label.slice(0, 200) : undefined
      const kind = doc.kind === 'plain' && !hasComponents(content) ? 'plain' : 'live'
      const bumped = bumpContent(db, doc.id, content, who.name, who.guest, kind, label)
      repinComments(db, doc.id, content)
      services.emit(doc.id, 'content.replaced', who.name, who.guest, {
        version: bumped.version,
        via: 'api',
        ...(label ? { label } : {}),
      })
      res.set('ETag', `"${bumped.version}"`).json({ ok: true, version: bumped.version })
    }),
  )

  // PATCH /api/docs/:id — title metadata only
  r.patch(
    '/api/docs/:id',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const title =
        typeof req.body?.title === 'string' && req.body.title.trim()
          ? req.body.title.trim().slice(0, 200)
          : undefined
      if (!title) throw badRequest('title required', 'Send {"title": "…"}')
      db.prepare('UPDATE docs SET title=?, updated_at=? WHERE id=?').run(title, now(), doc.id)
      res.json({ ok: true })
    }),
  )

  // DELETE /api/docs/:id
  r.delete(
    '/api/docs/:id',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      const ownerCapable = access.identity.kind === 'token' || access.identity.kind === 'session'
      if (doc.owner_id) {
        if (!ownerCapable || access.identity.accountId !== doc.owner_id) {
          throw forbidden('only the owner can delete this document')
        }
      } else if (access.role !== 'edit') {
        throw forbidden('the edit key is required to delete an anonymous document')
      }
      db.prepare('DELETE FROM docs WHERE id=?').run(doc.id)
      res.json({ ok: true })
    }),
  )

  // POST /api/docs/:id/claim — claim an anonymous doc into a session account
  r.post(
    '/api/docs/:id/claim',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (access.identity.kind !== 'session' || !access.identity.accountId) {
        throw new ApiError(
          401,
          'sign in required to claim a document',
          'Claim from your signed-in browser session.',
        )
      }
      if (doc.owner_id) throw conflict('document already claimed')
      if (access.role !== 'edit') throw forbidden('the edit key is required to claim this document')
      db.prepare('UPDATE docs SET owner_id=? WHERE id=?').run(access.identity.accountId, doc.id)
      services.emit(doc.id, 'doc.claimed', access.identity.name, false, {})
      res.json({ claimed: true })
    }),
  )

  // POST /api/docs/:id/duplicate — account-scoped copy
  r.post(
    '/api/docs/:id/duplicate',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.identity.accountId)
        throw new ApiError(401, 'account required', 'Duplicate needs a signed-in account.')
      const id = randomId(22)
      db.prepare(
        'INSERT INTO docs (id, title, kind, owner_id, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        id,
        `${doc.title} (copy)`,
        doc.kind,
        access.identity.accountId,
        doc.content,
        now(),
        now(),
      )
      bumpContent(db, id, doc.content, access.identity.name, false, doc.kind, 'duplicate')
      res.status(201).json({ doc: { id, url: docUrl(req, services, id), kind: doc.kind } })
    }),
  )

  // POST /api/docs/:id/feedback — private product feedback
  r.post(
    '/api/docs/:id/feedback',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw forbidden('you do not have access to this document')
      const summary = typeof req.body?.summary === 'string' ? req.body.summary.slice(0, 2000) : ''
      if (!summary) throw badRequest('summary required')
      db.prepare(
        'INSERT INTO feedback (doc_id, summary, category, operation, attempted, expected, workaround, client, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(
        doc.id,
        summary,
        req.body?.category ?? null,
        req.body?.operation ?? null,
        req.body?.attempted ?? null,
        req.body?.expected ?? null,
        req.body?.workaround ?? null,
        req.body?.client ?? null,
        now(),
      )
      res.json({ ok: true })
    }),
  )

  // Shares
  r.post(
    '/api/docs/:id/shares',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const role = req.body?.role
      if (!['view', 'comment', 'suggest', 'edit'].includes(role)) {
        throw badRequest('role required', 'role must be view, comment, suggest, or edit')
      }
      const share = mintShare(db, doc.id, role as 'view')
      res.json({
        share: {
          secret: share.secret,
          role,
          url: docUrl(req, services, doc.id, share.secret),
          agent_url: `${docUrl(req, services, doc.id, share.secret)}/agent`,
        },
      })
    }),
  )

  r.get(
    '/api/docs/:id/shares',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (doc.owner_id && access.identity.accountId !== doc.owner_id) {
        throw forbidden('only the owner can list share links')
      }
      if (!doc.owner_id && access.role !== 'edit')
        throw forbidden('the edit key is required to list share links')
      const shares = db
        .prepare(
          'SELECT secret, role, created_at FROM shares WHERE doc_id=? AND revoked_at IS NULL',
        )
        .all(doc.id) as { secret: string; role: string; created_at: number }[]
      res.json({ shares: shares.map((s) => ({ secret: s.secret, role: s.role })) })
    }),
  )

  r.delete(
    '/api/docs/:id/shares/:secret',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (doc.owner_id && access.identity.accountId !== doc.owner_id) {
        throw forbidden('only the owner can revoke share links')
      }
      if (!doc.owner_id && access.role !== 'edit')
        throw forbidden('the edit key is required to revoke share links')
      const target = req.params.secret!
      if (!doc.owner_id && target === shareKey(req)) {
        throw conflict(
          'cannot revoke the anonymous edit key',
          'Claim the document into an account before rotating access.',
        )
      }
      db.prepare('UPDATE shares SET revoked_at=? WHERE doc_id=? AND secret=?').run(
        now(),
        doc.id,
        target,
      )
      res.json({ ok: true })
    }),
  )

  return r
}

/** Re-pin open comments after a content replacement. */
export function repinComments(db: Db, docId: string, content: string): void {
  const open = db
    .prepare('SELECT id, find FROM comments WHERE doc_id=? AND resolved=0 AND find IS NOT NULL')
    .all(docId) as { id: string; find: string }[]
  for (const c of open) {
    const idx = looseIndexOf(content, c.find)
    db.prepare('UPDATE comments SET anchored=?, anchor_from=?, anchor_to=? WHERE id=?').run(
      idx >= 0 ? 1 : 0,
      idx >= 0 ? idx : null,
      idx >= 0 ? idx + c.find.length : null,
      c.id,
    )
  }
}

function looseIndexOf(haystack: string, needle: string): number {
  const norm = (s: string) => s.replace(/\s+/g, '')
  return norm(haystack).indexOf(norm(needle))
}
