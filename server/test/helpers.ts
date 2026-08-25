import { mkdtempSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { expect } from 'vitest'
import { createApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { EventBus } from '../src/events.js'
import { AppServices } from '../src/service.js'
import { loadConfig } from '../src/config.js'

export interface TestCtx {
  services: AppServices
  app: Server
  db: Db
  dataDir: string
}

export async function makeCtx(): Promise<TestCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-test-'))
  const config = loadConfig({ dataDir, publicUrl: 'http://localhost:8080' })
  const db = openDb(join(dataDir, 'test.db'))
  const bus = new EventBus()
  const services = new AppServices(db, bus, config, {
    setTyping: () => undefined,
    getTyping: () => [],
    broadcast: () => undefined,
  })
  const app = createApp(services).listen(0, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      app.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      app.off('error', onError)
      resolve()
    }
    app.once('error', onError)
    app.once('listening', onListening)
  })
  return { services, app, db, dataDir }
}

export async function closeCtx(ctx: TestCtx): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ctx.app.close((error) => (error ? reject(error) : resolve()))
  })
  ctx.db.close()
}

export async function anonDoc(
  app: Server,
  content = '',
  title = 'Test',
): Promise<{ id: string; key: string }> {
  const res = await request(app).post('/new').send({ title, content })
  expect(res.status, `${res.status} ${res.text} ${JSON.stringify(res.headers)}`).toBe(201)
  expect(res.body.id, JSON.stringify(res.body)).toEqual(expect.any(String))
  expect(res.body.key, JSON.stringify(res.body)).toEqual(expect.any(String))
  return { id: res.body.id, key: res.body.key }
}

export async function mintRole(
  app: Server,
  id: string,
  editKey: string,
  role: 'view' | 'comment' | 'suggest' | 'edit',
): Promise<string> {
  const res = await request(app)
    .post(`/api/docs/${id}/shares`)
    .set('x-share-key', editKey)
    .send({ role })
  expect(res.status, `${res.status} ${res.text} ${JSON.stringify(res.headers)}`).toBe(200)
  expect(res.body.share?.secret, JSON.stringify(res.body)).toEqual(expect.any(String))
  return res.body.share.secret
}

export async function account(app: Server, username: string, password = 'hunter2-secure') {
  const agent = request.agent(app)
  const signup = await agent.post('/api/auth/signup').send({ username, password })
  expect(signup.status, `${signup.status} ${signup.text} ${JSON.stringify(signup.headers)}`).toBe(
    201,
  )
  const tokens = await agent.post('/api/tokens').send({})
  expect(tokens.status, `${tokens.status} ${tokens.text} ${JSON.stringify(tokens.headers)}`).toBe(
    201,
  )
  return { agent, token: tokens.body.token as string, username }
}

export function seedDoc(content: string): string {
  return `# Test\n\n${content}`
}

export const HQ = seedDoc(`
## Board

\`\`\`board #tickets
## Todo
- [ ] Ship the API @builder-1 #p1
  done-means: a first-time user can do the thing
## Doing
## Done
\`\`\`

## Status

\`\`\`status
state: building
\`\`\`

## Chat

\`\`\`chat #general
\`\`\`
`)
