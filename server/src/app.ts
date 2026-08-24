import express, { type NextFunction, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError } from '@can-bang/core'
import type { AppServices } from './service.js'
import { RateLimiter } from './rate.js'
import { jsonError } from './util.js'
import { sessionCookie } from './auth.js'
import { healthRoutes } from './routes/health.js'
import { pagesRoutes } from './routes/pages.js'
import { docsRoutes } from './routes/docs.js'
import { collabRoutes } from './routes/collab.js'
import { asksRoutes } from './routes/asks.js'
import { orgRoutes } from './routes/org.js'
import { extrasRoutes } from './routes/extras.js'
import { workspaceRoutes } from './routes/workspace.js'

export function createApp(services: AppServices): express.Express {
  const app = express()
  const apiLimiter = new RateLimiter(60_000, 600)

  app.disable('x-powered-by')
  app.use((req: Request, res: Response, next: NextFunction) => {
    const bucket = req.ip ?? 'unknown'
    const allowed = apiLimiter.allow(bucket)
    if (!allowed.allowed) {
      res.set('Retry-After', String(allowed.retryAfter))
      res
        .status(429)
        .json({ error: 'rate limit exceeded', hint: `Retry in ${allowed.retryAfter}s.` })
      return
    }
    next()
  })

  app.use(express.json({ limit: '2mb' }))

  // CSRF guard: same-origin check for cookie-authenticated mutations
  app.use((req: Request, res: Response, next: NextFunction) => {
    const sid = sessionCookie(req)
    if (sid && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin
      const host = req.headers.host
      if (origin) {
        const originHost = origin.replace(/^https?:\/\//, '').split('/')[0]
        if (originHost !== host) {
          res.status(403).json({ error: 'cross-origin request rejected' })
          return
        }
      }
    }
    next()
  })

  // Static web assets
  const webDir = join(process.cwd(), 'web')
  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: false, maxAge: '1h' }))
  }

  app.use(healthRoutes())
  app.use(pagesRoutes(services))
  app.use(docsRoutes(services))
  app.use(collabRoutes(services))
  app.use(asksRoutes(services))
  app.use(orgRoutes(services))
  app.use(extrasRoutes(services))
  app.use(workspaceRoutes(services))

  // PATCH /api/docs/:id/content → 405 with role-aware use object
  app.patch('/api/docs/:id/content', (req: Request, res: Response) => {
    res.set('Allow', 'GET, PUT')
    res.status(405).json({
      error: 'method not allowed',
      hint: 'Replace content with PUT /api/docs/:id/content and an If-Match version.',
      use: {
        read: 'GET /api/docs/:id/content',
        replace: 'PUT /api/docs/:id/content',
        confirmClear: 'PUT with X-Allow-Clear: 1',
      },
    })
  })

  // Unknown /api routes → JSON 404 with hint
  app.use('/api', (req: Request, res: Response) => {
    res
      .status(404)
      .json({ error: 'route not found', hint: 'Check /agents.md for the API reference.' })
  })

  // SPA fallback for browser navigation
  app.use((req: Request, res: Response) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/f/')) {
      res.status(404).json({ error: 'route not found' })
      return
    }
    const index = join(process.cwd(), 'web', 'index.html')
    if (existsSync(index)) res.sendFile(index)
    else res.status(404).send('not found')
  })

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    jsonError(res, err)
  })

  return app
}
