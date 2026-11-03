// Query layer shared by the web UI, the REST API and the MCP server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { db, now, kvGet, kvSet, notifyChange } from './db.js';

const KINDS = ['idea', 'note', 'instruction', 'decision', 'todo', 'profile'];
export { KINDS };

/* ---------- dates ---------- */
// The timezone can change in the Settings tab, so the formatter follows config.timezone.
let dayFmt = null, dayTz = null;
export const localDay = (iso) => {
  if (!iso) return '';
  if (dayTz !== config.timezone) {
    dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayTz = config.timezone;
  }
  return dayFmt.format(new Date(iso));
};

/* ---------- activity log ---------- */
function firstLine(msg) {
  return msg.split('\n')[0].replace(/^(feat|fix|chore|docs|refactor|style|test|perf|build|ci)(\([^)]*\))?!?:\s*/i, '').trim();
}

// Merges already show up as "PR merged" rows (or are just branch bookkeeping), so they don't count as work.
const isMerge = (msg) => /^merge (pull request|branch|remote-tracking branch)\b/i.test(firstLine(msg));

function summarize(messages) {
  const seen = new Map(); // lower-cased line -> { text, n }
  for (const m of messages) {
    const l = firstLine(m);
    if (!l) continue;
    const k = l.toLowerCase();
    if (seen.has(k)) seen.get(k).n++;
    else seen.set(k, { text: l.charAt(0).toUpperCase() + l.slice(1), n: 1 });
  }
  let s = [...seen.values()].map((p) => (p.n > 1 ? `${p.text} (×${p.n})` : p.text)).join('; ');
  if (s.length > 160) s = s.slice(0, 157).replace(/[;,\s]+\S*$/, '') + '…';
  return s || '(no message)';
}

/**
 * Activity events, newest first: one row per day per repo for commits,
 * one row per PR event. Each has a stable `key` for "already logged" tracking.
 */
export function activity({ days = 60, repo = null, sinceDay = null } = {}) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const commits = db.prepare(
    `SELECT repo, date_utc, message FROM commits WHERE date_utc >= ? ${repo ? 'AND repo = ?' : ''} ORDER BY date_utc DESC`,
  ).all(...(repo ? [cutoff, repo] : [cutoff]));

  const byDay = new Map();
  for (const c of commits) {
    if (isMerge(c.message)) continue;
    const k =`${localDay(c.date_utc)}|${c.repo}`;
    if (!byDay.has(k)) byDay.set(k, { date: localDay(c.date_utc), repo: c.repo, msgs: [], ts: c.date_utc });
    byDay.get(k).msgs.push(c.message);
  }
  const events = [];
  for (const g of byDay.values()) {
    events.push({
      key: `commits:${g.repo}:${g.date}`, date: g.date, ts: g.ts, repo: g.repo, type: 'Commits', count: g.msgs.length,
      summary: `${g.msgs.length} commit${g.msgs.length > 1 ? 's' : ''}: ${summarize(g.msgs)}`,
    });
  }

  const prs = db.prepare(`SELECT * FROM prs WHERE updated_at >= ? ${repo ? 'AND repo = ?' : ''}`).all(...(repo ? [cutoff, repo] : [cutoff]));
  for (const p of prs) {
    const push = (type, ts) => ts && ts >= cutoff && events.push({
      key: `${type.toLowerCase().replace(' ', '-')}:${p.repo}:${p.number}`, date: localDay(ts), ts, repo: p.repo,
      type, count: 1, summary: `#${p.number} ${p.title}`, url: p.url,
    });
    push('PR opened', p.created_at);
    if (p.merged_at) push('PR merged', p.merged_at);
    else if (p.closed_at) push('PR closed', p.closed_at);
  }

  if (!repo) events.push(...contextActivity(cutoff));
  events.push(...taskActivity(cutoff, repo));

  const logged = new Map(db.prepare('SELECT key, count FROM logged_events').all().map((r) => [r.key, r.count]));
  return events
    .filter((e) => !sinceDay || e.date >= sinceDay)
    .map((e) => ({ ...e, logged: logged.has(e.key) && logged.get(e.key) === e.count, loggedBefore: logged.has(e.key) }))
    .sort((a, b) => (a.date === b.date ? b.ts.localeCompare(a.ts) : b.date.localeCompare(a.date)));
}

const ACTION_TEXT = { added: 'added', updated: 'updated', done: 'marked done', reopened: 'reopened', archived: 'archived', pinned: 'pinned', unpinned: 'unpinned', deleted: 'deleted' };

/**
 * Context changes as activity rows: one 'Context' row per local day, key `context:<date>`.
 * Events for private entries (then or now) are left out. Repeated identical changes collapse to (×N).
 */
function contextActivity(cutoff) {
  const rows = db.prepare(`SELECT ev.* FROM entry_events ev LEFT JOIN entries e ON e.id = ev.entry_id
    WHERE ev.at >= ? AND ev.private = 0 AND coalesce(e.private, 0) = 0 ORDER BY ev.at DESC`).all(cutoff);
  const byDay = new Map();
  const who = appResolver();
  for (const ev of rows) {
    const date = localDay(ev.at);
    if (!byDay.has(date)) byDay.set(date, { date, ts: ev.at, items: new Map(), count: 0 });
    const g = byDay.get(date);
    g.count++;
    const by = who(ev.app || ev.source);
    const text = `${ACTION_TEXT[ev.action] || ev.action} ${ev.kind} "${ev.title}"${by ? ` (${by.name})` : ''}`;
    g.items.set(text, (g.items.get(text) || 0) + 1);
  }
  return [...byDay.values()].map((g) => {
    let s = [...g.items].map(([t, n]) => (n > 1 ? `${t} (×${n})` : t)).join('; ');
    if (s.length > 200) s = s.slice(0, 197).replace(/[;,\s]+\S*$/, '') + '…';
    return { key: `context:${g.date}`, date: g.date, ts: g.ts, repo: 'KeepContext', type: 'Context', count: g.count,
      summary: `${g.count} change${g.count > 1 ? 's' : ''}: ${s}` };
  });
}

/** Activity rows that come from GitHub (the work log export tracks GitHub work only, not Context or Task rows). */
export const isGithubRow = (e) => e.type !== 'Context' && e.type !== 'Task';

/** Rows not yet exported to your work log. */
export function unloggedActivity(opts) {
  return activity(opts).filter((e) => !e.logged && isGithubRow(e));
}

export function markLogged(keys) {
  const all = new Map(activity({ days: 3650 }).map((e) => [e.key, e]));
  const stmt = db.prepare(`INSERT INTO logged_events(key, count, logged_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, logged_at=excluded.logged_at`);
  let n = 0;
  for (const k of keys) {
    const e = all.get(k);
    if (!e) continue;
    stmt.run(k, e.count, now());
    n++;
  }
  return n;
}

/* ---------- projects ---------- */
export function projects({ includeHidden = false } = {}) {
  return db.prepare(`SELECT * FROM repos ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY pushed_at DESC`).all()
    .map((r) => ({ ...r, private: !!r.private, hidden: !!r.hidden, last_push: localDay(r.pushed_at) }));
}

export function updateProject(name, { use_for, status, hidden }) {
  const r = db.prepare('SELECT name FROM repos WHERE name = ?').get(name);
  if (!r) throw new Error(`No repo named ${name}. Run a sync first.`);
  if (use_for !== undefined) db.prepare('UPDATE repos SET use_for = ? WHERE name = ?').run(use_for, name);
  if (status !== undefined) db.prepare('UPDATE repos SET status = ? WHERE name = ?').run(status, name);
  if (hidden !== undefined) db.prepare('UPDATE repos SET hidden = ? WHERE name = ?').run(hidden ? 1 : 0, name);
  notifyChange('project');
  return db.prepare('SELECT * FROM repos WHERE name = ?').get(name);
}

/* ---------- connections: one per app and account, each with its own token ---------- */
/** Apps the hub knows how to connect. `connect`: how the app sends the token (a secret URL, or a header). */
export const APP_PRESETS = {
  chatgpt: { label: 'ChatGPT', kind: 'web', connect: 'secret-url' },
  'claude-web': { label: 'Claude', kind: 'web', connect: 'secret-url' },
  'gemini-web': { label: 'Gemini', kind: 'web', connect: 'secret-url' },
  'claude-code': { label: 'Claude Code', kind: 'cli', connect: 'header' },
  'gemini-cli': { label: 'Gemini CLI', kind: 'cli', connect: 'header' },
  codex: { label: 'Codex', kind: 'cli', connect: 'header' },
  antigravity: { label: 'Antigravity', kind: 'ide', connect: 'header' },
  cursor: { label: 'Cursor', kind: 'ide', connect: 'header' },
  copilot: { label: 'Copilot', kind: 'ide', connect: 'header' },
  other: { label: 'Other', kind: 'other', connect: 'header' },
};
// Callers that aren't connections: the web UI, and anything using the shared HUB_TOKEN.
const BUILTIN = { web: 'Web UI', 'shared-token': 'Shared token' };

const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const appOut = (r) => r && {
  id: r.id, slug: r.slug, preset: r.preset, account: r.account, name: r.name, kind: r.kind,
  canPrivate: !!r.can_private, tokenHint: r.token_hint, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  revoked: !!r.revoked_at, revokedAt: r.revoked_at,
};
const newToken = () => `chub_${crypto.randomBytes(32).toString('hex')}`;

/** Create a connection (app + account). Returns the token once; only its hash is stored. */
export function createApp({ preset, account = '', canPrivate = false } = {}) {
  const p = APP_PRESETS[preset];
  if (!p) throw new Error(`preset must be one of ${Object.keys(APP_PRESETS).join(', ')}`);
  const acct = String(account || '').trim().slice(0, 40);
  const suffix = acct.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-');
  const base = suffix ? `${preset}-${suffix}` : preset;
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM apps WHERE slug = ?').get(slug); i++) slug = `${base}-${i}`;
  const token = newToken();
  const { lastInsertRowid } = db.prepare(`INSERT INTO apps(slug, preset, account, name, kind, token_hash, token_hint, can_private, created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(slug, preset, acct, acct ? `${p.label} · ${acct}` : p.label, p.kind,
    hashToken(token), token.slice(-4), canPrivate ? 1 : 0, now());
  return { app: appOut(db.prepare('SELECT * FROM apps WHERE id = ?').get(lastInsertRowid)), token };
}

/** All connections with how much each has changed (never returns tokens or hashes). */
export function listApps() {
  const stats = new Map(db.prepare(`SELECT app, count(*) changes, sum(action = 'added') added, max(at) last_change
    FROM entry_events WHERE app IS NOT NULL GROUP BY app`).all().map((r) => [r.app, r]));
  return db.prepare('SELECT * FROM apps ORDER BY revoked_at IS NOT NULL, preset, account').all().map((r) => {
    const st = stats.get(r.slug) || {};
    return { ...appOut(r), changes: st.changes || 0, added: st.added || 0, lastChangeAt: st.last_change || null };
  });
}

/** New token for a connection; the old one stops working immediately. */
export function rotateApp(id) {
  const r = db.prepare('SELECT * FROM apps WHERE id = ? AND revoked_at IS NULL').get(id);
  if (!r) throw new Error(`No active connection ${id}`);
  const token = newToken();
  db.prepare('UPDATE apps SET token_hash = ?, token_hint = ? WHERE id = ?').run(hashToken(token), token.slice(-4), id);
  return { app: appOut(db.prepare('SELECT * FROM apps WHERE id = ?').get(id)), token };
}

export function revokeApp(id) {
  const n = Number(db.prepare('UPDATE apps SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id).changes);
  if (!n) throw new Error(`No active connection ${id}`);
  return appOut(db.prepare('SELECT * FROM apps WHERE id = ?').get(id));
}

/** The active connection a token belongs to, or null. Tokens are random, so a hash lookup is safe. */
export function findAppByToken(token) {
  if (!token || !String(token).startsWith('chub_')) return null;
  return appOut(db.prepare('SELECT * FROM apps WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)));
}

/** Remember when a connection was last used (at most one write a minute). */
export function touchApp(id) {
  const t = now();
  db.prepare('UPDATE apps SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
    .run(t, id, new Date(Date.now() - 60e3).toISOString());
}

/** Display info for an app slug: a connection, a built-in caller, a preset, or a legacy free-text source. */
function appResolver() {
  const conns = new Map(db.prepare('SELECT slug, name, preset FROM apps').all().map((r) => [r.slug, r]));
  return (slug) => {
    if (!slug) return null;
    const c = conns.get(slug);
    if (c) return { slug, name: c.name, preset: c.preset, verified: true };
    if (BUILTIN[slug]) return { slug, name: BUILTIN[slug], preset: slug, verified: true };
    const p = APP_PRESETS[slug];
    return { slug, name: p ? p.label : slug, preset: p ? slug : 'other', verified: false };
  };
}

/* ---------- entries (ideas, notes, instructions...) ---------- */
const normTags = (t) => (Array.isArray(t) ? t : String(t || '').split(','))
  .map((s) => s.trim().toLowerCase()).filter(Boolean).join(',');

const rowOut = (r) => r && { ...r, pinned: !!r.pinned, private: !!r.private, tags: r.tags ? r.tags.split(',') : [] };

/**
 * Record a context change for the activity log and overview (snapshot of the entry as it is now).
 * app: the verified connection/caller slug; source: what the client reported (may differ).
 */
function logEvent(action, row, { app = null, source = null } = {}) {
  db.prepare('INSERT INTO entry_events(entry_id, action, kind, title, repo, source, private, at, app) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.id, action, row.kind, row.title, row.repo || null, source || app || null, row.private ? 1 : 0, now(), app || null);
}

// The single word that best describes an update, for the activity log.
function updateAction(cur, next) {
  if (cur.status !== next.status) return { done: 'done', archived: 'archived' }[next.status] || 'reopened';
  const contentChanged = ['kind', 'title', 'body', 'tags', 'repo', 'private'].some((f) => cur[f] !== next[f]);
  if (!contentChanged && cur.pinned !== next.pinned) return next.pinned ? 'pinned' : 'unpinned';
  return contentChanged ? 'updated' : null;
}

/** app: the verified caller (connection slug, 'web' or 'shared-token'); source: what the client reported. */
export function createEntry({ kind = 'note', title, body = '', tags = '', repo = null, source = null, pinned = false, status = 'open', private: priv = false, app = null }) {
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  if (!title || !String(title).trim()) throw new Error('title is required');
  const t = now();
  const { lastInsertRowid } = db.prepare(`INSERT INTO entries(kind, title, body, tags, repo, source, status, pinned, private, created_at, updated_at, created_by, updated_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(kind, String(title).trim(), body, normTags(tags), repo || null, source || app || null, status, pinned ? 1 : 0, priv ? 1 : 0, t, t, app || null, app || null);
  const row = getEntry(lastInsertRowid);
  logEvent('added', row, { app, source });
  notifyChange('entry');
  return row;
}

export const getEntry = (id) => rowOut(db.prepare('SELECT * FROM entries WHERE id = ?').get(id));

/**
 * includePrivate=false treats private entries as missing, so an agent can't read or edit one by guessing its id.
 * by: the verified caller making the change (connection slug, 'web' or 'shared-token'), recorded on the entry and in the log.
 */
export function updateEntry(id, patch, { includePrivate = false, by = null } = {}) {
  const cur = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!cur || (cur.private && !includePrivate)) throw new Error(`No entry ${id}`);
  const next = { ...cur };
  for (const f of ['kind', 'title', 'body', 'repo', 'source', 'status']) if (patch[f] !== undefined) next[f] = patch[f];
  if (patch.tags !== undefined) next.tags = normTags(patch.tags);
  if (patch.pinned !== undefined) next.pinned = patch.pinned ? 1 : 0;
  if (patch.private !== undefined) next.private = patch.private ? 1 : 0;
  if (!KINDS.includes(next.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);
  const action = updateAction(cur, next);
  db.prepare(`UPDATE entries SET kind=?, title=?, body=?, tags=?, repo=?, source=?, status=?, pinned=?, private=?, updated_at=?, updated_by=? WHERE id=?`)
    .run(next.kind, next.title, next.body, next.tags, next.repo, next.source, next.status, next.pinned, next.private, now(), action ? (by || cur.updated_by) : cur.updated_by, id);
  if (action) logEvent(action, next, { app: by });
  notifyChange('entry');
  return getEntry(id);
}

export function deleteEntry(id, { by = null } = {}) {
  const cur = db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
  if (!cur) return false;
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  logEvent('deleted', cur, { app: by });
  notifyChange('entry');
  return true;
}

/** Private entries are left out unless includePrivate is true (web UI, or a bearer-token MCP call that asks). */
export function listEntries({ kind, tag, repo, status, source, app, q, limit = 50, includePrivate = false } = {}) {
  const where = [];
  const args = [];
  if (!includePrivate) where.push('private = 0');
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (status) { where.push('status = ?'); args.push(status); }
  if (repo) { where.push('repo = ?'); args.push(repo); }
  if (source) { where.push('source = ?'); args.push(source); }
  // A connection slug (chatgpt-main) or a preset (chatgpt: every ChatGPT account).
  if (app) { where.push("(created_by = ? OR updated_by = ? OR created_by LIKE ? OR updated_by LIKE ?)"); args.push(app, app, `${app}-%`, `${app}-%`); }
  if (tag) { where.push("(',' || tags || ',') LIKE ?"); args.push(`%,${tag.toLowerCase()},%`); }
  if (q) {
    for (const word of String(q).toLowerCase().split(/\s+/).filter(Boolean)) {
      where.push("lower(title || ' ' || body || ' ' || tags || ' ' || coalesce(repo,'')) LIKE ?");
      args.push(`%${word}%`);
    }
  }
  const sql = `SELECT * FROM entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pinned DESC, updated_at DESC LIMIT ?`;
  const who = appResolver();
  return db.prepare(sql).all(...args, Math.min(Number(limit) || 50, 500))
    .map((r) => ({ ...rowOut(r), createdBy: who(r.created_by), updatedBy: who(r.updated_by) }));
}

/* ---------- the bundle every agent loads first ---------- */
export function contextBundle({ repo = null, activityDays = 14, includePrivate = false, taskViewer = null } = {}) {
  const entries = (opts) => listEntries({ ...opts, includePrivate });
  const lines = [];
  lines.push(config.ownerName ? `# Context for ${config.ownerName}` : '# My context');
  lines.push(`Generated ${now()} by KeepContext. Last GitHub sync: ${kvGet('last_sync_at') || 'never'}.`);
  lines.push('');

  const section = (title, rows, fmt) => {
    if (!rows.length) return;
    lines.push(`## ${title}`);
    for (const r of rows) lines.push(fmt(r));
    lines.push('');
  };
  const entryLine = (e) => `- [#${e.id}] **${e.title}**${e.private ? ' (private)' : ''}${e.repo ? ` (repo: ${e.repo})` : ''}${e.tags.length ? ` — tags: ${e.tags.join(', ')}` : ''}${e.body ? `\n  ${e.body.replace(/\n/g, '\n  ')}` : ''}`;

  section('Profile', entries({ kind: 'profile', limit: 20 }), entryLine);
  section('Standing instructions (follow these)', entries({ kind: 'instruction', limit: 50 }).filter((e) => e.status !== 'archived'), entryLine);
  if (repo) section(`Notes for ${repo}`, entries({ repo, limit: 30 }), entryLine);
  section('Pinned', entries({ limit: 20 }).filter((e) => e.pinned && !['profile', 'instruction'].includes(e.kind)), entryLine);
  section('Recent ideas', entries({ kind: 'idea', status: 'open', limit: 15 }), entryLine);
  section('Recent decisions', entries({ kind: 'decision', limit: 10 }), entryLine);
  section('Open todos', entries({ kind: 'todo', status: 'open', limit: 15 }), entryLine);
  section('Open tasks (work another app may have left mid-way: continue with `resume_task`)',
    listTasks({ status: 'active', repo, limit: 10 }, taskViewer || { includePrivate }), (t) =>
      `- [task ${t.id}] **${t.title}**${t.private ? ' (private)' : ''}${t.repo ? ` (repo: ${t.repo}, branch: ${t.branch})` : ''}`
      + `${t.last ? ` — last: ${t.last.app?.name || '—'}, ${ago(t.last.at)}: ${t.last.summary}` : ''}${t.next.length ? `\n  Next: ${t.next[0]}` : ''}`);

  const proj = projects().slice(0, 15);
  section('Projects (GitHub, newest push first)', proj, (p) =>
    `- ${p.name} — ${p.private ? 'private' : 'public'}, last push ${p.last_push || '—'}${p.status ? `, status: ${p.status}` : ''}${p.use_for ? ` — ${p.use_for}` : ''}`);

  section(`Repo activity, last ${activityDays} days`, activity({ days: activityDays, repo }).filter(isGithubRow).slice(0, 40), (e) =>
    `- ${e.date} · ${e.repo} · ${e.type} · ${e.summary}`);

  lines.push('---');
  lines.push('Save new ideas, decisions and notes back with the `save_entry` tool so every other agent sees them.');
  lines.push('For multi-step work, `start_task` and then `checkpoint_task` after each step, so another app can continue if you stop.');
  return lines.join('\n');
}

/* ---------- work log export (a Markdown table to paste into your own log, CV notes or status doc) ---------- */
export function workLogRows({ onlyUnlogged = true, days = 60 } = {}) {
  const ev = onlyUnlogged ? unloggedActivity({ days }) : activity({ days }).filter(isGithubRow);
  const table = ['| Date | Repo | Type | Summary |', '| --- | --- | --- | --- |',
    ...ev.map((e) => `| ${e.date} | ${e.repo} | ${e.type} | ${e.summary.replace(/\|/g, '/')} |`)];
  return { events: ev, markdown: table.join('\n') };
}

/* ---------- context files to drop into a repo ---------- */
export function repoContextFiles({ repo = null, base = config.publicUrl } = {}) {
  const url = `${base}/mcp`;
  const instructions = listEntries({ kind: 'instruction', limit: 50 }).filter((e) => e.status !== 'archived');
  const repoNotes = repo ? listEntries({ repo, limit: 20 }) : [];

  const agents = [
    `# Agent instructions${repo ? ` for ${repo}` : ''}`,
    '',
    `${config.ownerName ? `This repo belongs to ${config.ownerName}. ` : ''}Shared context (ideas, decisions, standing instructions, project status)`,
    `lives in KeepContext, an MCP server at \`${url}\` (named \`keepcontext\` in your MCP config).`,
    '',
    '## At the start of a task',
    `- Call the \`get_context\` tool${repo ? ` with \`repo: "${repo}"\`` : ''} and follow the standing instructions it returns.`,
    '- If the keepcontext MCP server is not connected, use the snapshot below and say it may be out of date.',
    '',
    '## While you work',
    '- When the user shares a new idea, makes a decision, or asks you to remember something, call `save_entry`',
    '  (kind: idea | decision | note | todo | instruction) with `source` set to your tool name.',
    '- Use `search_context` before asking the user for background they may have given before.',
    '',
    '## Multi-step work (continue anywhere)',
    `- At the start, call \`list_open_tasks\`${repo ? ` with \`repo: "${repo}"\`` : ''}. If one fits, \`resume_task\` and continue from its next steps.`,
    '- For new work that takes more than a few steps: `start_task`, work on the branch it returns, commit work in progress,',
    '  and call `checkpoint_task` after each meaningful step (summary, next steps, files, commit). Your app can stop at any',
    '  time (usage limits), so the last checkpoint is all the next app gets.',
    '- When the goal is met: `finish_task`.',
    '',
    `## Snapshot (generated ${localDay(now())})`,
    '',
    ...(instructions.length ? ['### Standing instructions', ...instructions.map((e) => `- ${e.title}${e.body ? `: ${e.body.replace(/\n+/g, ' ')}` : ''}`), ''] : []),
    ...(repoNotes.length ? [`### Notes for ${repo}`, ...repoNotes.map((e) => `- (${e.kind}) ${e.title}${e.body ? `: ${e.body.replace(/\n+/g, ' ')}` : ''}`), ''] : []),
  ].join('\n');

  return {
    'AGENTS.md': agents + '\n',
    // Claude Code reads CLAUDE.md, not AGENTS.md; importing keeps one source of truth.
    'CLAUDE.md': '@AGENTS.md\n',
    // Gemini CLI reads GEMINI.md by default; Antigravity also picks up workspace rules.
    'GEMINI.md': '@AGENTS.md\n',
    '.cursor/rules/keepcontext.mdc': `---\ndescription: Shared context from KeepContext\nalwaysApply: true\n---\n\nFollow AGENTS.md at the repo root. Call the keepcontext MCP tool \`get_context\` at the start of a task and \`save_entry\` for new ideas or decisions.\n`,
  };
}

/* ---------- tasks: continue-anywhere handoffs (docs/HANDOFF_PLAN.md) ---------- */
export const TASK_STATUSES = ['active', 'done', 'abandoned'];
const STALE_MS = 2 * 3600e3; // an active task with no checkpoint for this long is flagged in the UI
const BUSY_MS = 10 * 60e3;   // another app checkpointed this recently: it may still be working
const strList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
const parseList = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };
const slugify = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
const ago = (iso) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const cpRows = (taskId) => db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY at, id').all(taskId);
const cpOut = (c, who) => ({
  id: c.id, app: who(c.app), at: c.at, reason: c.reason, summary: c.summary, done: parseList(c.done), next: parseList(c.next),
  files: parseList(c.files), decisions: parseList(c.decisions), questions: parseList(c.questions), commit: c.commit_sha, branch: c.branch,
});
// Consecutive apps that worked on a task, e.g. ["Claude Code", "Codex"].
const appChain = (cps, who) => cps.map((c) => c.app).filter((a, i, all) => a && a !== all[i - 1])
  .map((a) => who(a)?.name || a).filter((n, i, all) => n !== all[i - 1]);

/**
 * viewer = { app, includePrivate, viaUrl }: app is the caller's connection slug (recorded on checkpoints).
 * Who sees a task: everyone for public ones. Private ones (company repos) only for callers allowed private context
 * (web UI, header token with private access) or the connections that worked on it, never over the secret URL.
 */
function canSeeTask(t, { includePrivate = false, app = null, viaUrl = false } = {}) {
  if (!t.private || includePrivate) return true;
  if (!app || viaUrl) return false;
  return t.created_by === app || !!db.prepare('SELECT 1 FROM task_checkpoints WHERE task_id = ? AND app = ? LIMIT 1').get(t.id, app);
}
function visibleTask(id, viewer) {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
  if (!t || !canSeeTask(t, viewer)) throw new Error(`Task ${id} not found`);
  return t;
}
function taskOut(t, { checkpoints = false } = {}) {
  const who = appResolver();
  const cps = cpRows(t.id);
  const work = cps.filter((c) => c.reason !== 'resumed');
  const last = cps.at(-1);
  return {
    id: t.id, title: t.title, goal: t.goal, repo: t.repo, branch: t.branch, status: t.status, private: !!t.private,
    createdBy: who(t.created_by), owner: who(t.owner), result: t.result, createdAt: t.created_at, updatedAt: t.updated_at,
    checkpointCount: work.length, chain: appChain(cps, who),
    last: last ? cpOut(last, who) : null,
    next: parseList([...work].reverse().find((c) => parseList(c.next).length)?.next),
    stale: t.status === 'active' && !!last && Date.now() - Date.parse(last.at) > STALE_MS,
    ...(checkpoints ? { checkpoints: cps.map((c) => cpOut(c, who)) } : {}),
  };
}
function addCheckpoint(taskId, app, cp) {
  const at = now();
  db.prepare(`INSERT INTO task_checkpoints(task_id, app, at, reason, summary, done, next, files, decisions, questions, commit_sha, branch)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(taskId, app, at, cp.reason || 'step', String(cp.summary || '').trim() || '(no summary)',
    JSON.stringify(strList(cp.done)), JSON.stringify(strList(cp.next)), JSON.stringify(strList(cp.files)),
    JSON.stringify(strList(cp.decisions)), JSON.stringify(strList(cp.questions)), cp.commit || null, cp.branch || null);
  db.prepare('UPDATE tasks SET owner = ?, updated_at = ?, branch = coalesce(?, branch) WHERE id = ?').run(app, at, cp.branch || null, taskId);
}

/** Start a task. Tasks for repos the hub doesn't sync (company repos) are private unless said otherwise. */
export function startTask({ title, goal = '', repo = null, branch = null, private: priv, next = [] } = {}, { app = null, viaUrl = false } = {}) {
  title = String(title || '').trim();
  if (!title) throw new Error('title is required');
  repo = repo ? String(repo).trim() : null;
  const known = repo && db.prepare('SELECT 1 FROM repos WHERE name = ?').get(repo);
  const isPrivate = priv ?? (!!repo && !known && !viaUrl);
  const t = now();
  const id = Number(db.prepare(`INSERT INTO tasks(title, goal, repo, branch, private, created_by, owner, created_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(title, String(goal || ''), repo, branch || null, isPrivate ? 1 : 0, app, app, t, t).lastInsertRowid);
  if (!branch) db.prepare('UPDATE tasks SET branch = ? WHERE id = ?').run(`wip/${id}-${slugify(title)}`, id);
  addCheckpoint(id, app, { reason: 'start', summary: goal ? `Started: ${goal}` : 'Started', next });
  return taskOut(visibleTask(id, { includePrivate: true }));
}

export function checkpointTask(id, cp = {}, viewer = {}) {
  const t = visibleTask(id, viewer);
  if (t.status !== 'active') throw new Error(`Task ${id} is ${t.status}. Reopen it in the web UI (Tasks tab) before adding checkpoints.`);
  addCheckpoint(t.id, viewer.app || null, { ...cp, reason: cp.reason === 'limit-warning' ? 'limit-warning' : 'step' });
  return taskOut(visibleTask(t.id, { includePrivate: true }));
}

/** status: active (default) | done | abandoned | all. */
export function listTasks({ status = 'active', repo = null, limit = 50 } = {}, viewer = {}) {
  const where = []; const args = [];
  if (status && status !== 'all') { where.push('status = ?'); args.push(status); }
  if (repo) { where.push('repo = ?'); args.push(repo); }
  return db.prepare(`SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC`).all(...args)
    .filter((t) => canSeeTask(t, viewer)).slice(0, Math.min(Number(limit) || 50, 200)).map((t) => taskOut(t));
}

export const getTask = (id, viewer = {}) => taskOut(visibleTask(id, viewer), { checkpoints: true });

export function finishTask(id, { summary = '', status = 'done' } = {}, viewer = {}) {
  const t = visibleTask(id, viewer);
  if (!['done', 'abandoned'].includes(status)) throw new Error('status must be done or abandoned');
  addCheckpoint(t.id, viewer.app || null, { reason: status === 'done' ? 'finished' : 'abandoned', summary: summary || (status === 'done' ? 'Finished' : 'Abandoned') });
  db.prepare('UPDATE tasks SET status = ?, result = ? WHERE id = ?').run(status, summary || null, t.id);
  return taskOut(visibleTask(t.id, { includePrivate: true }));
}

export function reopenTask(id, viewer = {}) {
  const t = visibleTask(id, viewer);
  if (t.status === 'active') return taskOut(t);
  addCheckpoint(t.id, viewer.app || null, { reason: 'reopened', summary: 'Reopened' });
  db.prepare("UPDATE tasks SET status = 'active' WHERE id = ?").run(t.id);
  return taskOut(visibleTask(t.id, { includePrivate: true }));
}

/**
 * The brief the next app needs to continue: goal, where the last app stopped, its next steps, the branch, the history,
 * and (for an app that worked on it before) what others did since its own last checkpoint. Records the handoff
 * ("resumed") and makes the caller the owner, unless the task is finished (then it's a review only).
 */
export function resumeTask({ id = null, repo = null } = {}, viewer = {}) {
  let t;
  if (id) t = visibleTask(id, viewer);
  else {
    const open = listTasks({ status: 'active', repo }, viewer);
    if (!open.length) return `No open tasks${repo ? ` for ${repo}` : ''}. Start one with start_task.`;
    t = visibleTask(open[0].id, viewer);
  }
  const who = appResolver();
  const app = viewer.app || null;
  const me = who(app)?.name || 'you';
  let cps = cpRows(t.id);
  const lastOther = [...cps].reverse().find((c) => c.app !== app && c.reason !== 'resumed');
  const busy = t.status === 'active' && lastOther && Date.now() - Date.parse(lastOther.at) < BUSY_MS ? lastOther : null;
  const mine = [...cps].reverse().find((c) => c.app === app && c.reason !== 'resumed');
  const sinceMine = mine ? cps.filter((c) => c.id > mine.id && c.app !== app && c.reason !== 'resumed') : [];

  // A handoff is recorded only when the task changes hands (the owner resuming its own task changes nothing).
  if (t.status === 'active' && t.owner !== app) {
    addCheckpoint(t.id, app, { reason: 'resumed', summary: `Resumed by ${me}` });
    t = visibleTask(t.id, { includePrivate: true });
    cps = cpRows(t.id);
  }
  const o = taskOut(t);
  const work = cps.filter((c) => c.reason !== 'resumed');
  const lastWork = work.at(-1);
  const commit = [...work].reverse().find((c) => c.commit_sha)?.commit_sha;
  const L = [];
  L.push(`# Task #${t.id}: ${t.title} (${t.status}${t.private ? ', private' : ''})`);
  L.push(`Repo: ${t.repo || '—'} · Branch: \`${t.branch || '—'}\`${commit ? ` · Last commit: ${commit}` : ''} · Started by ${who(t.created_by)?.name || '—'} ${ago(t.created_at)} · Apps so far: ${o.chain.join(' → ') || '—'}`);
  if (busy) L.push('', `**Warning:** ${who(busy.app)?.name || busy.app} checkpointed ${ago(busy.at)}. It may still be working on this task; check with the user before you continue.`);
  if (t.goal) L.push('', '## Goal', t.goal);
  if (t.status !== 'active') L.push('', `## Result (${t.status})`, t.result || lastWork?.summary || '—');
  else if (lastWork) {
    L.push('', `## Pick up here (last checkpoint: ${who(lastWork.app)?.name || '—'}, ${ago(lastWork.at)}${lastWork.reason === 'limit-warning' ? ', it was near its usage limit' : ''})`, lastWork.summary);
    if (o.next.length) L.push('', 'Next steps:', ...o.next.map((n, i) => `${i + 1}. ${n}`));
    const q = parseList(lastWork.questions);
    if (q.length) L.push('', 'Open questions:', ...q.map((x) => `- ${x}`));
  }
  if (t.status === 'active') {
    L.push('', '## Get the code', '```', `git fetch origin 2>/dev/null; git switch ${t.branch}`, '```',
      'If the branch is missing, the previous app committed only on another machine or not at all: ask the user before starting over.');
  }
  if (sinceMine.length) {
    L.push('', `## Since your last checkpoint (${ago(mine.at)})`, ...sinceMine.map((c) => `- ${who(c.app)?.name || '—'}: ${c.summary}${c.commit_sha ? ` (${c.commit_sha})` : ''}`));
    const myCommit = [...cps].reverse().find((c) => c.app === app && c.commit_sha && c.id <= mine.id)?.commit_sha;
    if (myCommit) L.push(`Review the code: \`git diff ${myCommit}..HEAD\``);
  }
  L.push('', '## History (oldest first)');
  for (const c of work) {
    const extra = [parseList(c.files).length ? `files: ${parseList(c.files).join(', ')}` : '', parseList(c.decisions).length ? `decided: ${parseList(c.decisions).join('; ')}` : '', c.commit_sha ? `commit ${c.commit_sha}` : '']
      .filter(Boolean).join(' · ');
    L.push(`- ${localDay(c.at)} ${c.at.slice(11, 16)} UTC · ${who(c.app)?.name || '—'} · ${c.reason}: ${c.summary}${extra ? ` (${extra})` : ''}`);
  }
  if (t.status === 'active') {
    L.push('', '## How to continue',
      `- You are now the owner of task ${t.id}. Work on the branch and commit work in progress ("WIP: task ${t.id} <step>").`,
      `- After each meaningful step call checkpoint_task (task_id ${t.id}) with a short summary, the next steps, files and the commit, so any other app can take over if you stop.`,
      '- Near your usage limit: checkpoint at once with reason "limit-warning".',
      '- When the goal is met: finish_task with a short result.');
  }
  return L.join('\n');
}

/** One 'Task' activity row per task per local day (key task:<id>:<date>); private tasks left out. */
function taskActivity(cutoff, repo = null) {
  const rows = db.prepare(`SELECT c.task_id, c.app, c.at, c.reason, t.title, t.repo FROM task_checkpoints c JOIN tasks t ON t.id = c.task_id
    WHERE c.at >= ? AND t.private = 0 ${repo ? 'AND t.repo = ?' : ''} ORDER BY c.at, c.id`).all(...(repo ? [cutoff, repo] : [cutoff]));
  const who = appResolver();
  const groups = new Map();
  for (const c of rows) {
    const date = localDay(c.at);
    const k = `${c.task_id}|${date}`;
    if (!groups.has(k)) groups.set(k, { id: c.task_id, date, title: c.title, repo: c.repo, cps: [], ts: c.at });
    const g = groups.get(k);
    g.cps.push(c);
    g.ts = c.at;
  }
  return [...groups.values()].map((g) => {
    const n = g.cps.filter((c) => c.reason !== 'resumed').length;
    const end = g.cps.find((c) => c.reason === 'finished' || c.reason === 'abandoned');
    return { key: `task:${g.id}:${g.date}`, date: g.date, ts: g.ts, repo: g.repo || 'KeepContext', type: 'Task', count: g.cps.length,
      summary: `#${g.id} "${g.title}": ${appChain(g.cps, who).join(' → ')}, ${n} checkpoint${n === 1 ? '' : 's'}${end ? ` (${end.reason})` : ''}` };
  });
}

/* ---------- GitHub sync runs (errors shown in the UI header and the Activity tab) ---------- */
/** Recent sync runs, newest first. notable: only runs that failed, had repo errors or brought new commits. */
export function syncRuns({ limit = 20, notable = false } = {}) {
  const where = notable
    ? `WHERE ok IS NOT 1 OR json_array_length(summary, '$.errors') > 0 OR json_extract(summary, '$.newCommits') > 0` : '';
  return db.prepare(`SELECT * FROM sync_runs ${where} ORDER BY id DESC LIMIT ?`).all(Math.min(Number(limit) || 20, 200))
    .map((r) => {
      const s = JSON.parse(r.summary || '{}');
      return {
        id: r.id, startedAt: r.started_at, finishedAt: r.finished_at,
        // ok: true = finished (repo errors possible), false = the whole run failed, null = still running or interrupted.
        ok: r.ok === null ? null : !!r.ok,
        seconds: r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 100) / 10 : null,
        repos: s.repos || 0, reposChanged: s.reposChanged || [], newCommits: s.newCommits || 0, prsTouched: s.prsTouched || 0,
        errors: s.errors || [], error: s.error || null,
      };
    });
}
/** The last run plus the repos waiting to be fetched again after an error. */
export function syncHealth() {
  return { lastRun: syncRuns({ limit: 1 })[0] || null, retrying: Object.keys(JSON.parse(kvGet('sync_retry') || '{}')) };
}

/* ---------- overview (web UI dashboard; the UI sees private entries, marked) ---------- */
export function overview() {
  const counts = {};
  for (const r of db.prepare('SELECT kind, status, count(*) n FROM entries GROUP BY kind, status').all()) {
    counts[r.kind] ??= { open: 0, done: 0, archived: 0 };
    counts[r.kind][r.status] = (counts[r.kind][r.status] || 0) + r.n;
  }
  const who = appResolver();
  const recentChanges = db.prepare(`SELECT ev.*, coalesce(e.private, ev.private) AS now_private FROM entry_events ev
    LEFT JOIN entries e ON e.id = ev.entry_id ORDER BY ev.at DESC LIMIT 15`).all()
    .map((ev) => ({ entryId: ev.entry_id, action: ev.action, kind: ev.kind, title: ev.title,
      app: who(ev.app || ev.source),
      // What the client said it was, shown only when it differs from the verified connection.
      reported: ev.app && ev.source && ev.source !== ev.app ? ev.source : null,
      private: !!(ev.private || ev.now_private), at: ev.at, date: localDay(ev.at) }));
  // Every app that changed something (connections, the web UI, the shared token, and older free-text sources).
  const byApp = db.prepare(`SELECT coalesce(app, source) AS slug, count(*) changes, sum(action = 'added') added, max(at) last_at
    FROM entry_events WHERE coalesce(app, source) IS NOT NULL GROUP BY 1 ORDER BY last_at DESC`).all()
    .map((r) => ({ ...who(r.slug), changes: r.changes, added: r.added, lastAt: r.last_at }));
  return {
    counts,
    pinned: listEntries({ status: 'open', limit: 200, includePrivate: true }).filter((e) => e.pinned),
    recentChanges,
    recentGithub: activity({ days: 30 }).filter(isGithubRow).slice(0, 8),
    activeTasks: listTasks({ status: 'active', limit: 6 }, { includePrivate: true }),
    apps: listApps().filter((a) => !a.revoked),
    byApp,
    lastSyncAt: kvGet('last_sync_at'),
  };
}

/* ---------- Google Doc mirror content (public only; rendered with real formatting by gdoc.js) ---------- */
/**
 * A list of paragraphs: { t: 'title'|'h1'|'h2'|'h3'|'p'|'li', runs: [{ text, bold, italic, muted, link }] }.
 * More complete than the agent bundle: every public entry (notes, done, archived), all projects, 30 days of activity.
 * stamp: the paragraph index of the "last updated" line, which is left out of change detection.
 */
export function mirrorModel({ activityDays = 30 } = {}) {
  const blocks = [];
  const add = (t, ...runs) => blocks.push({ t, runs: runs.map((r) => (typeof r === 'string' ? { text: r } : r)) });
  const all = listEntries({ limit: 500 }); // public only
  const date = (iso) => localDay(iso);

  const entryBlocks = (e) => {
    const meta = [e.kind, ...e.tags.map((t) => `#${t}`), e.repo && `repo: ${e.repo}`, e.source && `from ${e.source}`,
      e.status !== 'open' && e.status, `updated ${date(e.updated_at)}`].filter(Boolean).join(' · ');
    add('p', { text: e.title, bold: true }, { text: `   ${meta}`, italic: true, muted: true });
    for (const line of String(e.body || '').split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.*)$/);
      if (m) add('li', m[1]);
      else if (line.trim()) add('p', line.trim());
    }
  };

  const open = all.filter((e) => e.status === 'open');
  const sections = [
    ['Profile', open.filter((e) => e.kind === 'profile')],
    ['Standing instructions', open.filter((e) => e.kind === 'instruction')],
    ['Pinned', open.filter((e) => e.pinned && !['profile', 'instruction'].includes(e.kind))],
    ['Open todos', open.filter((e) => e.kind === 'todo' && !e.pinned)],
    ['Ideas', open.filter((e) => e.kind === 'idea' && !e.pinned)],
    ['Decisions', open.filter((e) => e.kind === 'decision' && !e.pinned)],
    ['Notes', open.filter((e) => e.kind === 'note' && !e.pinned)],
    ['Done and archived', all.filter((e) => e.status !== 'open')],
  ].filter(([, rows]) => rows.length);
  const proj = projects();
  const act = activity({ days: activityDays });

  add('title', config.ownerName ? `KeepContext: ${config.ownerName}` : 'KeepContext');
  const stamp = blocks.length;
  add('p', { text: `Last updated ${new Date().toLocaleString('en-GB', { timeZone: config.timezone })} (${config.timezone}). `, italic: true, muted: true },
    { text: 'Auto-generated by KeepContext; edits here are overwritten. Private entries are never included.', italic: true, muted: true });
  add('h2', 'Contents');
  for (const [name] of sections) add('li', name);
  if (proj.length) add('li', 'Projects');
  if (act.length) add('li', `Activity, last ${activityDays} days`);

  for (const [name, rows] of sections) {
    add('h1', name);
    rows.forEach(entryBlocks);
  }
  if (proj.length) {
    add('h1', 'Projects');
    for (const p of proj) {
      add('li', p.html_url ? { text: p.name, bold: true, link: p.html_url } : { text: p.name, bold: true },
        ` — ${p.private ? 'private' : 'public'}, last push ${p.last_push || '—'}${p.status ? `, status: ${p.status}` : ''}${p.use_for ? `. ${p.use_for}` : ''}${p.description ? `. ${p.description}` : ''}`);
    }
  }
  if (act.length) {
    add('h1', `Activity, last ${activityDays} days`);
    let day = null;
    for (const e of act) {
      if (e.date !== day) { day = e.date; add('h3', day); }
      add('li', { text: `${e.repo} · ${e.type}: `, bold: true }, e.url ? { text: e.summary, link: e.url } : e.summary);
    }
  }
  return { blocks, stamp };
}

/* ---------- one-time backfill: attribution for entries made before connections existed ---------- */
if (!kvGet('backfill_app_v1')) {
  db.exec(`UPDATE entries SET created_by = lower(source) WHERE created_by IS NULL AND source IS NOT NULL;
    UPDATE entries SET updated_by = created_by WHERE updated_by IS NULL;`);
  kvSet('backfill_app_v1', now());
}

/* ---------- connect helper served by the hub (GET /connect.sh) ---------- */
/**
 * scripts/connect-app.sh with this hub's public URL as the default, so anyone can run
 * `curl -fsSL <hub>/connect.sh | bash -s <app>` without cloning the repo. Contains no secrets.
 */
export function connectScript(base = config.publicUrl) {
  const src = fs.readFileSync(new URL('../scripts/connect-app.sh', import.meta.url), 'utf8');
  // The served copy always targets this hub (a HUB_URL left in the user's shell must not redirect it).
  return src.replace(/url="\$\{HUB_URL:-[^}]*\}"/, `url="${base}"`);
}
