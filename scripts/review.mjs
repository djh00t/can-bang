#!/usr/bin/env node
// Evidence packet for the end-of-phase review.
// Usage: node scripts/review.mjs   (from repo root)

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return '(unavailable)'
  }
}

const coveragePath = join(process.cwd(), 'server', 'coverage', 'coverage-summary.json')
const coverage = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, 'utf8')) : null
const linePct = coverage?.total?.lines?.pct

const reviews = existsSync(join(process.cwd(), 'docs', 'reviews'))
  ? sh('ls docs/reviews').split('\n').filter(Boolean).length
  : 0

console.log('=== Review evidence packet ===')
console.log('')
console.log('Working tree:')
console.log(sh('git status --short | wc -l | tr -d " "') + ' changed files (uncommitted)')
console.log('Last commit: ' + sh('git log -1 --oneline'))
console.log('')
console.log('Tests:')
console.log(
  '  server: ' +
    (linePct
      ? `coverage lines ${linePct}% (see server/coverage/)`
      : 'coverage not generated — run `make check` first'),
)
console.log('  core:   run `pnpm --filter @can-bang/core test`')
console.log('')
console.log(
  'Demos: ' +
    (existsSync('/tmp/workbench-demo.log')
      ? 'see /tmp/workbench-demo.log'
      : 'not run — run `make demo`'),
)
console.log('Reviews filed: ' + reviews)
console.log('')
console.log('Next: open docs/review-process.md, fill the template into')
console.log('docs/reviews/YYYY-MM-DD-<phase>.md, and update docs/lessons.md.')
