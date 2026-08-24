import { now, iso } from '@can-bang/core'
import type { Config } from './config.js'
import type { Db } from './db.js'
import { recordEvent } from './db.js'
import type { EventBus } from './events.js'
import { hmacSha256 } from './crypto.js'
import { randomId } from '@can-bang/core'

export interface PresenceHub {
  setTyping(docId: string, name: string): void
  getTyping(docId: string): string[]
  broadcast(docId: string, payload: Record<string, unknown>): void
}

export class AppServices {
  typing = new Map<string, { name: string; expiresAt: number }>()
  private editedDebounce = new Map<string, { timer: NodeJS.Timeout; seq: number }>()
  private webhookTimer?: NodeJS.Timeout

  constructor(
    public db: Db,
    public bus: EventBus,
    public config: Config,
    public presence: PresenceHub,
  ) {}

  emit(
    docId: string,
    type: string,
    actor: string,
    guest: boolean,
    payload: Record<string, unknown> = {},
  ): { seq: number; ts: number } {
    const rec = recordEvent(this.db, docId, type, actor, guest, payload)
    const ev = { seq: rec.seq, type, ts: rec.ts, actor, guest, payload }
    this.bus.publish(docId, ev)
    this.enqueueWebhooks(docId, type, actor, payload)
    return rec
  }

  setTyping(docId: string, name: string): void {
    this.typing.set(`${docId}:${name}`, { name, expiresAt: now() + 12_000 })
  }

  getTyping(docId: string): string[] {
    const out: string[] = []
    for (const [k, v] of this.typing) {
      if (!k.startsWith(`${docId}:`)) continue
      if (v.expiresAt <= now()) this.typing.delete(k)
      else out.push(v.name)
    }
    return out
  }

  debouncedEdited(docId: string): void {
    const existing = this.editedDebounce.get(docId)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.editedDebounce.delete(docId)
      this.emit(docId, 'doc.edited', '', false, {})
    }, 3000)
    this.editedDebounce.set(docId, { timer, seq: 0 })
  }

  enqueueWebhooks(
    docId: string,
    type: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    const hooks = this.db.prepare('SELECT * FROM hooks WHERE doc_id=?').all(docId) as {
      id: string
      url: string
      secret: string
      events: string | null
      exclude_actor: string | null
    }[]
    for (const hook of hooks) {
      const events = hook.events ? (JSON.parse(hook.events) as string[]) : null
      if (events && !events.includes(type)) continue
      if (hook.exclude_actor && hook.exclude_actor === actor) continue
      const body = JSON.stringify({ type, ts: now(), docId, actor, payload })
      const signature = `sha256=${hmacSha256(hook.secret, body)}`
      this.db
        .prepare(
          'INSERT INTO outbox (hook_id, doc_id, event_type, payload, signature, next_attempt_at, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(hook.id, docId, type, body, signature, now(), now())
    }
  }

  /** Deliver due webhook outbox rows with capped exponential backoff. */
  async drainWebhooks(): Promise<void> {
    const due = this.db
      .prepare(
        'SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY id LIMIT 50',
      )
      .all(now()) as {
      id: number
      hook_id: string
      url: string
      payload: string
      signature: string
      attempts: number
    }[]
    for (const row of due) {
      const hook = this.db.prepare('SELECT url, secret FROM hooks WHERE id=?').get(row.hook_id) as
        { url: string; secret: string } | undefined
      if (!hook) {
        this.db.prepare('UPDATE outbox SET delivered_at=? WHERE id=?').run(now(), row.id)
        continue
      }
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-margin-signature': row.signature,
            'user-agent': 'can-bang/0.1',
          },
          body: row.payload,
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) {
          this.db.prepare('UPDATE outbox SET delivered_at=? WHERE id=?').run(now(), row.id)
        } else {
          this.scheduleRetry(row.id, row.attempts + 1)
        }
      } catch {
        this.scheduleRetry(row.id, row.attempts + 1)
      }
    }
  }

  private scheduleRetry(id: number, attempts: number): void {
    const delay = Math.min(60_000 * 2 ** Math.min(attempts, 6), 3_600_000)
    this.db
      .prepare('UPDATE outbox SET attempts=?, next_attempt_at=? WHERE id=?')
      .run(attempts, now() + delay, id)
  }

  startWebhookLoop(): void {
    this.webhookTimer = setInterval(() => void this.drainWebhooks(), 5_000)
    this.webhookTimer.unref()
  }

  stop(): void {
    if (this.webhookTimer) clearInterval(this.webhookTimer)
  }

  /** Owner notification log (inbox) + optional email stub. */
  notifyOwner(
    docId: string,
    level: 'ask' | 'alert' | 'info',
    message: string,
    headline?: string,
  ): void {
    this.db
      .prepare(
        'INSERT INTO notify_log (doc_id, level, message, headline, created_at) VALUES (?,?,?,?,?)',
      )
      .run(docId, level, message, headline ?? null, now())
  }
}

export function chatLine(name: string, text: string, kind?: string): string {
  const marker = kind ? ` (${kind})` : ''
  return `- ${iso()} @${name}${marker}: ${text}`
}

export function statusLine(note: string): string {
  return `- ${iso()} ${note}`
}

export function newAskId(): string {
  return randomId(12)
}
