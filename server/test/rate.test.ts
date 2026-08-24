import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/rate.js'

describe('rate limiter', () => {
  it('allows up to the limit then blocks with retryAfter', () => {
    const limiter = new RateLimiter(60_000, 3)
    expect(limiter.allow('ip').allowed).toBe(true)
    expect(limiter.allow('ip').allowed).toBe(true)
    expect(limiter.allow('ip').allowed).toBe(true)
    const blocked = limiter.allow('ip')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(limiter.allow('other').allowed).toBe(true)
  })

  it('sweeps expired buckets', () => {
    const limiter = new RateLimiter(1, 100)
    limiter.allow('a')
    limiter.sweep()
    expect(limiter.allow('a').allowed).toBe(true)
  })
})
