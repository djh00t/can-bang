import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { now, randomId } from '@can-bang/core'

export type Role = 'view' | 'comment' | 'suggest' | 'edit'
export const ROLE_ORDER: Record<Role, number> = { view: 0, comment: 1, suggest: 2, edit: 3 }

export interface Account {
  id: string
  username: string
  password_hash: string
  agent_name: string | null
  created_at: number
}

export interface DocRow {
  id: string
  title: string
  kind: 'live' | 'plain'
  owner_id: string | null
  folder_id: string | null
  content: string
  content_seq: number
  suggestion_seq: number
  created_at: number
  updated_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  agent_name TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  label TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'live' CHECK (kind IN ('live','plain')),
  owner_id TEXT REFERENCES accounts(id),
  folder_id TEXT REFERENCES folders(id),
  content TEXT NOT NULL DEFAULT '',
  content_seq INTEGER NOT NULL DEFAULT 0,
  suggestion_seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  secret TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  role TEXT NOT NULL CHECK (role IN ('view','comment','suggest','edit')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS folder_shares (
  secret TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  role TEXT NOT NULL CHECK (role IN ('view','comment','suggest','edit')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  content TEXT NOT NULL,
  label TEXT,
  author TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  guest INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  find TEXT,
  line INTEGER,
  anchor_from INTEGER,
  anchor_to INTEGER,
  anchored INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT REFERENCES comments(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  pair_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('replace','delete','insert')),
  find TEXT,
  text TEXT,
  at TEXT,
  author TEXT NOT NULL,
  guest INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  text TEXT NOT NULL,
  author TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','claimed','resolved')),
  claimed_by TEXT,
  claimed_at INTEGER,
  claim_role TEXT,
  ttl_minutes INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_note TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  chief_window_ends_at INTEGER
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  harness TEXT,
  machine TEXT,
  role TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','chief')),
  current_doc TEXT,
  current_task TEXT,
  registered_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS hooks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES docs(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT,
  exclude_actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id TEXT NOT NULL REFERENCES hooks(id),
  doc_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  signature TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  delivered_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  sha256 TEXT PRIMARY KEY,
  doc_id TEXT REFERENCES docs(id),
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS widgets (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  html TEXT NOT NULL,
  state TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skills (
  slug TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  share_secret TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_by TEXT,
  installs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_ratings (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  slug TEXT NOT NULL REFERENCES skills(slug),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, slug)
);
CREATE TABLE IF NOT EXISTS templates (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  content TEXT NOT NULL,
  owner_id TEXT REFERENCES accounts(id),
  scope TEXT NOT NULL DEFAULT 'account' CHECK (scope IN ('account','global')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  description TEXT,
  doc_id TEXT REFERENCES docs(id),
  github_repo TEXT,
  github_token TEXT,
  github_sync INTEGER NOT NULL DEFAULT 0,
  board_indexed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  ord INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','done')),
  doc_id TEXT REFERENCES docs(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES phases(id),
  name TEXT NOT NULL,
  demo_status TEXT NOT NULL DEFAULT 'pending' CHECK (demo_status IN ('pending','pass','partial','fail')),
  demo_command TEXT,
  notes TEXT,
  doc_id TEXT REFERENCES docs(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES phases(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','testing','done')),
  assignee TEXT,
  feature TEXT,
  done_means TEXT,
  description TEXT,
  blockers TEXT,
  doc_id TEXT REFERENCES docs(id),
  github_issue_id INTEGER,
  github_issue_url TEXT,
  board_sync_ts INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  phase_id TEXT NOT NULL REFERENCES phases(id),
  status TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pr_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, pr_number)
);
CREATE TABLE IF NOT EXISTS project_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id TEXT NOT NULL REFERENCES folders(id),
  version INTEGER NOT NULL,
  notes TEXT,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (folder_id, version)
);
CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  headline TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  category TEXT,
  operation TEXT,
  attempted TEXT,
  expected TEXT,
  workaround TEXT,
  client TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_doc ON events(doc_id, seq);
CREATE INDEX IF NOT EXISTS idx_revisions_doc ON revisions(doc_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_id);
CREATE INDEX IF NOT EXISTS idx_suggestions_doc ON suggestions(doc_id);
CREATE INDEX IF NOT EXISTS idx_asks_doc ON asks(doc_id);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON shares(doc_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id);
CREATE INDEX IF NOT EXISTS idx_docs_owner ON docs(owner_id);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project_id);
CREATE INDEX IF NOT EXISTS idx_releases_phase ON releases(phase_id);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase_id);
CREATE INDEX IF NOT EXISTS idx_task_events_phase ON task_events(phase_id, ts);
CREATE INDEX IF NOT EXISTS idx_pr_watch_project ON pr_watch(project_id);
`

export type Db = Database.Database

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.exec(SCHEMA)
  ensureColumn(db, 'assets', 'doc_id', 'doc_id TEXT REFERENCES docs(id)')
  ensureColumn(db, 'templates', 'scope', "scope TEXT NOT NULL DEFAULT 'account'")
  ensureColumn(db, 'projects', 'doc_id', 'doc_id TEXT REFERENCES docs(id)')
  ensureColumn(db, 'projects', 'github_repo', 'github_repo TEXT')
  ensureColumn(db, 'projects', 'github_token', 'github_token TEXT')
  ensureColumn(db, 'projects', 'github_sync', 'github_sync INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'projects', 'board_indexed_at', 'board_indexed_at INTEGER')
  ensureColumn(db, 'phases', 'doc_id', 'doc_id TEXT REFERENCES docs(id)')
  ensureColumn(db, 'tasks', 'description', 'description TEXT')
  ensureColumn(db, 'tasks', 'blockers', 'blockers TEXT')
  ensureColumn(db, 'tasks', 'doc_id', 'doc_id TEXT REFERENCES docs(id)')
  ensureColumn(db, 'tasks', 'github_issue_id', 'github_issue_id INTEGER')
  ensureColumn(db, 'tasks', 'github_issue_url', 'github_issue_url TEXT')
  ensureColumn(db, 'tasks', 'board_sync_ts', 'board_sync_ts INTEGER')
  ensureColumn(db, 'releases', 'doc_id', 'doc_id TEXT REFERENCES docs(id)')
  return db
}

function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
  }
}

export function docVersion(
  row: Pick<DocRow, 'content' | 'content_seq' | 'suggestion_seq'>,
): string {
  return createHash('sha256')
    .update(row.content)
    .update(String(row.content_seq))
    .update(String(row.suggestion_seq))
    .digest('hex')
    .slice(0, 20)
}

export function insertRevision(
  db: Db,
  docId: string,
  content: string,
  author: string,
  guest: boolean,
  label?: string,
): string {
  const id = randomId(20)
  const seq = (
    db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM revisions WHERE doc_id=?').get(docId) as {
      s: number
    }
  ).s
  db.prepare(
    'INSERT INTO revisions (id, doc_id, content, label, author, guest, seq, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, docId, content, label ?? null, author, guest ? 1 : 0, seq, now())
  return id
}

export function bumpContent(
  db: Db,
  docId: string,
  content: string,
  author: string,
  guest: boolean,
  kind: 'live' | 'plain',
  label?: string,
): { version: string; revisionId: string } {
  const row = db.prepare('SELECT content_seq, suggestion_seq FROM docs WHERE id=?').get(docId) as
    { content_seq: number; suggestion_seq: number } | undefined
  const contentSeq = (row?.content_seq ?? 0) + 1
  db.prepare('UPDATE docs SET content=?, content_seq=?, kind=?, updated_at=? WHERE id=?').run(
    content,
    contentSeq,
    kind,
    now(),
    docId,
  )
  const revisionId = insertRevision(db, docId, content, author, guest, label)
  const updated = db.prepare('SELECT * FROM docs WHERE id=?').get(docId) as DocRow
  return { version: docVersion(updated), revisionId }
}

export function nextEventSeq(db: Db, docId: string): number {
  return (
    db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS s FROM events WHERE doc_id=?').get(docId) as {
      s: number
    }
  ).s
}

export function recordEvent(
  db: Db,
  docId: string,
  type: string,
  actor: string,
  guest: boolean,
  payload: Record<string, unknown>,
): { seq: number; ts: number } {
  const seq = nextEventSeq(db, docId)
  const ts = now()
  db.prepare(
    'INSERT INTO events (doc_id, seq, type, ts, actor, guest, payload) VALUES (?,?,?,?,?,?,?)',
  ).run(docId, seq, type, ts, actor, guest ? 1 : 0, JSON.stringify(payload))
  return { seq, ts }
}
