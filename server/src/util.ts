import type { NextFunction, Request, Response } from 'express'
import { ApiError } from '@can-bang/core'

export function jsonError(res: Response, err: unknown): void {
  if (err instanceof ApiError) {
    const body: Record<string, unknown> = { error: err.message }
    if (err.hint) body.hint = err.hint
    if (err.extra) Object.assign(body, err.extra)
    res.status(err.status).json(body)
    return
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid JSON body', hint: 'Send a valid JSON request body.' })
    return
  }
  console.error('unhandled error', err)
  res.status(500).json({ error: 'internal error' })
}

export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof ApiError) {
        jsonError(res, err)
      } else {
        next(err)
      }
    })
  }
}

export function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function pick<T extends Record<string, unknown>>(
  body: unknown,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (body && typeof body === 'object') {
    for (const k of keys) {
      const v = (body as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

export function clientUrl(req: Request, cfgPublic: string): string {
  const host = req.headers.host
  if (host) {
    const proto = req.headers['x-forwarded-proto']?.toString().split(',')[0]?.trim() ?? 'http'
    return `${proto}://${host}`
  }
  return cfgPublic
}

export function mentionsActor(payload: Record<string, unknown>, actor: string): boolean {
  const text = String(payload.text ?? payload.body ?? '')
  return new RegExp(`@${escapeRegExp(actor)}(?:\\b|_)`).test(text)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
