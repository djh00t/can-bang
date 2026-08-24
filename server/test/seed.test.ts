import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeCtx, account, type TestCtx } from './helpers.js'
import { seedSkillsIfFirst, upgradeSeededSkillsV2 } from '../src/seed.js'

describe('seeded skills', () => {
  let ctx: TestCtx
  beforeEach(() => {
    ctx = makeCtx()
  })
  afterEach(() => {
    ctx.db.close()
  })

  it('upgrades seeded skills to v2 with template files and a stamped manifest', async () => {
    await account(ctx.app, 'seed-owner')
    const accountRow = ctx.db
      .prepare("SELECT id, username FROM accounts WHERE username='seed-owner'")
      .get() as { id: string; username: string }
    seedSkillsIfFirst(ctx.services, accountRow.id, accountRow.username)

    const prFolder = ctx.db
      .prepare("SELECT folder_id FROM skills WHERE slug='pr-helper'")
      .get() as { folder_id: string }
    const commitFolder = ctx.db
      .prepare("SELECT folder_id FROM skills WHERE slug='commit-helper'")
      .get() as { folder_id: string }
    const prTitles = (
      ctx.db.prepare('SELECT title FROM docs WHERE folder_id=?').all(prFolder.folder_id) as {
        title: string
      }[]
    ).map((d) => d.title)
    // New installs seed the templates from day one.
    expect(prTitles).toContain('SKILL.md')
    expect(prTitles).toContain('PULL_REQUEST_TEMPLATE.md')

    // Simulate a legacy install that predates the templates.
    ctx.db
      .prepare(
        "UPDATE docs SET title='PULL_REQUEST_TEMPLATE.legacy' WHERE folder_id=? AND title='PULL_REQUEST_TEMPLATE.md'",
      )
      .run(prFolder.folder_id)
    ctx.db
      .prepare(
        "UPDATE docs SET title='COMMIT_TEMPLATE.legacy' WHERE folder_id=? AND title='COMMIT_TEMPLATE.md'",
      )
      .run(commitFolder.folder_id)

    upgradeSeededSkillsV2(ctx.services, accountRow.id, accountRow.username)

    const prTitles2 = (
      ctx.db.prepare('SELECT title FROM docs WHERE folder_id=?').all(prFolder.folder_id) as {
        title: string
      }[]
    ).map((d) => d.title)
    expect(prTitles2).toContain('SKILL.md')
    expect(prTitles2).toContain('PULL_REQUEST_TEMPLATE.md')
    const commitTitles = (
      ctx.db.prepare('SELECT title FROM docs WHERE folder_id=?').all(commitFolder.folder_id) as {
        title: string
      }[]
    ).map((d) => d.title)
    expect(commitTitles).toContain('COMMIT_TEMPLATE.md')

    const release = ctx.db
      .prepare(
        'SELECT version, manifest FROM skill_releases WHERE folder_id=? ORDER BY version DESC LIMIT 1',
      )
      .get(prFolder.folder_id) as { version: number; manifest: string }
    expect(release.version).toBe(2)
    const manifest = JSON.parse(release.manifest) as {
      version: number | string
      files: { path: string }[]
    }
    expect(manifest.version).toBe(2)
    expect(manifest.files.map((f) => f.path)).toContain('PULL_REQUEST_TEMPLATE.md')

    // Idempotent: a second run cuts nothing new because docs match the release.
    upgradeSeededSkillsV2(ctx.services, accountRow.id, accountRow.username)
    const count = ctx.db
      .prepare('SELECT COUNT(*) AS c FROM skill_releases WHERE folder_id=?')
      .get(prFolder.folder_id) as { c: number }
    expect(count.c).toBe(2)
  })

  it('preserves user-customized seeded skill docs during the upgrade', async () => {
    await account(ctx.app, 'seed-custom-owner')
    const accountRow = ctx.db
      .prepare("SELECT id, username FROM accounts WHERE username='seed-custom-owner'")
      .get() as { id: string; username: string }
    seedSkillsIfFirst(ctx.services, accountRow.id, accountRow.username)

    const prFolder = ctx.db
      .prepare("SELECT folder_id FROM skills WHERE slug='pr-helper'")
      .get() as { folder_id: string }
    const doc = ctx.db
      .prepare("SELECT id, content FROM docs WHERE folder_id=? AND title='SKILL.md'")
      .get(prFolder.folder_id) as { id: string; content: string }
    const customized = `# PR Helper (customized locally)\n\nKeep our own rules.\n`
    ctx.db
      .prepare('UPDATE docs SET content=?, updated_at=? WHERE id=?')
      .run(customized, Date.now(), doc.id)

    upgradeSeededSkillsV2(ctx.services, accountRow.id, accountRow.username)

    const after = ctx.db.prepare('SELECT content FROM docs WHERE id=?').get(doc.id) as {
      content: string
    }
    expect(after.content).toBe(customized)
    // The missing template is still added and a v2 release is cut from the
    // folder's actual (customized) contents.
    const titles = (
      ctx.db.prepare('SELECT title FROM docs WHERE folder_id=?').all(prFolder.folder_id) as {
        title: string
      }[]
    ).map((d) => d.title)
    expect(titles).toContain('PULL_REQUEST_TEMPLATE.md')
    const release = ctx.db
      .prepare('SELECT version FROM skill_releases WHERE folder_id=? ORDER BY version DESC LIMIT 1')
      .get(prFolder.folder_id) as { version: number }
    expect(release.version).toBe(2)
  })
})
