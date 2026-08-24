import express, { type Request, type Response } from 'express'
import { ApiError, badRequest, notFound, randomId, sha256 } from '@can-bang/core'
import type { AppServices } from '../service.js'
import type { DocRow } from '../db.js'
import { requireRole, resolveAccess } from '../auth.js'
import { asyncHandler, clientUrl } from '../util.js'
import { getDoc } from './docs.js'
import { templateContent } from './pages.js'
import { now } from '@can-bang/core'

const SKILL_CATEGORIES = ['developer', 'productivity', 'research', 'writing', 'other']

export function extrasRoutes(services: AppServices): express.Router {
  const r = express.Router()
  const { db } = services

  // ---- Templates ----
  r.get(
    '/api/templates',
    asyncHandler((_req: Request, res: Response) => {
      const builtins = Object.entries({
        'agent-team-hq': ['Agent Team HQ', 'team'],
        'project-tracker': ['Project Tracker', 'product'],
        'meeting-notes': ['Meeting Notes', 'team'],
        'build-loop': ['Build Loop', 'product'],
        'research-mission': ['Research Mission', 'product'],
        'writing-studio': ['Writing Studio', 'writing'],
        'agent-worklog': ['Agent Worklog', 'product'],
        'agent-memory': ['Agent Memory', 'product'],
        'product-spec': ['Product Spec', 'product'],
        'sprint-review': ['Sprint Review', 'product'],
      }).map(([slug, [title, category]]) => ({
        slug,
        title,
        description: title,
        category,
        builtin: true,
      }))
      const access = resolveAccess(db, _req, '')
      const accountId = access.identity.accountId ?? null
      const custom = (
        accountId
          ? db
              .prepare(
                "SELECT slug, title, description, category, scope FROM templates WHERE scope='global' OR owner_id=?",
              )
              .all(accountId)
          : db
              .prepare(
                "SELECT slug, title, description, category, scope FROM templates WHERE scope='global'",
              )
              .all()
      ) as {
        slug: string
        title: string
        description: string | null
        category: string | null
        scope: string
      }[]
      res.json({
        templates: [
          ...builtins,
          ...custom.map((t) => ({
            slug: t.slug,
            title: t.title,
            description: t.description,
            category: t.category,
            builtin: false,
            scope: t.scope,
          })),
        ],
      })
    }),
  )

  r.get(
    '/api/templates/:slug',
    asyncHandler((req: Request, res: Response) => {
      const slug = req.params.slug!
      const builtin = templateContent(slug)
      if (builtin) {
        res.json({ slug, content: builtin, builtin: true })
        return
      }
      const custom = db.prepare('SELECT content FROM templates WHERE slug=?').get(slug) as
        { content: string } | undefined
      if (!custom) throw notFound('template not found')
      res.json({ slug, content: custom.content, builtin: false })
    }),
  )

  r.post(
    '/api/templates',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const slug =
        typeof req.body?.slug === 'string'
          ? req.body.slug
              .trim()
              .replace(/[^A-Za-z0-9_-]/g, '-')
              .slice(0, 60)
          : ''
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 120) : ''
      const content = typeof req.body?.content === 'string' ? req.body.content : ''
      if (!slug || !title || !content) throw badRequest('slug, title, and content required')
      if (templateContent(slug))
        throw new ApiError(409, 'slug taken', 'That template slug is reserved.')
      const existing = db.prepare('SELECT owner_id FROM templates WHERE slug=?').get(slug) as
        { owner_id: string | null } | undefined
      if (existing && existing.owner_id !== access.identity.accountId) {
        throw new ApiError(409, 'slug taken', 'That template slug belongs to another account.')
      }
      const scope = req.body?.scope === 'global' ? 'global' : 'account'
      db.prepare(
        `INSERT INTO templates (slug, title, description, category, content, owner_id, scope, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET content=excluded.content, title=excluded.title, scope=excluded.scope`,
      ).run(
        slug,
        title,
        typeof req.body?.description === 'string' ? req.body.description : null,
        typeof req.body?.category === 'string' ? req.body.category : null,
        content,
        access.identity.accountId,
        scope,
        now(),
      )
      res.status(201).json({ slug })
    }),
  )

  r.post(
    '/api/templates/:slug/publish',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const row = db
        .prepare('SELECT owner_id, scope FROM templates WHERE slug=?')
        .get(req.params.slug!) as { owner_id: string | null; scope: string } | undefined
      if (!row) throw notFound('template not found')
      if (row.owner_id !== access.identity.accountId)
        throw new ApiError(403, 'only the template owner can publish globally')
      const scope = req.body?.scope === 'account' ? 'account' : 'global'
      db.prepare('UPDATE templates SET scope=? WHERE slug=?').run(scope, req.params.slug!)
      res.json({ ok: true, scope })
    }),
  )

  // ---- Widgets ----
  r.get(
    '/api/widgets',
    asyncHandler((_req: Request, res: Response) => {
      const rows = db
        .prepare(
          "SELECT slug, title, description, category, status, created_at FROM widgets WHERE status='approved' ORDER BY created_at DESC",
        )
        .all()
      res.json({ widgets: rows })
    }),
  )

  r.get(
    '/api/widgets/:slug',
    asyncHandler((req: Request, res: Response) => {
      const row = db.prepare('SELECT * FROM widgets WHERE slug=?').get(req.params.slug!) as
        | {
            slug: string
            title: string
            description: string | null
            category: string
            html: string
            state: string | null
            status: string
          }
        | undefined
      if (!row) throw notFound('widget not found')
      res.json(row)
    }),
  )

  r.post(
    '/api/widgets',
    asyncHandler((req: Request, res: Response) => {
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 120) : ''
      const html = typeof req.body?.html === 'string' ? req.body.html : ''
      const category = ['tool', 'viz', 'game', 'fun'].includes(req.body?.category)
        ? req.body.category
        : 'tool'
      if (!title || !html) throw badRequest('title and html required')
      const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60)
      const lintFlags = lintWidget(html)
      db.prepare(
        'INSERT INTO widgets (slug, title, description, category, html, state, status, created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET html=excluded.html, title=excluded.title',
      ).run(
        slug || randomId(8),
        title,
        typeof req.body?.description === 'string' ? req.body.description : null,
        category,
        html,
        req.body?.state ? JSON.stringify(req.body.state) : null,
        'pending',
        now(),
      )
      res.status(201).json({ id: slug, status: 'pending', lintFlags })
    }),
  )

  r.post(
    '/api/widgets/:slug/review',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId)
        throw new ApiError(401, 'account required', 'Sign in to review widgets.')
      const status = req.body?.status
      if (!['approved', 'rejected'].includes(status))
        throw badRequest('status must be approved or rejected')
      const row = db
        .prepare('UPDATE widgets SET status=? WHERE slug=?')
        .run(status, req.params.slug!)
      if (row.changes === 0) throw notFound('widget not found')
      res.json({ ok: true, status })
    }),
  )

  // ---- Skills ----
  r.get(
    '/api/skills',
    asyncHandler((_req: Request, res: Response) => {
      const rows = db
        .prepare(
          `SELECT s.slug, s.category, s.installs, s.created_at, s.updated_at, f.name AS name
           FROM skills s JOIN folders f ON f.id = s.folder_id
           WHERE s.status='approved' ORDER BY s.installs DESC`,
        )
        .all()
      res.json({ skills: rows })
    }),
  )

  r.post(
    '/api/skills',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (access.identity.kind !== 'token' && access.identity.kind !== 'session') {
        throw new ApiError(401, 'account required')
      }
      const shareUrl = typeof req.body?.shareUrl === 'string' ? req.body.shareUrl : ''
      const category = SKILL_CATEGORIES.includes(req.body?.category) ? req.body.category : 'other'
      const parsed = new URL(shareUrl)
      const key = parsed.searchParams.get('key')
      const m = parsed.pathname.match(/^\/folders\/([A-Za-z0-9_-]+)/)
      if (!m || !key)
        throw badRequest(
          'shareUrl must be a folder share URL',
          'Use POST /api/folders/:id/shares to mint one.',
        )
      const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(m[1]) as
        { id: string; owner_id: string; name: string } | undefined
      if (!folder) throw notFound('folder not found')
      const shareOk = db
        .prepare(
          'SELECT role FROM folder_shares WHERE folder_id=? AND secret=? AND revoked_at IS NULL',
        )
        .get(folder.id, key) as { role: string } | undefined
      if (!shareOk) throw new ApiError(401, 'invalid folder share key')
      const isSkill = folderIsSkill(db, folder.id)
      if (!isSkill)
        throw badRequest(
          'folder is not a skill',
          'A skill folder needs a direct SKILL.md document.',
        )
      const slug = slugify(folder.name) || randomId(10)
      db.prepare(
        `INSERT INTO skills (slug, folder_id, share_secret, category, status, submitted_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(slug) DO UPDATE SET category=excluded.category, status='pending', updated_at=excluded.updated_at, share_secret=excluded.share_secret`,
      ).run(slug, folder.id, key, category, 'pending', access.identity.name, now(), now())
      res.status(201).json({ slug, status: 'pending' })
    }),
  )

  r.get(
    '/api/skills/:slug',
    asyncHandler((req: Request, res: Response) => {
      const row = db.prepare('SELECT * FROM skills WHERE slug=?').get(req.params.slug!) as
        { slug: string; folder_id: string; status: string; share_secret: string | null } | undefined
      if (!row) throw notFound('skill not found')
      const access = resolveAccess(db, req, '')
      const key = typeof req.query.key === 'string' ? req.query.key : undefined
      const authorized =
        (access.identity.kind === 'token' || access.identity.kind === 'session') &&
        (
          db.prepare('SELECT owner_id FROM folders WHERE id=?').get(row.folder_id) as
            { owner_id: string } | undefined
        )?.owner_id === access.identity.accountId
      const hasKey = row.share_secret && key === row.share_secret
      if (row.status !== 'approved' && !authorized && !hasKey) {
        throw new ApiError(403, 'not authorized to view this skill status')
      }
      res.json({ slug: row.slug, status: row.status })
    }),
  )

  r.post(
    '/api/skills/:slug/review',
    asyncHandler((req: Request, res: Response) => {
      const status = req.body?.status
      if (!['approved', 'rejected'].includes(status))
        throw badRequest('status must be approved or rejected')
      const access = resolveAccess(db, req, '')
      const row = db.prepare('SELECT * FROM skills WHERE slug=?').get(req.params.slug!) as
        { slug: string; folder_id: string } | undefined
      if (!row) throw notFound('skill not found')
      const owner = db.prepare('SELECT owner_id FROM folders WHERE id=?').get(row.folder_id) as
        { owner_id: string } | undefined
      if (!access.identity.accountId || owner?.owner_id !== access.identity.accountId) {
        throw new ApiError(403, 'only the skill owner can review')
      }
      db.prepare('UPDATE skills SET status=?, updated_at=? WHERE slug=?').run(
        status,
        now(),
        row.slug,
      )
      res.json({ ok: true, status })
    }),
  )

  r.post(
    '/api/skills/:slug/rate',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      if (!access.identity.accountId) throw new ApiError(401, 'account required')
      const stars = Number(req.body?.stars)
      if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw badRequest('stars must be 1..5')
      db.prepare(
        'INSERT INTO skill_ratings (account_id, slug, stars, created_at) VALUES (?,?,?,?) ON CONFLICT(account_id, slug) DO UPDATE SET stars=excluded.stars',
      ).run(access.identity.accountId, req.params.slug!, stars, now())
      res.json({ ok: true })
    }),
  )

  // Skill manifest (v2)
  r.get(
    '/skills/:slug/manifest',
    asyncHandler((req: Request, res: Response) => {
      const row = db.prepare('SELECT * FROM skills WHERE slug=?').get(req.params.slug!) as
        { slug: string; folder_id: string; status: string; share_secret: string | null } | undefined
      if (!row) throw notFound('skill not found')
      const key = typeof req.query.key === 'string' ? req.query.key : req.headers['x-share-key']
      const authOk =
        row.status === 'approved' ||
        (row.share_secret && key === row.share_secret) ||
        folderOwnerIsCaller(db, row.folder_id, req, services)
      if (!authOk) throw new ApiError(403, 'not authorized to fetch this skill manifest')
      const version = Number(req.query.v) > 0 ? Number(req.query.v) : undefined
      const manifest = buildManifest(services, req, row.folder_id, version)
      if (manifest) {
        db.prepare('UPDATE skills SET installs=installs+1 WHERE slug=?').run(row.slug)
      }
      res.json(
        manifest ?? {
          error: 'version not found',
          hint: 'List releases with GET /api/folders/:id/releases',
        },
      )
    }),
  )

  r.get(
    '/folders/:id',
    asyncHandler((req: Request, res: Response) => {
      if (req.query.format !== 'install.json') throw notFound('route not found')
      const folder = db.prepare('SELECT id, name FROM folders WHERE id=?').get(req.params.id!) as
        { id: string; name: string } | undefined
      if (!folder) throw notFound('folder not found')
      const key = typeof req.query.key === 'string' ? req.query.key : undefined
      const share = db
        .prepare(
          'SELECT role FROM folder_shares WHERE folder_id=? AND secret=? AND revoked_at IS NULL',
        )
        .get(folder.id, key ?? '') as { role: string } | undefined
      if (!share) throw new ApiError(401, 'invalid folder share key')
      if (!folderIsSkill(db, folder.id)) throw badRequest('folder is not a skill')
      const version = Number(req.query.v) > 0 ? Number(req.query.v) : undefined
      res.json(buildManifest(services, req, folder.id, version))
    }),
  )

  // Folder releases
  r.post(
    '/api/folders/:id/releases',
    asyncHandler((req: Request, res: Response) => {
      const access = resolveAccess(db, req, '')
      const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(req.params.id!) as
        { id: string; owner_id: string; name: string } | undefined
      if (!folder) throw notFound('folder not found')
      if (!access.identity.accountId || folder.owner_id !== access.identity.accountId) {
        throw new ApiError(403, 'only the owner can cut releases')
      }
      if (!folderIsSkill(db, folder.id)) throw badRequest('folder is not a skill')
      const next = (
        db
          .prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM skill_releases WHERE folder_id=?')
          .get(folder.id) as { v: number }
      ).v
      const manifest = buildManifest(services, req, folder.id, undefined, true)
      const notes = typeof req.body?.notes === 'string' ? req.body.notes.slice(0, 500) : undefined
      db.prepare(
        'INSERT INTO skill_releases (folder_id, version, notes, manifest, created_at) VALUES (?,?,?,?,?)',
      ).run(folder.id, next, notes ?? null, JSON.stringify({ ...manifest, version: next }), now())
      res.status(201).json({ version: next, notes: notes ?? null })
    }),
  )

  r.get(
    '/api/folders/:id/releases',
    asyncHandler((req: Request, res: Response) => {
      const rows = db
        .prepare(
          'SELECT version, notes, created_at FROM skill_releases WHERE folder_id=? ORDER BY version',
        )
        .all(req.params.id!)
      res.json({ releases: rows })
    }),
  )

  r.get(
    '/api/folders/:id/releases/:v',
    asyncHandler((req: Request, res: Response) => {
      const row = db
        .prepare(
          'SELECT version, notes, manifest, created_at FROM skill_releases WHERE folder_id=? AND version=?',
        )
        .get(req.params.id!, Number(req.params.v)) as
        { version: number; notes: string | null; manifest: string; created_at: number } | undefined
      if (!row) throw notFound('release not found')
      res.json({
        version: row.version,
        notes: row.notes,
        created_at: row.created_at,
        manifest: JSON.parse(row.manifest),
      })
    }),
  )

  r.get(
    '/api/folders/:id/releases/:a/diff/:b',
    asyncHandler((req: Request, res: Response) => {
      const a = db
        .prepare('SELECT manifest FROM skill_releases WHERE folder_id=? AND version=?')
        .get(req.params.id!, Number(req.params.a)) as { manifest: string } | undefined
      const b = db
        .prepare('SELECT manifest FROM skill_releases WHERE folder_id=? AND version=?')
        .get(req.params.id!, Number(req.params.b)) as { manifest: string } | undefined
      if (!a || !b) throw notFound('release not found')
      const ma = JSON.parse(a.manifest) as Manifest
      const mb = JSON.parse(b.manifest) as Manifest
      const fa = new Map(ma.files.map((f) => [f.path, f.sha256]))
      const fb = new Map(mb.files.map((f) => [f.path, f.sha256]))
      const added = mb.files.filter((f) => !fa.has(f.path))
      const removed = ma.files.filter((f) => !fb.has(f.path))
      const changed = mb.files.filter((f) => fa.has(f.path) && fa.get(f.path) !== f.sha256)
      res.json({ added, removed, changed, from: Number(req.params.a), to: Number(req.params.b) })
    }),
  )

  return r
}

interface ManifestFile {
  path: string
  url: string
  sha256: string
  content?: string
}

interface Manifest {
  name: string
  description: string
  version: number | 'unreleased'
  files: ManifestFile[]
  installInstructions: string
  disclaimer: string
}

export function folderIsSkill(db: import('../db.js').Db, folderId: string): boolean {
  const docs = db.prepare('SELECT * FROM docs WHERE folder_id=?').all(folderId) as DocRow[]
  return docs.some(
    (d) => d.title.toLowerCase() === 'skill.md' || /^#\s+SKILL\s*$/im.test(d.content),
  )
}

export function buildManifest(
  services: AppServices,
  req: Request,
  folderId: string,
  version?: number,
  rebuild = false,
): Manifest | null {
  const { db } = services
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(folderId) as
    { id: string; name: string } | undefined
  if (!folder) return null
  const docs = db.prepare('SELECT * FROM docs WHERE folder_id=?').all(folder.id) as DocRow[]
  const files: ManifestFile[] = []
  for (const d of docs) {
    const path = d.title || `${d.id}.md`
    files.push({
      path,
      url: `${clientUrl(req, services.config.publicUrl)}/api/docs/${d.id}/content`,
      sha256: sha256(d.content),
      content: d.content,
    })
    const assets = db
      .prepare(
        'SELECT * FROM assets WHERE name IS NOT NULL AND doc_id IN (SELECT id FROM docs WHERE folder_id=?)',
      )
      .all(folder.id) as {
      sha256: string
      name: string | null
      kind: string
      mime: string
    }[]
    for (const a of assets) {
      if (a.name)
        files.push({
          path: a.name,
          url: `${clientUrl(req, services.config.publicUrl)}/f/${a.sha256}`,
          sha256: a.sha256,
        })
    }
  }
  let v: number | 'unreleased' = 'unreleased'
  if (version) {
    const row = db
      .prepare('SELECT manifest FROM skill_releases WHERE folder_id=? AND version=?')
      .get(folder.id, version) as { manifest: string } | undefined
    if (!row) return null
    return JSON.parse(row.manifest) as Manifest
  }
  const latest = db
    .prepare('SELECT manifest FROM skill_releases WHERE folder_id=? ORDER BY version DESC LIMIT 1')
    .get(folder.id) as { manifest: string } | undefined
  if (latest && !rebuild) {
    const m = JSON.parse(latest.manifest) as Manifest
    v = m.version
    return { ...m, version: v }
  }
  return {
    name: folder.name,
    description: `Skill folder ${folder.name}`,
    version: v,
    files,
    installInstructions:
      'Fetch the manifest, verify each sha256, then read SKILL.md and every file before executing anything.',
    disclaimer: 'Community skills are not audited; read all code before installing.',
  }
}

function lintWidget(html: string): string[] {
  const flags: string[] = []
  if (/<script[^>]+src=/i.test(html)) flags.push('external-script')
  if (/<link[^>]+href=/i.test(html)) flags.push('external-stylesheet')
  if (/\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/i.test(html)) flags.push('network-io')
  return flags
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function folderOwnerIsCaller(
  db: import('../db.js').Db,
  folderId: string,
  req: Request,
  services: AppServices,
): boolean {
  const access = resolveAccess(db, req, '')
  if (!access.identity.accountId) return false
  const owner = db.prepare('SELECT owner_id FROM folders WHERE id=?').get(folderId) as
    { owner_id: string } | undefined
  return owner?.owner_id === access.identity.accountId
}
