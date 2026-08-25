import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeCtx, makeCtx, type TestCtx } from './helpers.js'

describe('test harness', () => {
  let ctx: TestCtx

  beforeEach(async () => {
    ctx = await makeCtx()
  })

  afterEach(async () => {
    await closeCtx(ctx)
  })

  it('binds Supertest app servers to loopback', () => {
    expect((ctx.app.address() as AddressInfo).address).toBe('127.0.0.1')
  })
})
