import { findFences, now, parseBoard, randomId } from '@can-bang/core'
import type { Db } from './db.js'
import { bumpContent } from './db.js'

interface Fence {
  kind: string
  id?: string
  body: string
  start: number
  end: number
}

const COLUMN_STATUS: Record<string, string> = {
  todo: 'todo',
  doing: 'doing',
  testing: 'testing',
  done: 'done',
}

function columnName(status: string): string {
  return status[0]!.toUpperCase() + status.slice(1)
}

function logActivity(
  db: Db,
  taskId: string,
  kind: string,
  author: string | null,
  message: string,
): void {
  db.prepare(
    'INSERT INTO task_activity (task_id, kind, author, message, meta, created_at) VALUES (?,?,?,?,?,?)',
  ).run(taskId, kind, author, message, null, now())
}

function marker(status: string): string {
  return status === 'doing' ? '[>]' : status === 'done' ? '[x]' : '[ ]'
}

function cleanTitle(text: string): string {
  return text
    .replace(/@[A-Za-z0-9_-]+/g, '')
    .replace(/#[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function readDoc(db: Db, docId: string): { content: string; updated_at: number } | undefined {
  return db.prepare('SELECT content, updated_at FROM docs WHERE id=?').get(docId) as
    { content: string; updated_at: number } | undefined
}

function boardFence(content: string): Fence | undefined {
  return findFences(content).find((f) => f.kind === 'board')
}

function cardBlock(cardLine: string, fields: Record<string, string>): string {
  const out = [cardLine]
  for (const [k, v] of Object.entries(fields)) {
    const parts = String(v).split('\n')
    out.push(`  ${k}: ${parts[0]!}`)
    for (const part of parts.slice(1)) out.push(`  ${part}`)
  }
  return out.join('\n')
}

function insertBlockAfterHeader(
  content: string,
  fence: Fence,
  header: string,
  block: string,
): string {
  const lines = content.split('\n')
  let idx = -1
  for (let i = fence.start + 1; i < fence.end; i++) {
    if (lines[i]!.trim() === header) {
      idx = i
      break
    }
  }
  if (idx === -1) {
    idx = fence.end
    lines.splice(idx, 0, header, ...block.split('\n'))
  } else {
    lines.splice(idx + 1, 0, ...block.split('\n'))
  }
  return lines.join('\n')
}

export interface CardPatch {
  title?: string
  status?: string
  assignee?: string | null
  feature?: string | null
  doneMeans?: string | null
  priority?: string | null
  acceptance?: string | null
  context?: string | null
  description?: string | null
  contract?: string | null
  workflow?: string | null
  scenarios?: string | null
  dependencies?: string | null
}

/** Append a card for a new task into the project doc's board fence (the record). */
export function appendCard(
  db: Db,
  docId: string,
  taskId: string,
  opts: {
    title: string
    status: string
    phaseName: string
    assignee?: string | null
    feature?: string | null
    doneMeans?: string | null
    release?: string | null
    priority?: string | null
    acceptance?: string | null
    context?: string | null
    description?: string | null
    contract?: string | null
    workflow?: string | null
    scenarios?: string | null
    dependencies?: string | null
  },
): void {
  const doc = readDoc(db, docId)
  if (!doc) return
  let content = doc.content
  let fence = boardFence(content)
  if (!fence) {
    content = `${content.trimEnd()}\n\n\`\`\`board #tickets\n## Todo\n## Doing\n## Testing\n## Done\n\`\`\`\n`
    fence = boardFence(content)!
  }
  const cardLine = `- ${marker(opts.status)} ${opts.title}${opts.assignee ? ` @${opts.assignee}` : ''}${opts.feature ? ` #${opts.feature.replace(/\s+/g, '-')}` : ''}`
  const fields: Record<string, string> = { task: taskId, phase: opts.phaseName }
  if (opts.release) fields.release = opts.release
  if (opts.doneMeans) fields['done-means'] = opts.doneMeans
  if (opts.priority) fields.priority = opts.priority
  if (opts.acceptance) fields.acceptance = opts.acceptance
  if (opts.context) fields.context = opts.context
  if (opts.description) fields.description = opts.description
  if (opts.contract) fields.contract = opts.contract
  if (opts.workflow) fields.workflow = opts.workflow
  if (opts.scenarios) fields.scenarios = opts.scenarios
  if (opts.dependencies) fields.dependencies = opts.dependencies
  content = insertBlockAfterHeader(
    content,
    fence,
    `## ${columnName(opts.status)}`,
    cardBlock(cardLine, fields),
  )
  bumpContent(db, docId, content, 'api', false, 'live', 'task')
}

/** Update a card in the doc board fence (the record). */
export function updateCard(db: Db, docId: string, taskId: string, patch: CardPatch): void {
  const doc = readDoc(db, docId)
  if (!doc) return
  const fence = boardFence(doc.content)
  if (!fence) return
  const lines = doc.content.split('\n')
  let taskIdx = -1
  for (let i = fence.start + 1; i < fence.end; i++) {
    if (lines[i]!.trim() === `task: ${taskId}`) {
      taskIdx = i
      break
    }
  }
  if (taskIdx === -1) return
  let cardIdx = taskIdx
  while (cardIdx > fence.start && !/^-\s+\[[ >xX]\]/.test(lines[cardIdx]!)) cardIdx--
  if (cardIdx <= fence.start || !/^-\s+\[[ >xX]\]/.test(lines[cardIdx]!)) return
  let end = taskIdx
  while (end + 1 < lines.length && /^\s+/.test(lines[end + 1]!)) end++
  const fields: Record<string, string> = {}
  let lastKey: string | null = null
  for (let i = cardIdx + 1; i <= end; i++) {
    const m = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!)
    if (m) {
      const key = m[1]!.trim()
      fields[key] = m[2]!.trim()
      lastKey = key
    } else if (lastKey && fields[lastKey]) {
      fields[lastKey] = `${fields[lastKey]}\n${lines[i]!.trim()}`
    }
  }
  let col = 'Todo'
  for (let i = cardIdx - 1; i > fence.start; i--) {
    const h = /^##\s+(.+)$/.exec(lines[i]!.trim())
    if (h) {
      col = h[1]!.trim()
      break
    }
  }
  const currentStatus = COLUMN_STATUS[col.toLowerCase()] ?? 'todo'
  const newStatus = patch.status ?? currentStatus
  const rawTitle = lines[cardIdx]!.replace(/^-\s+\[[ >xX]\]\s*/, '')
  const title = patch.title ?? cleanTitle(rawTitle)
  const assignee =
    patch.assignee !== undefined
      ? patch.assignee
      : (fields.assignee ?? /@([A-Za-z0-9_-]+)/.exec(lines[cardIdx]!)?.[1] ?? null)
  const feature =
    patch.feature !== undefined
      ? patch.feature
      : (fields.feature ?? /#([A-Za-z0-9_-]+)/.exec(lines[cardIdx]!)?.[1] ?? null)
  const doneMeans = patch.doneMeans !== undefined ? patch.doneMeans : (fields['done-means'] ?? null)
  const priority = patch.priority !== undefined ? patch.priority : (fields.priority ?? null)
  const acceptance = patch.acceptance !== undefined ? patch.acceptance : (fields.acceptance ?? null)
  const context = patch.context !== undefined ? patch.context : (fields.context ?? null)
  const description =
    patch.description !== undefined ? patch.description : (fields.description ?? null)
  const contract = patch.contract !== undefined ? patch.contract : (fields.contract ?? null)
  const workflow = patch.workflow !== undefined ? patch.workflow : (fields.workflow ?? null)
  const scenarios = patch.scenarios !== undefined ? patch.scenarios : (fields.scenarios ?? null)
  const dependencies =
    patch.dependencies !== undefined ? patch.dependencies : (fields.dependencies ?? null)
  const phaseName = fields.phase ?? ''
  const release = fields.release
  const newCardLine = `- ${marker(newStatus)} ${title}${assignee ? ` @${assignee}` : ''}${feature ? ` #${feature}` : ''}`
  const newFields: Record<string, string> = { task: taskId, phase: phaseName }
  if (release) newFields.release = release
  if (doneMeans) newFields['done-means'] = doneMeans
  if (priority) newFields.priority = priority
  if (acceptance) newFields.acceptance = acceptance
  if (context) newFields.context = context
  if (description) newFields.description = description
  if (contract) newFields.contract = contract
  if (workflow) newFields.workflow = workflow
  if (scenarios) newFields.scenarios = scenarios
  if (dependencies) newFields.dependencies = dependencies
  lines.splice(cardIdx, end - cardIdx + 1)
  let content = lines.join('\n')
  const newFence = boardFence(content)
  if (!newFence) return
  content = insertBlockAfterHeader(
    content,
    newFence,
    `## ${columnName(newStatus)}`,
    cardBlock(newCardLine, newFields),
  )
  bumpContent(db, docId, content, 'api', false, 'live', 'task')
}

/**
 * The tasks table is a reindexed view of the doc's board fence (the record).
 * Parses cards → upserts tasks, writes markers back for agent-added cards,
 * and removes tasks whose cards no longer exist.
 */
export function reindexBoard(
  db: Db,
  projectId: string,
): { indexed: number; created: number; updated: number; removed: number } {
  const project = db
    .prepare('SELECT id, owner_id, doc_id FROM projects WHERE id=?')
    .get(projectId) as { id: string; owner_id: string; doc_id: string | null } | undefined
  if (!project?.doc_id) return { indexed: 0, created: 0, updated: 0, removed: 0 }
  const doc = readDoc(db, project.doc_id)
  if (!doc) return { indexed: 0, created: 0, updated: 0, removed: 0 }
  const phases = db
    .prepare('SELECT id, name FROM phases WHERE project_id=? ORDER BY ord ASC')
    .all(projectId) as {
    id: string
    name: string
  }[]
  const phaseByName = new Map(phases.map((p) => [p.name.toLowerCase(), p.id]))
  const existing = new Map(
    (
      db
        .prepare('SELECT * FROM tasks WHERE phase_id IN (SELECT id FROM phases WHERE project_id=?)')
        .all(projectId) as {
        id: string
        phase_id: string
        status: string
        title: string
        assignee: string | null
        feature: string | null
        done_means: string | null
        priority: string | null
        acceptance: string | null
        context: string | null
        description: string | null
        contract: string | null
        workflow: string | null
        scenarios: string | null
        dependencies: string | null
      }[]
    ).map((t) => [t.id, t]),
  )
  const seen = new Set<string>()
  let created = 0
  let updated = 0
  let content = doc.content
  const fence = boardFence(content)
  if (fence) {
    const board = parseBoard(fence.body)
    let insertedTaskMarkers = 0
    for (const card of board.cards) {
      const status = COLUMN_STATUS[card.column.trim().toLowerCase()] ?? 'todo'
      const taskId = card.fields.task
      const phaseId =
        phaseByName.get((card.fields.phase ?? '').trim().toLowerCase()) ?? phases[0]?.id
      if (!phaseId) continue
      const title = cleanTitle(card.text) || 'Untitled card'
      const assignee = card.assignees[0] ?? null
      const feature = card.fields.feature ?? card.tags[0] ?? null
      const doneMeans = card.fields['done-means']?.trim() || null
      const priority = card.fields.priority?.trim() || null
      const acceptance = card.fields.acceptance?.trim() || null
      const context = card.fields.context?.trim() || null
      const description = card.fields.description?.trim() || null
      const contract = card.fields.contract?.trim() || null
      const workflow = card.fields.workflow?.trim() || null
      const scenarios = card.fields.scenarios?.trim() || null
      const dependencies = card.fields.dependencies?.trim() || null
      if (taskId && existing.has(taskId)) {
        seen.add(taskId)
        const t = existing.get(taskId)!
        let changed = false
        if (t.status !== status) {
          db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, taskId)
          db.prepare(
            'INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)',
          ).run(taskId, t.phase_id, status, now())
          logActivity(db, taskId, 'status', 'doc', `moved to ${status}`)
          changed = true
        }
        if (title && title !== t.title) {
          db.prepare('UPDATE tasks SET title=? WHERE id=?').run(title, taskId)
          changed = true
        }
        if (assignee !== (t.assignee ?? null)) {
          db.prepare('UPDATE tasks SET assignee=? WHERE id=?').run(assignee, taskId)
          if (assignee) {
            db.prepare(
              'UPDATE agents SET current_task=?, current_doc=? WHERE account_id=? AND name=?',
            ).run(title.slice(0, 500), project.doc_id, project.owner_id, assignee)
          } else if (t.assignee) {
            db.prepare(
              'UPDATE agents SET current_task=NULL, current_doc=NULL WHERE account_id=? AND name=?',
            ).run(project.owner_id, t.assignee)
          }
          changed = true
        }
        if (feature !== (t.feature ?? null)) {
          db.prepare('UPDATE tasks SET feature=? WHERE id=?').run(feature, taskId)
          changed = true
        }
        if (doneMeans !== (t.done_means ?? null)) {
          db.prepare('UPDATE tasks SET done_means=? WHERE id=?').run(doneMeans, taskId)
          changed = true
        }
        if (priority !== (t.priority ?? null)) {
          db.prepare('UPDATE tasks SET priority=? WHERE id=?').run(priority, taskId)
          changed = true
        }
        if (acceptance !== (t.acceptance ?? null)) {
          db.prepare('UPDATE tasks SET acceptance=? WHERE id=?').run(acceptance, taskId)
          changed = true
        }
        if (context !== (t.context ?? null)) {
          db.prepare('UPDATE tasks SET context=? WHERE id=?').run(context, taskId)
          changed = true
        }
        if (description !== (t.description ?? null)) {
          db.prepare('UPDATE tasks SET description=? WHERE id=?').run(description, taskId)
          changed = true
        }
        if (contract !== (t.contract ?? null)) {
          db.prepare('UPDATE tasks SET contract=? WHERE id=?').run(contract, taskId)
          changed = true
        }
        if (workflow !== (t.workflow ?? null)) {
          db.prepare('UPDATE tasks SET workflow=? WHERE id=?').run(workflow, taskId)
          changed = true
        }
        if (scenarios !== (t.scenarios ?? null)) {
          db.prepare('UPDATE tasks SET scenarios=? WHERE id=?').run(scenarios, taskId)
          changed = true
        }
        if (dependencies !== (t.dependencies ?? null)) {
          db.prepare('UPDATE tasks SET dependencies=? WHERE id=?').run(dependencies, taskId)
          changed = true
        }
        if (changed) updated++
      } else {
        const id = taskId ?? randomId(14)
        db.prepare(
          `INSERT INTO tasks (id, phase_id, title, status, assignee, feature, done_means, priority, acceptance, context, description, contract, workflow, scenarios, dependencies, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, status=excluded.status, assignee=excluded.assignee,
             feature=excluded.feature, done_means=excluded.done_means, priority=excluded.priority,
             acceptance=excluded.acceptance, context=excluded.context, description=excluded.description,
             contract=excluded.contract, workflow=excluded.workflow, scenarios=excluded.scenarios,
             dependencies=excluded.dependencies, updated_at=excluded.updated_at`,
        ).run(
          id,
          phaseId,
          title,
          status,
          assignee,
          feature,
          doneMeans,
          priority,
          acceptance,
          context,
          description,
          contract,
          workflow,
          scenarios,
          dependencies,
          now(),
          now(),
        )
        db.prepare('INSERT INTO task_events (task_id, phase_id, status, ts) VALUES (?,?,?,?)').run(
          id,
          phaseId,
          status,
          now(),
        )
        if (assignee) {
          db.prepare(
            'UPDATE agents SET current_task=?, current_doc=? WHERE account_id=? AND name=?',
          ).run(title.slice(0, 500), project.doc_id, project.owner_id, assignee)
        }
        seen.add(id)
        created++
        if (!taskId) {
          const lines = content.split('\n')
          const cardIdx = fence.start + 1 + card.line + insertedTaskMarkers
          lines.splice(cardIdx + 1, 0, `  task: ${id}`)
          insertedTaskMarkers++
          content = lines.join('\n')
        }
      }
    }
  }
  const projectTaskIds = (
    db
      .prepare('SELECT id FROM tasks WHERE phase_id IN (SELECT id FROM phases WHERE project_id=?)')
      .all(projectId) as {
      id: string
    }[]
  ).map((r) => r.id)
  let removed = 0
  for (const id of projectTaskIds) {
    if (!seen.has(id)) {
      db.prepare('DELETE FROM task_events WHERE task_id=?').run(id)
      db.prepare('DELETE FROM task_activity WHERE task_id=?').run(id)
      db.prepare('DELETE FROM tasks WHERE id=?').run(id)
      removed++
    }
  }
  if (content !== doc.content) {
    bumpContent(db, project.doc_id, content, 'board-sync', false, 'live', 'board sync')
  }
  db.prepare('UPDATE projects SET board_indexed_at=? WHERE id=?').run(now(), projectId)
  return { indexed: seen.size, created, updated, removed }
}

/** Reindex only when the doc changed since the last index. */
export function reindexIfStale(db: Db, projectId: string): void {
  const project = db
    .prepare('SELECT id, doc_id, board_indexed_at FROM projects WHERE id=?')
    .get(projectId) as
    { id: string; doc_id: string | null; board_indexed_at: number | null } | undefined
  if (!project?.doc_id) return
  const doc = db.prepare('SELECT updated_at FROM docs WHERE id=?').get(project.doc_id) as
    { updated_at: number } | undefined
  if (!doc) return
  if ((project.board_indexed_at ?? 0) < doc.updated_at) reindexBoard(db, projectId)
}
