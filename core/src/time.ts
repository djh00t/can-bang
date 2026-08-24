/** Current epoch ms. */
export function now(): number {
  return Date.now()
}

/** Full ISO timestamp used in chat/status log lines. */
export function iso(ts = now()): string {
  return new Date(ts).toISOString()
}
