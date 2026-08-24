#!/usr/bin/env node
// Restore a backup produced by backup.mjs.
// Usage: node scripts/restore.mjs <backup-dir> [--force]
// Env:   DATA_DIR (default ./data)

import { existsSync, copyFileSync, cpSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.env.DATA_DIR ?? './data'
const source = process.argv[2]
const force = process.argv.includes('--force')

if (!source || !existsSync(source)) {
  console.error('usage: node scripts/restore.mjs <backup-dir> [--force]')
  process.exit(1)
}

const dbFile = join(dataDir, 'workbench.db')
if (existsSync(dbFile) && !force) {
  console.error(`refusing to overwrite ${dbFile} without --force`)
  process.exit(1)
}

mkdirSync(dataDir, { recursive: true })
if (existsSync(dbFile)) {
  renameSync(dbFile, `${dbFile}.pre-restore-${Date.now()}`)
}
copyFileSync(join(source, 'workbench.db'), dbFile)

const assetsSource = join(source, 'assets')
if (existsSync(assetsSource)) {
  cpSync(assetsSource, join(dataDir, 'assets'), { recursive: true })
}

console.log(`restored ${source} into ${dataDir} (previous db kept as *.pre-restore-*)`)
