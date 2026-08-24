import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** URL-safe random id. */
export function randomId(length = 22): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

/** High-entropy capability secret (share key, token, hook secret). */
export function secret(length = 32): string {
  return randomBytes(length).toString('base64url')
}

/** Token shaped like the live product: mgn_<secret>. */
export function newToken(): string {
  return `mgn_${secret(28)}`
}

/** Hook secret shaped like the live product: whsec_<secret>. */
export function newHookSecret(): string {
  return `whsec_${secret(24)}`
}

/** Short content-derived version id. */
export function contentVersion(content: string, extra = ''): string {
  return createHash('sha256').update(content).update(extra).digest('hex').slice(0, 20)
}

/** SHA-256 hex digest. */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
