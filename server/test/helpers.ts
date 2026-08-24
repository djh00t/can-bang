import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { expect } from 'vitest'
import type express from 'express'
import { createApp } from '../src/app.js'
import { openDb, type Db } from '../src/db.js'
import { EventBus } from '../src/events.js'
import { AppServices } from '../src/service.js'
import { loadConfig } from '../src/config.js'

export interface TestCtx {
  services: AppServices
  app: express.Express
  db: Db
  dataDir: string
}

export function makeCtx(): TestCtx {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-test-'))
  const config = loadConfig({ dataDir, publicUrl: 'http://localhost:8080' })
  const db = openDb(join(dataDir, 'test.db'))
  const bus = new EventBus()
  const services = new AppServices(db, bus, config, {
    setTyping: () => undefined,
    getTyping: () => [],
    broadcast: () => undefined,
  })
  const app = createApp(services)
  return { services, app, db, dataDir }
}

export async function anonDoc(
  app: express.Express,
  content = '',
  title = 'Test',
): Promise<{ id: string; key: string }> {
  const res = await request(app).post('/new').send({ title, content })
  expect(res.status).toBe(201)
  return { id: res.body.id, key: res.body.key }
}

export async function mintRole(
  app: express.Express,
  id: string,
  editKey: string,
  role: 'view' | 'comment' | 'suggest' | 'edit',
): Promise<string> {
  const res = await request(app)
    .post(`/api/docs/${id}/shares`)
    .set('x-share-key', editKey)
    .send({ role })
  expect(res.status).toBe(200)
  return res.body.share.secret
}

export async function account(app: express.Express, username: string, password = 'hunter2-secure') {
  const agent = request.agent(app)
  const signup = await agent.post('/api/auth/signup').send({ username, password })
  expect(signup.status).toBe(201)
  const tokens = await agent.post('/api/tokens').send({})
  expect(tokens.status).toBe(201)
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
