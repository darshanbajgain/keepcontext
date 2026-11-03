// SQLite storage using Node's built-in node:sqlite (no native build step).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'hub.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  name           TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  private        INTEGER NOT NULL DEFAULT 0,
  html_url       TEXT,
  description    TEXT,
  default_branch TEXT,
  pushed_at      TEXT,
  use_for        TEXT,       -- your note, e.g. "Flagship for this application"
  status         TEXT,       -- your status, e.g. "active", "paused"
  hidden         INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT
);

CREATE TABLE IF NOT EXISTS commits (
  sha      TEXT PRIMARY KEY,
  repo     TEXT NOT NULL,
  date_utc TEXT NOT NULL,
  message  TEXT NOT NULL,
  author   TEXT,
  url      TEXT
);
CREATE INDEX IF NOT EXISTS commits_repo_date ON commits(repo, date_utc);

CREATE TABLE IF NOT EXISTS prs (
  id         TEXT PRIMARY KEY,   -- repo#number
  repo       TEXT NOT NULL,
  number     INTEGER NOT NULL,
  title      TEXT NOT NULL,
  state      TEXT NOT NULL,
  created_at TEXT,
  closed_at  TEXT,
  merged_at  TEXT,
  updated_at TEXT,
  url        TEXT
);

-- Everything you want every agent to know: ideas, notes, instructions, decisions, todos.
CREATE TABLE IF NOT EXISTS entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,      -- idea | note | instruction | decision | todo | profile
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',   -- comma separated
  repo       TEXT,                       -- optional link to a repo
  source     TEXT,                       -- which chat/agent wrote it (claude, chatgpt, cursor...)
  status     TEXT NOT NULL DEFAULT 'open',
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_kind ON entries(kind, updated_at);

-- Activity rows already exported to your work log (so they aren't offered again).
CREATE TABLE IF NOT EXISTS logged_events (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 1,
  logged_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  summary     TEXT
);

CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);

-- History of context changes (added, updated, done, deleted...) for the activity log and overview.
-- Title/kind/repo/private are snapshots, so rows stay readable after the entry changes or is deleted.
CREATE TABLE IF NOT EXISTS entry_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  action   TEXT NOT NULL,   -- added | updated | done | reopened | archived | pinned | unpinned | deleted
  kind     TEXT NOT NULL,
  title    TEXT NOT NULL,
  repo     TEXT,
  source   TEXT,            -- who made the change: web, chatgpt, claude, gemini, agent...
  private  INTEGER NOT NULL DEFAULT 0,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entry_events_at ON entry_events(at);

-- Connections: one per app and account (e.g. "ChatGPT · main"), each with its own token.
-- Only a SHA-256 hash of the token is stored; the token itself is shown once on creation.
CREATE TABLE IF NOT EXISTS apps (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,   -- e.g. chatgpt-main
  preset       TEXT NOT NULL,          -- chatgpt | claude-web | claude-code | gemini-web | gemini-cli | antigravity | codex | cursor | copilot | other
  account      TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,          -- e.g. ChatGPT · main
  kind         TEXT NOT NULL,          -- web | ide | cli | other
  token_hash   TEXT NOT NULL UNIQUE,
  token_hint   TEXT NOT NULL,          -- last 4 characters, to recognise a token
  can_private  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

-- Continue-anywhere handoffs (docs/HANDOFF_PLAN.md): a task is worked on by one app after another; every app
-- appends checkpoints, so when one stops (usage limit, outage) the next resumes from the latest one and the git branch.
CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  goal       TEXT NOT NULL DEFAULT '',
  repo       TEXT,
  branch     TEXT,                       -- where the code is, e.g. wip/12-audit-log
  status     TEXT NOT NULL DEFAULT 'active', -- active | done | abandoned
  private    INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,                       -- connection slug
  owner      TEXT,                       -- connection that last worked on it
  result     TEXT,                       -- final summary when done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Append-only. Lists (done, next, files, decisions, questions) are JSON arrays of strings.
CREATE TABLE IF NOT EXISTS task_checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  app        TEXT,                       -- verified connection slug
  at         TEXT NOT NULL,
  reason     TEXT NOT NULL DEFAULT 'step', -- start | step | limit-warning | resumed | finished | abandoned | reopened
  summary    TEXT NOT NULL,
  done       TEXT NOT NULL DEFAULT '[]',
  next       TEXT NOT NULL DEFAULT '[]',
  files      TEXT NOT NULL DEFAULT '[]',
  decisions  TEXT NOT NULL DEFAULT '[]',
  questions  TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT,
  branch     TEXT
);
CREATE INDEX IF NOT EXISTS task_checkpoints_task ON task_checkpoints(task_id, at);
`);

// Columns added after the first release. Guarded so existing hub.db files keep working.
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
// private = 1: shown in the web UI, hidden from agents unless they ask over the bearer-token MCP connection.
if (!hasColumn('entries', 'private')) db.exec('ALTER TABLE entries ADD COLUMN private INTEGER NOT NULL DEFAULT 0');
// Which connection (app + account) created / last changed an entry, and made each change. Verified by token.
if (!hasColumn('entries', 'created_by')) db.exec('ALTER TABLE entries ADD COLUMN created_by TEXT');
if (!hasColumn('entries', 'updated_by')) db.exec('ALTER TABLE entries ADD COLUMN updated_by TEXT');
if (!hasColumn('entry_events', 'app')) db.exec('ALTER TABLE entry_events ADD COLUMN app TEXT');

export const now = () => new Date().toISOString();

// Fired after anything that changes what agents see (entries, project notes, a sync with changes).
// The Google Doc mirror listens to it.
export const changes = new EventEmitter();
export const notifyChange = (why) => changes.emit('change', why);

export function kvGet(key, fallback = null) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
export function kvSet(key, value) {
  db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
