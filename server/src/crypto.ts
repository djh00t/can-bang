import bcrypt from 'bcryptjs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { sha256 } from '@can-bang/core'

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/** Hash a token for storage (never store raw secrets). */
export function hashSecret(secret: string): string {
  return sha256(`wb-local:${secret}`)
}

export function hmacSha256(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** Best-effort redaction of secrets inside notification text. */
export function stripSecrets(text: string): string {
  return text
    .replace(/mgn_[A-Za-z0-9_-]{12,}/g, 'mgn_…')
    .replace(/pk_[A-Za-z0-9_-]{12,}/g, 'pk_…')
    .replace(/whsec_[A-Za-z0-9_-]{12,}/g, 'whsec_…')
    .replace(/[?&]key=[A-Za-z0-9_-]{12,}/g, '$1key=…')
    .replace(/(Authorization|Bearer)\s+[A-Za-z0-9._-]{12,}/gi, '$1 …')
}
