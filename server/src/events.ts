import { EventEmitter } from 'node:events'
import { now } from '@can-bang/core'

export interface DocEvent {
  seq: number
  type: string
  ts: number
  actor: string
  guest: boolean
  payload: Record<string, unknown>
}

/**
 * In-process pub/sub: fans events out to WebSocket clients and long-pollers.
 * SQLite remains the durable event source; this bus is only the wake signal.
 */
export class EventBus {
  private emitter = new EventEmitter()

  publish(docId: string, ev: DocEvent): void {
    this.emitter.emit(docId, ev)
  }

  on(docId: string, listener: (ev: DocEvent) => void): void {
    this.emitter.on(docId, listener)
  }

  off(docId: string, listener: (ev: DocEvent) => void): void {
    this.emitter.off(docId, listener)
  }

  wait(docId: string, since: number, timeoutMs: number): Promise<DocEvent | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.emitter.removeListener(docId, onEvent)
        resolve(undefined)
      }, timeoutMs)
      const onEvent = (ev: DocEvent) => {
        if (ev.seq > since) {
          clearTimeout(timer)
          this.emitter.removeListener(docId, onEvent)
          resolve(ev)
        }
      }
      this.emitter.on(docId, onEvent)
    })
  }
}
