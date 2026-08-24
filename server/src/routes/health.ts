import express from 'express'

export function healthRoutes(): express.Router {
  const r = express.Router()
  r.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'can-bang', version: '0.1.0' })
  })
  return r
}
