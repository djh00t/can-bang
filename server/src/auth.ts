import type { Request } from 'express'
import { ApiError, forbidden, secret } from '@can-bang/core'
import type { Db, Role } from './db.js'
import { ROLE_ORDER } from './db.js'
import { hashSecret } from './crypto.js'
import { now } from '@can-bang/core'

export interface Identity {
  kind: 'token' | 'session' | 'guest' | 'none'
  accountId?: string
  projectId?: string
  name: string
  guest: boolean
  authorProvided?: boolean
}

export interface DocAccess {
  identity: Identity
  role: 'owner' | Role | null
  keyRole?: Role
}

type TokenAccount = {
  id: string
  username: string
  agent_name: string | null
  project_id?: string
}

export function bearerToken(req: Request): string | undefined {
  const auth = req.headers.authorization
  if (auth && /^Bearer\s+(?:mgn|pbk)_[A-Za-z0-9_-]+$/i.test(auth.trim())) {
    return auth.trim().slice(7)
  }
  return undefined
}

export function shareKey(req: Request): string | undefined {
  const q = req.query.key
  const h = req.headers['x-share-key']
  const v = typeof q === 'string' ? q : typeof h === 'string' ? h : undefined
  return v && v.length > 0 ? v : undefined
}

export function sessionCookie(req: Request): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === 'wb_session') return rest.join('=')
  }
  return undefined
}

export function accountFromToken(db: Db, token: string): TokenAccount | null {
  const row = db
    .prepare(
      `SELECT a.id, a.username, a.agent_name FROM tokens t JOIN accounts a ON a.id = t.account_id WHERE t.token_hash = ?`,
    )
    .get(hashSecret(token)) as
    { id: string; username: string; agent_name: string | null } | undefined
  return row ?? null
}

export function accountFromProjectKey(db: Db, key: string): TokenAccount | null {
  const row = db
    .prepare(
      'SELECT a.id, a.username, a.agent_name, p.id AS project_id FROM project_keys pk JOIN projects p ON p.id = pk.project_id JOIN accounts a ON a.id = p.owner_id WHERE pk.key_hash = ?',
    )
    .get(hashSecret(key)) as TokenAccount | undefined
  return row ?? null
}

export function accountFromSession(
  db: Db,
  sessionId: string,
): { id: string; username: string; agent_name: string | null } | null {
  const row = db
    .prepare(
      `SELECT a.id, a.username, a.agent_name FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, now()) as
    { id: string; username: string; agent_name: string | null } | undefined
  return row ?? null
}

export function activeShareRole(db: Db, docId: string, key: string): Role | null {
  const docShare = db
    .prepare('SELECT role FROM shares WHERE doc_id=? AND secret=? AND revoked_at IS NULL')
    .get(docId, key) as { role: Role } | undefined
  if (docShare) return docShare.role
  let folderId =
    (
      db.prepare('SELECT folder_id FROM docs WHERE id=?').get(docId) as
        { folder_id: string | null } | undefined
    )?.folder_id ?? null
  const visited = new Set<string>()
  while (folderId && !visited.has(folderId)) {
    visited.add(folderId)
    const folderShare = db
      .prepare(
        'SELECT role FROM folder_shares WHERE folder_id=? AND secret=? AND revoked_at IS NULL',
      )
      .get(folderId, key) as { role: Role } | undefined
    if (folderShare) return folderShare.role
    folderId =
      (
        db.prepare('SELECT parent_id FROM folders WHERE id=?').get(folderId) as
          { parent_id: string | null } | undefined
      )?.parent_id ?? null
  }
  return null
}

/**
 * Resolve identity + access for a doc. A share key always scopes the call;
 * a token/session grants owner-level access only to owned docs.
 */
export function resolveAccess(db: Db, req: Request, docId: string): DocAccess {
  const key = shareKey(req)
  let keyRole: Role | undefined
  if (key) {
    keyRole = activeShareRole(db, docId, key) ?? undefined
  }

  const token = bearerToken(req)
  if (token) {
    const account = accountFromToken(db, token) ?? accountFromProjectKey(db, token)
    if (!account)
      throw new ApiError(
        401,
        'invalid token',
        'Check the Authorization header or mint a new token in the account menu.',
      )
    if (key) {
      if (!keyRole)
        throw new ApiError(
          401,
          'invalid share key',
          'Pass a valid ?key= or X-Share-Key for this document.',
        )
      const owner = db.prepare('SELECT owner_id FROM docs WHERE id=?').get(docId) as
        { owner_id: string | null } | undefined
      return {
        identity: {
          kind: 'token',
          accountId: account.id,
          projectId: account.project_id,
          name: account.agent_name ?? account.username,
          guest: false,
        },
        role: owner?.owner_id === account.id ? 'owner' : keyRole,
        keyRole,
      }
    }
    const owner = db.prepare('SELECT owner_id FROM docs WHERE id=?').get(docId) as
      { owner_id: string | null } | undefined
    if (owner?.owner_id === account.id) {
      return {
        identity: {
          kind: 'token',
          accountId: account.id,
          projectId: account.project_id,
          name: account.agent_name ?? account.username,
          guest: false,
        },
        role: 'owner',
      }
    }
    return {
      identity: {
        kind: 'token',
        accountId: account.id,
        projectId: account.project_id,
        name: account.agent_name ?? account.username,
        guest: false,
      },
      role: null,
    }
  }

  const sessionId = sessionCookie(req)
  if (sessionId) {
    const account = accountFromSession(db, sessionId)
    if (account) {
      if (key) {
        if (!keyRole)
          throw new ApiError(
            401,
            'invalid share key',
            'Pass a valid ?key= or X-Share-Key for this document.',
          )
        const owner = db.prepare('SELECT owner_id FROM docs WHERE id=?').get(docId) as
          { owner_id: string | null } | undefined
        return {
          identity: {
            kind: 'session',
            accountId: account.id,
            name: account.username,
            guest: false,
          },
          role: owner?.owner_id === account.id ? 'owner' : keyRole,
          keyRole,
        }
      }
      const owner = db.prepare('SELECT owner_id FROM docs WHERE id=?').get(docId) as
        { owner_id: string | null } | undefined
      if (owner?.owner_id === account.id) {
        return {
          identity: {
            kind: 'session',
            accountId: account.id,
            name: account.username,
            guest: false,
          },
          role: 'owner',
        }
      }
      return {
        identity: { kind: 'session', accountId: account.id, name: account.username, guest: false },
        role: null,
      }
    }
  }

  if (key) {
    if (!keyRole)
      throw new ApiError(
        401,
        'invalid share key',
        'Pass a valid ?key= or X-Share-Key for this document.',
      )
    return {
      identity: { kind: 'guest', name: 'Guest', guest: true },
      role: keyRole,
      keyRole,
    }
  }

  return { identity: { kind: 'none', name: '', guest: true }, role: null }
}

export function requireRole(access: DocAccess, min: Role): void {
  const level = access.role === 'owner' ? 3 : access.role ? ROLE_ORDER[access.role] : -1
  if (level < ROLE_ORDER[min]) {
    throw forbidden(
      `this link can only ${access.role === 'view' ? 'view' : access.role === 'comment' ? 'comment' : access.role === 'suggest' ? 'suggest' : 'read'} this document`,
      `Ask for a ${min} or edit link to perform this operation.`,
    )
  }
}

/** Attribution name for a write, enforcing the impersonation guard. */
export function attribution(
  db: Db,
  access: DocAccess,
  bodyAuthor: unknown,
): { name: string; guest: boolean; authorProvided: boolean } {
  const identity = access.identity
  if (identity.kind === 'token' || identity.kind === 'session') {
    return { name: identity.name, guest: false, authorProvided: false }
  }
  const provided =
    typeof bodyAuthor === 'string' && bodyAuthor.trim().length > 0 ? bodyAuthor.trim() : ''
  if (provided) {
    const clash = db
      .prepare('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE')
      .get(provided)
    if (clash) {
      throw new ApiError(
        409,
        'that name belongs to an account',
        'Pick another name, or authenticate with that account token to write as it.',
      )
    }
    return { name: provided, guest: true, authorProvided: true }
  }
  return { name: 'Guest', guest: true, authorProvided: false }
}

export function mintShare(db: Db, docId: string, role: Role): { secret: string; role: Role } {
  const existing = db
    .prepare('SELECT secret FROM shares WHERE doc_id=? AND role=? AND revoked_at IS NULL')
    .get(docId, role) as { secret: string } | undefined
  if (existing) return { secret: existing.secret, role }
  const key = secret(24)
  db.prepare('INSERT INTO shares (secret, doc_id, role, created_at) VALUES (?,?,?,?)').run(
    key,
    docId,
    role,
    now(),
  )
  return { secret: key, role }
}

/** Passive presence touch: token writes refresh a matching registered agent. */
export function touchAgent(db: Db, access: DocAccess): void {
  if (access.identity.kind !== 'token' || !access.identity.accountId) return
  db.prepare('UPDATE agents SET last_seen_at=? WHERE account_id=? AND name=?').run(
    now(),
    access.identity.accountId,
    access.identity.name,
  )
}
