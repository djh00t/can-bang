import express, { type Request, type Response } from 'express'
import { ApiError, badRequest, conflict, notFound, randomId } from '@can-bang/core'
import type { AppServices } from '../service.js'
import type { Db } from '../db.js'
import { attribution, requireRole, resolveAccess, touchAgent } from '../auth.js'
import { asyncHandler } from '../util.js'
import { getDoc } from './docs.js'
import { now } from '@can-bang/core'

export interface AskRow {
  id: string
  doc_id: string
  text: string
  author: string | null
  state: 'open' | 'claimed' | 'resolved'
  claimed_by: string | null
  claimed_at: number | null
  claim_role: string | null
  ttl_minutes: number | null
  created_at: number
  resolved_at: number | null
  resolved_note: string | null
  escalated: number
  chief_window_ends_at: number | null
}

export function askJson(a: AskRow) {
  return {
    id: a.id,
    text: a.text,
    author: a.author,
    state: a.state,
    claimedBy: a.claimed_by,
    claimedAt: a.claimed_at,
    claimRole: a.claim_role,
    ttlMinutes: a.ttl_minutes,
    createdAt: a.created_at,
    resolvedAt: a.resolved_at,
    resolvedNote: a.resolved_note,
    chiefWindowEndsAt: a.chief_window_ends_at,
  }
}

export function asksRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  r.get(
    '/api/docs/:id/asks',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      if (!access.role) throw new ApiError(403, 'you do not have access to this document')
      const state = typeof req.query.state === 'string' ? req.query.state : 'all'
      const rows =
        state === 'all'
          ? (db
              .prepare('SELECT * FROM asks WHERE doc_id=? ORDER BY created_at DESC')
              .all(doc.id) as AskRow[])
          : (db
              .prepare('SELECT * FROM asks WHERE doc_id=? AND state=? ORDER BY created_at DESC')
              .all(doc.id, state) as AskRow[])
      res.json({ asks: rows.map(askJson) })
    }),
  )

  r.post(
    '/api/docs/:id/asks',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 4000) : ''
      if (!text.trim()) throw badRequest('text required', 'Send {"text": "…"}')
      const ttl = Number.isFinite(Number(req.body?.ttlMinutes))
        ? Math.max(Number(req.body.ttlMinutes), 1)
        : undefined
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const id = randomId(14)
      const chiefWindowEndsAt = now() + 2 * 60_000
      db.prepare(
        'INSERT INTO asks (id, doc_id, text, author, ttl_minutes, created_at, chief_window_ends_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, doc.id, text, who.name, ttl ?? null, now(), chiefWindowEndsAt)
      const row = db.prepare('SELECT * FROM asks WHERE id=?').get(id) as AskRow
      services.emit(doc.id, 'ask.created', who.name, who.guest, { ask: id })
      res.status(201).json({ ask: askJson(row) })
    }),
  )

  r.post(
    '/api/docs/:id/asks/:aid/claim',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      touchAgent(db, access)
      const agent = typeof req.body?.agent === 'string' ? req.body.agent.slice(0, 40) : ''
      if (!agent) throw badRequest('agent required', 'Send {"agent": "your-name"}')
      const ask = db
        .prepare('SELECT * FROM asks WHERE id=? AND doc_id=?')
        .get(req.params.aid!, doc.id) as AskRow | undefined
      if (!ask) throw notFound('ask not found')
      if (ask.state === 'resolved') throw conflict('ask already resolved')

      const chiefWindowActive =
        ask.chief_window_ends_at !== null && now() < ask.chief_window_ends_at
      if (chiefWindowActive && access.identity.kind === 'token') {
        const chief = db
          .prepare("SELECT name FROM agents WHERE account_id=? AND role='chief'")
          .get(access.identity.accountId) as { name: string } | undefined
        if (chief && chief.name !== agent) {
          throw conflict(
            'chief has first claim on this ask',
            'Stand down until the chief window passes.',
            {
              reason: 'chief-window',
              windowEndsAt: ask.chief_window_ends_at,
            },
          )
        }
      }

      const result = db
        .prepare(
          "UPDATE asks SET state='claimed', claimed_by=?, claimed_at=? WHERE id=? AND state='open'",
        )
        .run(agent, now(), ask.id)
      if (result.changes === 0) {
        const fresh = db.prepare('SELECT * FROM asks WHERE id=?').get(ask.id) as AskRow
        if (fresh.state === 'claimed') {
          throw conflict(
            'ask already claimed',
            'Stand down silently — another agent won the claim.',
            {
              claimedBy: fresh.claimed_by,
              claimedAt: fresh.claimed_at,
            },
          )
        }
        throw conflict('ask is no longer open')
      }
      const claimRole = typeof req.body?.role === 'string' ? req.body.role.slice(0, 60) : undefined
      if (claimRole) db.prepare('UPDATE asks SET claim_role=? WHERE id=?').run(claimRole, ask.id)
      if (access.identity.accountId) {
        db.prepare(
          'UPDATE agents SET current_task=?, current_doc=? WHERE account_id=? AND name=?',
        ).run(ask.text.slice(0, 500), doc.id, access.identity.accountId, agent)
      }
      services.emit(doc.id, 'ask.claimed', agent, access.identity.guest, { ask: ask.id, agent })
      const updated = db.prepare('SELECT * FROM asks WHERE id=?').get(ask.id) as AskRow
      res.json({ claimed: true, ask: askJson(updated) })
    }),
  )

  r.post(
    '/api/docs/:id/asks/:aid/resolve',
    asyncHandler((req: Request, res: Response) => {
      const doc = getDoc(db, req.params.id!)
      const access = resolveAccess(db, req, doc.id)
      requireRole(access, 'comment')
      const ask = db
        .prepare('SELECT * FROM asks WHERE id=? AND doc_id=?')
        .get(req.params.aid!, doc.id) as AskRow | undefined
      if (!ask) throw notFound('ask not found')
      const who = attribution(db, access, req.body?.author)
      touchAgent(db, access)
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 2000) : undefined
      db.prepare("UPDATE asks SET state='resolved', resolved_at=?, resolved_note=? WHERE id=?").run(
        now(),
        note ?? null,
        ask.id,
      )
      services.emit(doc.id, 'ask.resolved', who.name, who.guest, {
        ask: ask.id,
        ...(note ? { note } : {}),
      })
      const updated = db.prepare('SELECT * FROM asks WHERE id=?').get(ask.id) as AskRow
      res.json({ resolved: true, ask: askJson(updated) })
    }),
  )

  return r
}

/** Escalate unclaimed/stale asks exactly once; chief windows expire once. */
export function escalateAsks(services: AppServices): void {
  const { db } = services
  const nowMs = now()
  const expiredChief = db
    .prepare(
      "SELECT * FROM asks WHERE state='open' AND chief_window_ends_at IS NOT NULL AND chief_window_ends_at <= ?",
    )
    .all(nowMs) as AskRow[]
  for (const ask of expiredChief) {
    const uniq = `chief:${ask.id}`
    const done = db
      .prepare('SELECT 1 FROM events WHERE doc_id=? AND type=? AND payload LIKE ?')
      .get(ask.doc_id, 'ask.chief_window_expired', `%${ask.id}%`)
    if (!done) {
      services.emit(ask.doc_id, 'ask.chief_window_expired', '', false, { ask: ask.id })
      db.prepare('UPDATE asks SET chief_window_ends_at=NULL WHERE id=?').run(ask.id)
    }
    void uniq
  }
  const unclaimed = db
    .prepare(
      "SELECT * FROM asks WHERE state='open' AND escalated=0 AND created_at <= ? AND (ttl_minutes IS NOT NULL AND created_at + ttl_minutes*60000 <= ?)",
    )
    .all(nowMs, nowMs) as AskRow[]
  for (const ask of unclaimed) {
    db.prepare('UPDATE asks SET escalated=1 WHERE id=?').run(ask.id)
    services.emit(ask.doc_id, 'ask.unclaimed', '', false, { ask: ask.id })
    services.notifyOwner(ask.doc_id, 'ask', `Ask ${ask.id} is unclaimed: ${ask.text.slice(0, 200)}`)
  }
}
