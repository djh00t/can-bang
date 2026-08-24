import { findFences, now, parseBoard, randomId, replaceFenceBody } from '@can-bang/core'
import type { Db } from './db.js'
import { bumpContent } from './db.js'

const COLUMN_STATUS: Record<string, string> = {
  todo: 'todo',
  doing: 'doing',
  testing: 'testing',
  done: 'done',
}

function marker(state: string): string {
  return state === 'doing' ? '[>]' : state === 'done' ? '[x]' : '[ ]'
}

function cleanTitle(text: string): string {
  return text
    .replace(/@[A-Za-z0-9_-]+/g, '')
    .replace(/#[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

interface SyncTask {
  id: string
  phase_id: string
  title: string
  status: string
  assignee: string | null
  feature: string | null
  done_means: string | null
}

export function buildBoardBody(tasks: SyncTask[], phases: { id: string; name: string }[]): string {
  const phaseName = new Map(phases.map((p) => [p.id, p.name]))
  const cols: { status: string; cards: string[] }[] = ['todo', 'doing', 'testing', 'done'].map(
    (status) => ({
      status,
      cards: [],
    }),
  )
  for (const t of tasks) {
    const col = cols.find((c) => c.status === t.status) ?? cols[0]!
    const line = `- ${marker(t.status)} ${t.title}${t.assignee ? ` @${t.assignee}` : ''}${t.feature ? ` #${t.feature.replace(/\s+/g, '-')}` : ''}`
    const fields = [`task: ${t.id}`, `phase: ${phaseName.get(t.phase_id) ?? ''}`]
    if (t.done_means) fields.push(`done-means: ${t.done_means}`)
    col.cards.push(`${line}\n${fields.map((f) => `  ${f}`).join('\n')}`)
  }
  return cols
    .map((c) => `## ${c.status[0]!.toUpperCase()}${c.status.slice(1)}\n${c.cards.join('\n')}`)
    .join('\n')
}

function fetchTasks(db: Db, projectId: string): SyncTask[] {
  return db
    .prepare(
      `SELECT t.* FROM tasks t JOIN phases p ON p.id = t.phase_id WHERE p.project_id=? ORDER BY p.ord ASC, t.created_at ASC`,
    )
    .all(projectId) as SyncTask[]
}

/**
 * Two-way sync between the project doc's board fence and the tasks table:
 * - pull: agent edits to the doc (column/status, title, assignee, new cards) update tasks
 * - push: the fence is regenerated from tasks so the doc matches the kanban
 */
export function syncProjectBoard(db: Db, projectId: string): { pulled: number; pushed: number } {
  const project = db.prepare('SELECT id, doc_id FROM projects WHERE id=?').get(projectId) as
    { id: string; doc_id: string | null } | undefined
  if (!project?.doc_id) return { pulled: 0, pushed: 0 }
  const phases = db
    .prepare('SELECT id, name FROM phases WHERE project_id=? ORDER BY ord ASC')
    .all(projectId) as {
    id: string
    name: string
  }[]
  const doc = db.prepare('SELECT content, updated_at FROM docs WHERE id=?').get(project.doc_id) as
    { content: string; updated_at: number } | undefined
  if (!doc) return { pulled: 0, pushed: 0 }
  const lastPush =
    (
      db
        .prepare(
          `SELECT MAX(t.board_sync_ts) AS t FROM tasks t JOIN phases p ON p.id = t.phase_id WHERE p.project_id=?`,
        )
        .get(projectId) as { t: number | null }
    ).t ?? 0
  const docEditedAfterPush = doc.updated_at > lastPush

  let content = doc.content
  let pulled = 0
  const fence = findFences(content).find((f) => f.kind === 'board')
  if (fence && docEditedAfterPush) {
    const board = parseBoard(fence.body)
    const tasks = fetchTasks(db, projectId)
    const byId = new Map(tasks.map((t) => [t.id, t]))
    for (const card of board.cards) {
      const status = COLUMN_STATUS[card.column.trim().toLowerCase()] ?? 'todo'
      const taskId = card.fields.task
      const existing = taskId ? byId.get(taskId) : undefined
      if (existing) {
        const title = cleanTitle(card.text)
        const assignee = card.assignees[0] ?? null
        let changed = false
        if (existing.status !== status) {
          db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, existing.id)
          db.prepare(
            'INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)',
          ).run(existing.id, existing.phase_id, status, now())
          changed = true
        }
        if (title && title !== existing.title) {
          db.prepare('UPDATE tasks SET title=? WHERE id=?').run(title, existing.id)
          changed = true
        }
        if (assignee && assignee !== existing.assignee) {
          db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(assignee, existing.id)
          changed = true
        }
        if (changed) pulled++
      } else if (!taskId) {
        // New card authored by an agent: create the task.
        const phaseName = card.fields.phase?.trim()
        const phase =
          phases.find((p) => p.name.toLowerCase() === (phaseName ?? '').toLowerCase()) ?? phases[0]
        if (phase) {
          const id = randomId(14)
          const title = cleanTitle(card.text) || 'Untitled card'
          const doneMeans = card.fields['done-means']?.trim() || null
          db.prepare(
            `INSERT INTO tasks (id, phase_id, title, status, assignee, feature, done_means, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            phase.id,
            title,
            status,
            card.assignees[0] ?? null,
            card.tags[0] ?? null,
            doneMeans,
            now(),
            now(),
          )
          db.prepare(
            'INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)',
          ).run(id, phase.id, status, now())
          pulled++
        }
      }
    }
  }

  // Push: regenerate the fence from the (possibly reconciled) tasks.
  const fresh = fetchTasks(db, projectId)
  const body = buildBoardBody(fresh, phases)
  if (fence) {
    content = replaceFenceBody(content, fence, body)
  } else {
    content = `${content.trimEnd()}\n\n\`\`\`board #tickets\n${body}\n\`\`\`\n`
  }
  if (content !== doc.content) {
    bumpContent(db, project.doc_id, content, 'board-sync', false, 'live', 'board sync')
    const pushTs = Date.now()
    db.prepare(
      `UPDATE tasks SET board_sync_ts=? WHERE phase_id IN (SELECT id FROM phases WHERE project_id=?)`,
    ).run(pushTs, projectId)
  }
  return { pulled, pushed: fresh.length }
}
