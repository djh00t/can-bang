import express, { type Request, type Response } from 'express'
import {
  ApiError,
  appendFenceLine,
  badRequest,
  conflict,
  findFence,
  notFound,
  parseChat,
  randomId,
  replaceFenceBody,
  statusState,
} from '@can-bang/core'
import type { AppServices } from '../service.js'
import { chatLine, statusLine } from '../service.js'
import type { Db, DocRow } from '../db.js'
import { bumpContent, docVersion } from '../db.js'
import { attribution, requireRole, resolveAccess, touchAgent } from '../auth.js'
import { asyncHandler, jsonError, mentionsActor } from '../util.js'
import { getDoc } from './docs.js'
import { now, iso } from '@can-bang/core'

function stampKind(
  services: AppServices,
  req: Request,
  doc: DocRow,
): 'owner' | 'agent' | 'guest' | 'member' {
  const identity = resolveAccess(services.db, req, doc.id).identity
  if (identity.kind === 'token') return 'agent'
  if (identity.kind === 'session') return identity.accountId === doc.owner_id ? 'owner' : 'member'
  return 'guest'
}

export function collabRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  // POST /api/docs/:id/chat/message
  r.post(
    '/api/docs/:id/chat/message',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : ''
      if (!text.trim()) throw badRequest('text required', 'Send {"text": "…"}')
      const fenceId = typeof req.body?.fence === 'string' ? req.body.fence : undefined
      const fence = findFence(doc.content, 'chat', fenceId)
      if (!fence)
        throw badRequest(
          'no chat fence found',
          'Add a ```chat fence (optionally with #id) to the document.',
        )
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const kind = stampKind(services, req, doc)
      const updated = appendFenceLine(
        doc.content,
        fence,
        chatLine(who.name, text, who.guest ? 'guest' : undefined),
      )
      const newKind = doc.kind === 'plain' ? 'plain' : 'live'
      const bumped = bumpContent(db, doc.id, updated, who.name, who.guest, newKind)
      services.emit(doc.id, 'chat.message', who.name, who.guest, {
        fence: fence.id ?? null,
        text,
        kind,
      })
      res.json({ ok: true, version: bumped.version })
    }),
  )

  // POST /api/docs/:id/status
  r.post(
    '/api/docs/:id/status',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const state = req.body?.state
      if (
        state !== undefined &&
        !['building', 'blocked', 'awaiting-human', 'done'].includes(state)
      ) {
        throw badRequest(
          'invalid state',
          'state must be building, blocked, awaiting-human, or done',
        )
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined
      const headline =
        typeof req.body?.headline === 'string' ? req.body.headline.slice(0, 200) : undefined
      const fenceId = typeof req.body?.fence === 'string' ? req.body.fence : undefined
      const fence = findFence(doc.content, 'status', fenceId)
      if (!fence)
        throw badRequest('no status fence found', 'Add a ```status fence to the document.')
      if (state === 'awaiting-human' && !note) {
        throw badRequest(
          'note required',
          'When setting awaiting-human, the note is the message your human sees.',
        )
      }
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      let body = fence.body
      if (state !== undefined) {
        body = body.replace(
          /^state:\s*(building|blocked|awaiting-human|done)\s*$/m,
          `state: ${state}`,
        )
      }
      if (note) body = `${body}\n${statusLine(note)}`
      const updated = replaceFenceBody(doc.content, fence, body)
      const newKind = doc.kind === 'plain' ? 'plain' : 'live'
      bumpContent(db, doc.id, updated, who.name, who.guest, newKind)
      const finalState = statusState(updated) ?? null
      services.emit(doc.id, 'status.changed', who.name, who.guest, {
        state: finalState,
        ...(note ? { note } : {}),
        ...(headline ? { headline } : {}),
      })
      if (finalState === 'awaiting-human') {
        services.notifyOwner(doc.id, 'ask', note ?? headline ?? 'An agent needs a human.', headline)
      }
      res.json({ state: finalState, ok: true })
    }),
  )

  // POST /api/docs/:id/typing
  r.post(
    '/api/docs/:id/typing',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      services.setTyping(doc.id, access.identity.name || 'Guest')
      res.json({ ok: true })
    }),
  )

  // GET /api/docs/:id/events
  r.get(
    '/api/docs/:id/events',
    asyncHandler(async (req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const sinceRaw = req.query.since
      const waitRaw = Number(req.query.wait ?? 0)
      const wait = Math.min(Math.max(Number.isFinite(waitRaw) ? waitRaw : 0, 0), 55)
      const mention = typeof req.query.mention === 'string' ? req.query.mention : undefined
      const maxSeq = (
        db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE doc_id=?').get(doc.id) as {
          s: number
        }
      ).s
      const since = sinceRaw === 'latest' ? maxSeq : Number(sinceRaw ?? 0)
      if (wait > 0) {
        await services.bus.wait(doc.id, since, wait * 1000)
      }
      const rows = db
        .prepare('SELECT * FROM events WHERE doc_id=? AND seq > ? ORDER BY seq ASC LIMIT 200')
        .all(doc.id, since) as {
        seq: number
        type: string
        ts: number
        actor: string
        guest: number
        payload: string
      }[]
      const newest = (
        db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events WHERE doc_id=?').get(doc.id) as {
          s: number
        }
      ).s
      const events = rows
        .filter(
          (e) => !mention || e.actor === mention || mentionsActor(JSON.parse(e.payload), mention),
        )
        .map((e) => ({
          seq: e.seq,
          type: e.type,
          ts: e.ts,
          actor: e.actor,
          ...(e.guest ? { guest: true } : {}),
          payload: JSON.parse(e.payload),
        }))
      const latest = events.length ? events[events.length - 1]!.seq : since
      const typing = services.getTyping(doc.id)
      const body: Record<string, unknown> = { events, latest }
      if (rows.length >= 200) {
        body.capped = true
        body.tip = newest
      }
      if (typing.length) body.typing = typing
      res.json(body)
    }),
  )

  // Comments
  r.get(
    '/api/docs/:id/comments',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const rows = db
        .prepare('SELECT * FROM comments WHERE doc_id=? ORDER BY created_at ASC')
        .all(doc.id) as {
        id: string
        body: string
        author: string
        guest: number
        anchored: number
        resolved: number
        parent_id: string | null
        created_at: number
        find: string | null
        line: number | null
      }[]
      const comments = rows
        .filter((c) => !c.parent_id)
        .map((c) => ({
          id: c.id,
          body: c.body,
          author: c.author,
          ...(c.guest ? { guest: true } : {}),
          anchored: Boolean(c.anchored),
          resolved: Boolean(c.resolved),
          created_at: c.created_at,
          ...(c.find ? { find: c.find } : {}),
          ...(c.line != null ? { line: c.line } : {}),
          replies: rows
            .filter((x) => x.parent_id === c.id)
            .map((x) => ({ id: x.id, body: x.body, author: x.author, created_at: x.created_at })),
        }))
      const suggestions = db
        .prepare('SELECT * FROM suggestions WHERE doc_id=? ORDER BY created_at ASC')
        .all(doc.id) as {
        id: string
        type: string
        status: string
        author: string
        created_at: number
      }[]
      res.json({ comments, suggestions })
    }),
  )

  r.post(
    '/api/docs/:id/comments',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 4000) : ''
      if (!body.trim()) throw badRequest('body required', 'Send {"body": "…"}')
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const find = typeof req.body?.find === 'string' ? req.body.find : undefined
      const line = typeof req.body?.line === 'number' ? req.body.line : undefined
      const anchor = req.body?.anchor
      let anchored = 0
      let anchorFrom: number | null = null
      let anchorTo: number | null = null
      if (find) {
        const idx = looseIndexOf(doc.content, find)
        anchored = idx >= 0 ? 1 : 0
        if (idx >= 0) {
          anchorFrom = idx
          anchorTo = idx + find.length
        }
      } else if (anchor && typeof anchor.from === 'number' && typeof anchor.to === 'number') {
        anchored = doc.content.slice(anchor.from, anchor.to).length > 0 ? 1 : 0
        anchorFrom = anchor.from
        anchorTo = anchor.to
      }
      const id = randomId(14)
      db.prepare(
        'INSERT INTO comments (id, doc_id, body, author, guest, find, line, anchor_from, anchor_to, anchored, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        id,
        doc.id,
        body,
        who.name,
        who.guest ? 1 : 0,
        find ?? null,
        line ?? null,
        anchorFrom,
        anchorTo,
        anchored,
        now(),
      )
      services.emit(doc.id, 'comment.created', who.name, who.guest, {
        comment: id,
        ...(find ? { label: find.slice(0, 80) } : {}),
      })
      res.status(201).json(anchored ? { id, anchored: true } : { id })
    }),
  )

  r.post(
    '/api/docs/:id/comments/:cid/replies',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const parent = db
        .prepare('SELECT id FROM comments WHERE id=? AND doc_id=?')
        .get(req.params.cid!, doc.id) as { id: string } | undefined
      if (!parent) throw notFound('comment not found')
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 4000) : ''
      if (!body.trim()) throw badRequest('body required')
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const id = randomId(14)
      db.prepare(
        'INSERT INTO comments (id, doc_id, body, author, guest, parent_id, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, doc.id, body, who.name, who.guest ? 1 : 0, parent.id, now())
      services.emit(doc.id, 'reply.created', who.name, who.guest, {
        comment: id,
        parent: parent.id,
      })
      res.status(201).json({ id })
    }),
  )

  r.post(
    '/api/docs/:id/comments/:cid/resolve',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const comment = db
        .prepare('SELECT id, resolved FROM comments WHERE id=? AND doc_id=?')
        .get(req.params.cid!, doc.id) as { id: string; resolved: number } | undefined
      if (!comment) throw notFound('comment not found')
      const resolved = req.body?.resolved === true
      db.prepare('UPDATE comments SET resolved=? WHERE id=?').run(resolved ? 1 : 0, comment.id)
      services.emit(doc.id, 'comment.resolved', access.identity.name, false, {
        comment: comment.id,
        resolved,
      })
      res.json({ ok: true })
    }),
  )

  // Suggestions
  r.get(
    '/api/docs/:id/suggestions',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const suggestions = db
        .prepare('SELECT * FROM suggestions WHERE doc_id=? ORDER BY created_at ASC')
        .all(doc.id)
      res.json({ suggestions })
    }),
  )

  r.post(
    '/api/docs/:id/suggestions',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'suggest')
      const type = req.body?.type
      const find = typeof req.body?.find === 'string' ? req.body.find : undefined
      const text = typeof req.body?.text === 'string' ? req.body.text : undefined
      const at = req.body?.at
      if (type === 'replace' && (!find || text === undefined)) {
        throw badRequest(
          'find and text required',
          'replace needs {"type":"replace","find":"…","text":"…"}',
        )
      }
      if (type === 'delete' && !find) throw badRequest('find required')
      if (type === 'insert' && text === undefined) throw badRequest('text required')
      if (!['replace', 'delete', 'insert'].includes(type))
        throw badRequest('invalid suggestion type')
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const pairId = type === 'replace' ? randomId(14) : null
      const ids: string[] = []
      const insertSuggestion = (
        t: string,
        f: string | undefined,
        tx: string | undefined,
        a: unknown,
      ) => {
        const id = randomId(14)
        db.prepare(
          'INSERT INTO suggestions (id, doc_id, pair_id, type, find, text, at, author, guest, seq, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          doc.id,
          pairId,
          t,
          f ?? null,
          tx ?? null,
          a === undefined ? null : JSON.stringify(a),
          who.name,
          who.guest ? 1 : 0,
          nextSuggestionSeq(db, doc.id),
          now(),
        )
        ids.push(id)
      }
      if (type === 'replace') {
        insertSuggestion('delete', find, undefined, undefined)
        insertSuggestion('insert', undefined, text, { at: 'after-find' })
      } else {
        insertSuggestion(type, find, text, at)
      }
      db.prepare('UPDATE docs SET suggestion_seq=suggestion_seq+1 WHERE id=?').run(doc.id)
      services.emit(doc.id, 'suggestion.created', who.name, who.guest, { suggestions: ids, type })
      res.status(201).json({ ids, suggestions: ids.map((id) => ({ id })) })
    }),
  )

  r.post(
    '/api/docs/:id/suggestions/:sid',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const action = req.body?.action
      if (!['accept', 'reject'].includes(action))
        throw badRequest('action required', 'Send {"action":"accept"|"reject"}')
      const s = db
        .prepare('SELECT * FROM suggestions WHERE id=? AND doc_id=?')
        .get(req.params.sid!, doc.id) as
        | {
            id: string
            pair_id: string | null
            type: string
            find: string | null
            text: string | null
            at: string | null
            status: string
          }
        | undefined
      if (!s) throw notFound('suggestion not found')
      if (s.status !== 'pending') throw conflict('suggestion already resolved')
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      let content = doc.content
      if (action === 'accept') {
        const apply = (row: typeof s) => {
          if (row.type === 'delete' && row.find) {
            const idx = content.indexOf(row.find)
            if (idx >= 0) content = content.slice(0, idx) + content.slice(idx + row.find.length)
          } else if (row.type === 'insert' && row.text !== null) {
            content = `${content}\n${row.text}`
          }
        }
        const pair = s.pair_id
          ? (db.prepare('SELECT * FROM suggestions WHERE pair_id=?').all(s.pair_id) as (typeof s)[])
          : [s]
        for (const row of pair) apply(row)
        db.prepare(
          "UPDATE suggestions SET status='accepted' WHERE id=? OR (pair_id=? AND pair_id IS NOT NULL)",
        ).run(s.id, s.pair_id)
        const newKind = doc.kind === 'plain' ? 'plain' : 'live'
        const bumped = bumpContent(
          db,
          doc.id,
          content,
          who.name,
          who.guest,
          newKind,
          'suggestion accepted',
        )
        db.prepare('UPDATE docs SET suggestion_seq=suggestion_seq+1 WHERE id=?').run(doc.id)
        services.emit(doc.id, 'suggestion.accepted', who.name, who.guest, {
          suggestion: s.id,
          version: bumped.version,
        })
      } else {
        db.prepare("UPDATE suggestions SET status='rejected' WHERE id=?").run(s.id)
        db.prepare('UPDATE docs SET suggestion_seq=suggestion_seq+1 WHERE id=?').run(doc.id)
        services.emit(doc.id, 'suggestion.rejected', who.name, who.guest, { suggestion: s.id })
      }
      res.json({ ok: true })
    }),
  )

  // Revisions
  r.get(
    '/api/docs/:id/revisions',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const limit = Math.min(Math.max(Number(req.query.limit ?? 200), 1), 500)
      const before = typeof req.query.before === 'string' ? req.query.before : undefined
      const beforeRow = before
        ? (db.prepare('SELECT seq FROM revisions WHERE id=? AND doc_id=?').get(before, doc.id) as
            { seq: number } | undefined)
        : undefined
      const rows = (
        beforeRow
          ? db
              .prepare(
                'SELECT * FROM revisions WHERE doc_id=? AND seq < ? ORDER BY seq DESC LIMIT ?',
              )
              .all(doc.id, beforeRow.seq, limit + 1)
          : db
              .prepare('SELECT * FROM revisions WHERE doc_id=? ORDER BY seq DESC LIMIT ?')
              .all(doc.id, limit + 1)
      ) as { id: string; label: string | null; author: string; guest: number; created_at: number }[]
      const hasMore = rows.length > limit
      const page = rows.slice(0, limit)
      const total = (
        db.prepare('SELECT COUNT(*) AS c FROM revisions WHERE doc_id=?').get(doc.id) as {
          c: number
        }
      ).c
      res.json({
        revisions: page.map((x) => ({
          id: x.id,
          label: x.label,
          author: x.author,
          ...(x.guest ? { guest: true } : {}),
          created_at: x.created_at,
        })),
        total,
        hasMore,
        ...(hasMore ? { nextBefore: page[page.length - 1]!.id } : {}),
      })
    }),
  )

  r.get(
    '/api/docs/:id/revisions/:rid',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const rev = db
        .prepare('SELECT * FROM revisions WHERE id=? AND doc_id=?')
        .get(req.params.rid!, doc.id) as
        | {
            id: string
            content: string
            label: string | null
            author: string
            guest: number
            created_at: number
          }
        | undefined
      if (!rev) throw notFound('revision not found')
      res.json({
        revision: {
          id: rev.id,
          content: rev.content,
          label: rev.label,
          author: rev.author,
          ...(rev.guest ? { guest: true } : {}),
          created_at: rev.created_at,
        },
      })
    }),
  )

  r.post(
    '/api/docs/:id/restore',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'edit')
      const rev = db
        .prepare('SELECT * FROM revisions WHERE id=? AND doc_id=?')
        .get(req.body?.revision, doc.id) as { content: string } | undefined
      if (!rev) throw notFound('revision not found')
      const who = attribution(db, access, req.body?.author)
      const newKind = doc.kind === 'plain' ? 'plain' : 'live'
      const bumped = bumpContent(db, doc.id, rev.content, who.name, who.guest, newKind, 'restore')
      services.emit(doc.id, 'content.replaced', who.name, who.guest, {
        version: bumped.version,
        via: 'restore',
      })
      res.json({ ok: true, version: bumped.version })
    }),
  )

  // POST /api/docs/:id/notify
  r.post(
    '/api/docs/:id/notify',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 4000) : ''
      if (!message.trim()) throw badRequest('message required')
      const level = ['ask', 'alert', 'info'].includes(req.body?.level) ? req.body.level : 'ask'
      const headline =
        typeof req.body?.headline === 'string' ? req.body.headline.slice(0, 200) : undefined
      services.notifyOwner(doc.id, level, message, headline)
      services.emit(doc.id, 'notify', access.identity.name, false, { level, headline })
      res.json({ ok: true })
    }),
  )

  return r
}

function nextSuggestionSeq(db: Db, docId: string): number {
  return (
    db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM suggestions WHERE doc_id=?').get(docId) as {
      s: number
    }
  ).s
}

function looseIndexOf(haystack: string, needle: string): number {
  const norm = (s: string) => s.replace(/\s+/g, '')
  return norm(haystack).indexOf(norm(needle))
}
