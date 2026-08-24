#!/usr/bin/env node
// Backup: consistent SQLite snapshot (WAL-safe) + content-addressed assets.
// Usage: node scripts/backup.mjs [destination-dir]
// Env:   DATA_DIR (default ./data), BACKUP_DIR (default ./backups)

import { mkdirSync, cpSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { open } from 'node:fs/promises'
import Database from 'better-sqlite3'

const dataDir = process.env.DATA_DIR ?? './data'
const backupRoot = process.env.BACKUP_DIR ?? './backups'
const dbPath = join(dataDir, 'workbench.db')
const assetsDir = join(dataDir, 'assets')

if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`)
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const destination = process.argv[2] ?? join(backupRoot, `workbench-${stamp}`)
mkdirSync(destination, { recursive: true })

const db = new Database(dbPath, { readonly: true })
await new Promise((resolve, reject) => {
  db.backup(join(destination, 'workbench.db')).then(resolve, reject)
})
db.close()

if (existsSync(assetsDir)) {
  cpSync(assetsDir, join(destination, 'assets'), { recursive: true })
}

const manifest = {
  created_at: new Date().toISOString(),
  db: 'workbench.db',
  assets: existsSync(assetsDir) ? basename(assetsDir) : null,
  schema_note: 'restore with: node scripts/restore.mjs <backup-dir>',
}
writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2))

const size = (await open(join(destination, 'workbench.db'), 'r')).stat().then((s) => s.size)
console.log(`backup written to ${destination} (db ${await size} bytes)`)
