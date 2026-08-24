export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(
    private windowMs: number,
    private max: number,
  ) {}

  allow(key: string): { allowed: boolean; retryAfter: number } {
    const now = Date.now()
    const bucket = this.buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      return { allowed: true, retryAfter: 0 }
    }
    if (bucket.count >= this.max) {
      return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) }
    }
    bucket.count++
    return { allowed: true, retryAfter: 0 }
  }

  /** Prevent unbounded memory growth. */
  sweep(): void {
    const now = Date.now()
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k)
    }
  }
}
