// End-to-end tests: starts a fake GitHub and the hub, then drives the REST API and MCP.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MOCK_PORT = 19911;
const HUB_PORT = 18799;
// Fresh random values each run, so no fixed credential-looking strings live in the repo.
const TOKEN = randomBytes(24).toString('hex');
const ADMIN_PW = randomBytes(12).toString('hex');
const BASE = `http://localhost:${HUB_PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-'));
// Throwaway service-account key for the fake Google (Google Doc mirror tests).
const GOOGLE_PORT = 19912;
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-key-'));
const saFile = path.join(keyDir, 'sa.json');
fs.writeFileSync(saFile, JSON.stringify({
  client_email: 'hub-test@example.iam.gserviceaccount.com',
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }),
}));
const procs = [];

async function waitFor(url, ok = (r) => r.status < 500) {
  for (let i = 0; i < 150; i++) { // up to 15 s: a busy CI runner can be slow to start a hub
    try { if (ok(await fetch(url))) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function start(script, env) {
  const p = spawn(process.execPath, ['--no-warnings', script], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.resolve(import.meta.dirname, '..'),
  });
  p.stderr.on('data', (d) => process.stderr.write(d));
  procs.push(p);
  return p;
}

const api = (p, opts = {}) => fetch(`${BASE}/api${p}`, {
  ...opts,
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  body: opts.body ? JSON.stringify(opts.body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

before(async () => {
  start('test/mock-github.mjs', { MOCK_PORT: String(MOCK_PORT) });
  await waitFor(`http://localhost:${MOCK_PORT}/user/repos`, (r) => r.status === 401);
  start('test/mock-google.mjs', { MOCK_GOOGLE_PORT: String(GOOGLE_PORT), GOOGLE_SA_KEY_FILE: saFile });
  await waitFor(`http://localhost:${GOOGLE_PORT}/_doc`);
  start('src/server.js', {
    HUB_TOKEN: TOKEN, ADMIN_PASSWORD: ADMIN_PW, GITHUB_TOKEN: 'ghtest', GITHUB_OWNER: 'alexdev',
    GITHUB_API_URL: `http://localhost:${MOCK_PORT}`, DATA_DIR: dataDir, PORT: String(HUB_PORT),
    PUBLIC_URL: BASE, AUTO_SYNC_HOURS: '0', AUTO_SYNC_MINUTES: '0',
    GOOGLE_DOC_ID: 'test-doc', GOOGLE_SA_KEY_FILE: saFile, GDOC_DEBOUNCE_SECONDS: '0.3',
    GOOGLE_TOKEN_URL: `http://localhost:${GOOGLE_PORT}/token`, GOOGLE_DOCS_API_URL: `http://localhost:${GOOGLE_PORT}`,
  });
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(keyDir, { recursive: true, force: true });
});

test('API rejects requests without the token', async () => {
  const r = await fetch(`${BASE}/api/status`);
  assert.equal(r.status, 401);
  const m = await fetch(`${BASE}/mcp/k/wrong`, { method: 'POST' });
  assert.equal(m.status, 401);
});

test('sync pulls repos, commits and PRs; second sync is incremental', async () => {
  const first = await api('/sync', { method: 'POST' });
  assert.equal(first.status, 200);
  assert.equal(first.data.repos, 4);
  assert.ok(first.data.reposChanged.includes('notes-app'));
  assert.equal(first.data.newCommits, 7); // merges are stored; the activity log skips them
  assert.deepEqual(first.data.errors, []);

  const second = await api('/sync', { method: 'POST' });
  assert.equal(second.data.newCommits, 0);
});

test('activity log groups commits per day per repo and lists PR events', async () => {
  const { data } = await api('/activity?days=60');
  const types = data.map((e) => e.type);
  assert.ok(types.includes('Commits'));
  assert.ok(types.includes('PR opened'));
  assert.ok(types.includes('PR merged'));
  const dates = data.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  const c = data.find((e) => e.type === 'Commits' && e.repo === 'notes-app' && e.count === 2);
  assert.ok(c, 'commits on one day collapse into one row, merge commits not counted');
  assert.ok(!/merge pull request/i.test(c.summary), 'merge commits are left out of the summary');
  assert.equal(data.filter((e) => e.repo === 'weather-cli' && e.type === 'Commits').length, 1,
    'a day with only merge commits produces no row');
  const rel = data.find((e) => e.repo === 'weather-cli' && e.type === 'Commits');
  assert.equal(rel.summary, '2 commits: Release 0.9.1 (×2)', 'repeated messages are listed once with a count');
});

test('unlogged rows shrink after mark-logged', async () => {
  const before1 = await api('/activity/unlogged');
  const keys = before1.data.events.slice(0, 2).map((e) => e.key);
  const m = await api('/activity/mark-logged', { method: 'POST', body: { keys } });
  assert.equal(m.data.marked, 2);
  const after1 = await api('/activity/unlogged');
  assert.equal(after1.data.events.length, before1.data.events.length - 2);
  assert.match(after1.data.markdown, /^\| Date \| Repo \| Type \| Summary \|/);
});

test('entries CRUD and search', async () => {
  const c = await api('/entries', { method: 'POST', body: { kind: 'idea', title: 'SMS alerts', tags: 'mobile, sms', repo: 'notes-app' } });
  assert.equal(c.status, 200);
  assert.deepEqual(c.data.tags, ['mobile', 'sms']);
  const bad = await api('/entries', { method: 'POST', body: { kind: 'nope', title: 'x' } });
  assert.equal(bad.status, 400);
  const u = await api(`/entries/${c.data.id}`, { method: 'PATCH', body: { status: 'done', pinned: true } });
  assert.equal(u.data.status, 'done');
  assert.equal(u.data.pinned, true);
  const s = await api('/entries?q=sms');
  assert.equal(s.data.length, 1);
  const d = await api(`/entries/${c.data.id}`, { method: 'DELETE' });
  assert.equal(d.data.deleted, true);
});

test('projects keep your own notes across syncs', async () => {
  await api('/projects/notes-app', { method: 'PATCH', body: { use_for: 'Flagship', status: 'active' } });
  await api('/sync', { method: 'POST' });
  const { data } = await api('/projects');
  const p = data.find((r) => r.name === 'notes-app');
  assert.equal(p.use_for, 'Flagship');
  assert.equal(p.status, 'active');
});

test('MCP: tools work with a bearer header and with the secret URL', async () => {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }));
  const tools = (await c.listTools()).tools;
  const names = tools.map((t) => t.name);
  // Apps that search their tools (e.g. Codex with many servers) must find ours by the name "KeepContext".
  assert.ok(tools.every((t) => t.title.startsWith('KeepContext: ') && t.description.startsWith('KeepContext')), 'every tool says KeepContext');
  for (const n of ['get_context', 'save_entry', 'search_context', 'sync_github', 'get_unlogged_activity']) assert.ok(names.includes(n), n);

  await c.callTool({ name: 'save_entry', arguments: { kind: 'instruction', title: 'Keep answers short', source: 'test' } });
  const ctx = await c.callTool({ name: 'get_context', arguments: {} });
  assert.match(ctx.content[0].text, /Keep answers short/);
  assert.match(ctx.content[0].text, /notes-app/);

  const err = await c.callTool({ name: 'update_project', arguments: { name: 'does-not-exist' } });
  assert.equal(err.isError, true);
  await c.close();

  const c2 = new Client({ name: 'test2', version: '1' });
  await c2.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/k/${TOKEN}`)));
  assert.ok((await c2.listTools()).tools.length >= 10);
  await c2.close();
});

test('private entries: shown in the UI, hidden from agents unless asked over the bearer header', async () => {
  const SECRET = 'Zebra-private-salary-note';
  const { data: p } = await api('/entries', { method: 'POST', body: { kind: 'instruction', title: SECRET, private: true } });
  assert.equal(p.private, true);
  const { data: pub } = await api('/entries', { method: 'POST', body: { kind: 'instruction', title: 'Public-visible-note' } });
  assert.equal(pub.private, false);

  // Web UI list includes it.
  assert.ok((await api('/entries')).data.some((e) => e.id === p.id && e.private));
  // REST bundle, export and repo files leave it out.
  const bundle = await fetch(`${BASE}/api/context`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
  assert.ok(!bundle.includes(SECRET) && bundle.includes('Public-visible-note'));
  assert.ok(!(await api('/export')).data.entries.some((e) => e.id === p.id));
  assert.ok(!JSON.stringify((await api('/repo-files')).data).includes(SECRET));

  const run = async (client, name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

  // Bearer header: hidden by default, visible with include_private.
  const c = new Client({ name: 'priv', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  assert.ok(!(await run(c, 'get_context', {})).includes(SECRET));
  assert.ok(!(await run(c, 'search_context', { query: SECRET })).includes(SECRET));
  assert.ok(!(await run(c, 'list_entries', { kind: 'instruction' })).includes(SECRET));
  assert.ok(!(await run(c, 'get_repo_context_files', {})).includes(SECRET));
  assert.match(await run(c, 'get_context', { include_private: true }), new RegExp(`${SECRET}\\*\\* \\(private\\)`));
  assert.ok((await run(c, 'search_context', { query: SECRET, include_private: true })).includes(SECRET));
  assert.ok((await run(c, 'list_entries', { kind: 'instruction', include_private: true })).includes(SECRET));
  await c.close();

  // Secret URL: include_private is ignored, and the entry can't be read or edited by id.
  const k = new Client({ name: 'priv-url', version: '1' });
  await k.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp/k/${TOKEN}`)));
  assert.ok(!(await run(k, 'get_context', { include_private: true })).includes(SECRET));
  assert.ok(!(await run(k, 'search_context', { query: SECRET, include_private: true })).includes(SECRET));
  assert.ok(!(await run(k, 'list_entries', { include_private: true })).includes(SECRET));
  const upd = await k.callTool({ name: 'update_entry', arguments: { id: p.id, private: false } });
  assert.equal(upd.isError, true);
  await k.close();
  assert.equal((await api('/entries')).data.find((e) => e.id === p.id).private, true, 'still private');

  // Unticking it in the UI makes it visible to agents again.
  await api(`/entries/${p.id}`, { method: 'PATCH', body: { private: false } });
  const after = await fetch(`${BASE}/api/context`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
  assert.ok(after.includes(SECRET));
  await api(`/entries/${p.id}`, { method: 'DELETE' });
});

test('Google Doc mirror: push now, auto-push after changes, never private entries', async () => {
  const doc = () => fetch(`http://localhost:${GOOGLE_PORT}/_doc`).then((r) => r.json());
  const status = (await api('/status')).data;
  assert.equal(status.version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(status.gdoc.configured, true);
  assert.equal(status.gdoc.auth, 'key');
  assert.match(status.gdoc.docUrl, /test-doc/);

  const { data: secret } = await api('/entries', { method: 'POST', body: { kind: 'instruction', title: 'Mirror-private-xyz', private: true } });
  await api('/entries', { method: 'POST', body: { kind: 'instruction', title: 'Mirror-public-abc' } });

  const push = await api('/gdoc/push', { method: 'POST' });
  assert.equal(push.status, 200);
  assert.equal(push.data.skipped, false);
  let d = await doc();
  assert.match(d.text, /^KeepContext\n/);
  assert.ok(d.text.includes('Mirror-public-abc'));
  assert.ok(!d.text.includes('Mirror-private-xyz'), 'private entries never reach the Doc');
  assert.ok(!d.text.includes('KeepContext: ', 10), 'old content replaced, not appended');
  // Real formatting, and the fuller content (contents list, sections, projects, activity).
  assert.equal(d.styles.TITLE, 1);
  assert.ok(d.styles.HEADING_1 >= 3 && d.styles.createParagraphBullets >= 2 && d.styles.updateTextStyle >= 3, JSON.stringify(d.styles));
  for (const h of ['Contents', 'Standing instructions', 'Projects', 'Activity, last 30 days']) assert.ok(d.text.includes(h), h);

  // A change triggers a debounced push without pressing anything.
  await api('/entries', { method: 'POST', body: { kind: 'instruction', title: 'Mirror-auto-push-def' } });
  for (let i = 0; i < 40 && !(d = await doc()).text.includes('Mirror-auto-push-def'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(d.text.includes('Mirror-auto-push-def'));
  assert.equal((await api('/status')).data.gdoc.lastError, null);
  await api(`/entries/${secret.id}`, { method: 'DELETE' });
});

test('Google Doc mirror: keyless mode on a Google Cloud VM (metadata server token)', async () => {
  const port = 18798;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-keyless-'));
  const p = start('src/server.js', {
    HUB_TOKEN: TOKEN, DATA_DIR: dir, PORT: String(port), GITHUB_TOKEN: '', AUTO_SYNC_MINUTES: '0', AUTO_SYNC_HOURS: '0',
    GOOGLE_DOC_ID: 'test-doc', GOOGLE_SA_KEY_FILE: path.join(dir, 'no-such-key.json'),
    GOOGLE_METADATA_URL: `http://localhost:${GOOGLE_PORT}`, GOOGLE_DOCS_API_URL: `http://localhost:${GOOGLE_PORT}`,
  });
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const call = (p2, opts = {}) => fetch(`http://localhost:${port}/api${p2}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } }).then((r) => r.json());
    const st = await call('/status');
    assert.equal(st.gdoc.configured, true);
    assert.equal(st.gdoc.auth, 'metadata');
    await call('/entries', { method: 'POST', body: JSON.stringify({ kind: 'instruction', title: 'Keyless-mirror-ghi' }) });
    const r = await call('/gdoc/push', { method: 'POST' });
    assert.equal(r.ok, true);
    const d = await fetch(`http://localhost:${GOOGLE_PORT}/_doc`).then((x) => x.json());
    assert.ok(d.text.includes('Keyless-mirror-ghi'));
  } finally {
    p.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('context changes show in the activity log (one row per day), never private, never in the work log export', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
  const { data: e } = await api('/entries', { method: 'POST', body: { kind: 'todo', title: 'Ctx-log-todo', source: 'chatgpt' } });
  await api(`/entries/${e.id}`, { method: 'PATCH', body: { status: 'done' } });
  const { data: p } = await api('/entries', { method: 'POST', body: { kind: 'note', title: 'Ctx-log-private', private: true } });

  const rows = (await api('/activity?days=60')).data;
  const ctxRows = rows.filter((r) => r.type === 'Context');
  assert.equal(ctxRows.length, 1, 'one Context row per day');
  const row = ctxRows[0];
  assert.equal(row.key, `context:${today}`);
  // The verified caller wins over what the client claims: these calls use the shared token.
  assert.match(row.summary, /added todo "Ctx-log-todo" \(Shared token\)/);
  assert.match(row.summary, /marked done todo "Ctx-log-todo" \(Shared token\)/);
  assert.ok(!row.summary.includes('Ctx-log-private'), 'private entries never in the log');

  assert.ok(!(await api('/activity/unlogged')).data.events.some((r) => r.type === 'Context'), 'work log stays GitHub-only');
  const mcpLike = await fetch(`${BASE}/api/context`, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.text());
  assert.ok(!mcpLike.includes('Ctx-log-todo" (chatgpt)'), 'bundle activity section stays GitHub-only');

  // Overview: counts, pinned, recent changes (the UI sees private changes, marked).
  const ov = (await api('/overview')).data;
  assert.ok(ov.counts.todo.done >= 1);
  assert.ok(ov.recentChanges.some((c) => c.title === 'Ctx-log-private' && c.private));
  assert.ok(ov.byApp.some((a) => a.slug === 'shared-token' && a.changes >= 2));
  // Source filter for the entries list.
  assert.ok((await api('/entries?source=chatgpt')).data.every((x) => x.source === 'chatgpt'));
  await api(`/entries/${p.id}`, { method: 'DELETE' });
});

test('connections: one token per app and account, verified attribution, scoped access', async () => {
  const as = (token, p, opts = {}) => fetch(`${BASE}/api${p}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));
  const mcp = async (url, headers, name, args) => {
    const c = new Client({ name: 'conn', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
    const r = await c.callTool({ name, arguments: args });
    await c.close();
    return r;
  };

  // Same app, two accounts, plus an IDE with private access.
  const { data: main } = await api('/apps', { method: 'POST', body: { preset: 'chatgpt', account: 'main' } });
  const { data: work } = await api('/apps', { method: 'POST', body: { preset: 'chatgpt', account: 'work' } });
  const { data: code } = await api('/apps', { method: 'POST', body: { preset: 'claude-code', canPrivate: true } });
  assert.match(main.token, /^chub_[0-9a-f]{64}$/);
  assert.equal(main.app.name, 'ChatGPT · main');
  assert.equal(work.app.slug, 'chatgpt-work');
  assert.equal(code.app.canPrivate, true);
  const list = await api('/apps');
  const listJson = JSON.stringify(list.data);
  assert.ok(!listJson.includes(main.token) && !listJson.includes('token_hash'), 'tokens never listed');
  assert.ok(list.data.presets.gemini_web === undefined && list.data.presets['gemini-web']);

  // Secret URL with a connection token: the hub records the connection, not what the model claims.
  await mcp(`${BASE}/mcp/k/${main.token}`, null, 'save_entry', { kind: 'idea', title: 'From-chatgpt-main', source: 'gemini' });
  const saved = (await api('/entries?app=chatgpt-main')).data.find((e) => e.title === 'From-chatgpt-main');
  assert.equal(saved.createdBy.name, 'ChatGPT · main');
  assert.equal(saved.createdBy.verified, true);
  const change = (await api('/overview')).data.recentChanges.find((c) => c.title === 'From-chatgpt-main');
  assert.equal(change.app.slug, 'chatgpt-main');
  assert.equal(change.reported, 'gemini');

  // Edit from the other account (Bearer header); the preset filter finds both accounts' work.
  await mcp(`${BASE}/mcp`, { Authorization: `Bearer ${work.token}` }, 'update_entry', { id: saved.id, status: 'done' });
  const edited = (await api('/entries?app=chatgpt')).data.find((e) => e.id === saved.id);
  assert.equal(edited.updatedBy.slug, 'chatgpt-work');
  assert.equal(edited.createdBy.slug, 'chatgpt-main');
  const ctxRow = (await api('/activity?days=60')).data.find((r) => r.type === 'Context');
  assert.match(ctxRow.summary, /ChatGPT · main/);
  assert.match(ctxRow.summary, /ChatGPT · work/);

  // Private entries: only a connection allowed private access, only over the header.
  const { data: secret } = await api('/entries', { method: 'POST', body: { kind: 'instruction', title: 'Conn-private-qrs', private: true } });
  const bundle = async (url, headers) => (await mcp(url, headers, 'get_context', { include_private: true })).content[0].text;
  assert.ok(!(await bundle(`${BASE}/mcp`, { Authorization: `Bearer ${main.token}` })).includes('Conn-private-qrs'));
  assert.ok((await bundle(`${BASE}/mcp`, { Authorization: `Bearer ${code.token}` })).includes('Conn-private-qrs'));
  assert.ok(!(await bundle(`${BASE}/mcp/k/${code.token}`, null)).includes('Conn-private-qrs'));

  // REST with a connection token: entries and the bundle only; no private entries without permission; no admin routes.
  const asMain = await as(main.token, '/entries');
  assert.equal(asMain.status, 200);
  assert.ok(!asMain.data.some((e) => e.id === secret.id));
  assert.equal((await as(main.token, '/apps')).status, 403);
  assert.equal((await as(main.token, '/export')).status, 403);
  const quick = await as(main.token, '/entries', { method: 'POST', body: { kind: 'note', title: 'Quick-capture-main' } });
  assert.equal(quick.data.created_by, 'chatgpt-main');
  assert.ok((await api('/apps')).data.apps.find((a) => a.slug === 'chatgpt-main').lastUsedAt, 'last used recorded');

  // The helper script is public, carries this hub's URL, and never any secret.
  const script = await fetch(`${BASE}/connect.sh`).then(async (r) => ({ status: r.status, type: r.headers.get('content-type'), text: await r.text() }));
  assert.equal(script.status, 200);
  assert.match(script.type, /shellscript/);
  assert.ok(script.text.includes(`url="${BASE}"`));
  assert.ok(!script.text.includes(TOKEN) && !script.text.includes(main.token));

  // Rotate and revoke: old tokens stop working at once.
  const { data: rotated } = await api(`/apps/${main.app.id}/rotate`, { method: 'POST' });
  assert.equal((await as(main.token, '/entries')).status, 401);
  assert.equal((await as(rotated.token, '/entries')).status, 200);
  await api(`/apps/${work.app.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${BASE}/mcp/k/${work.token}`, { method: 'POST' })).status, 401);
  assert.equal((await api('/apps')).data.apps.find((a) => a.slug === 'chatgpt-work').revoked, true);
  await api(`/entries/${secret.id}`, { method: 'DELETE' });
});

test('backup script snapshots the live database while the hub runs', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-backup-'));
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('bash', ['scripts/backup.sh', '--stdout'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: outDir, BACKUP_KEEP: '3' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(out.subarray(0, 15).toString(), 'SQLite format 3', 'stdout is the database file');
    const files = fs.readdirSync(outDir).filter((f) => /^hub-\d{8}-\d{6}\.db$/.test(f));
    assert.equal(files.length, 1);
    assert.equal(fs.statSync(path.join(outDir, files[0])).mode & 0o777, 0o600, 'snapshot is private');
    const { DatabaseSync } = await import('node:sqlite');
    const snap = new DatabaseSync(path.join(outDir, files[0]), { readOnly: true });
    assert.equal(snap.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const live = (await api('/entries?limit=500')).data.length;
    assert.equal(snap.prepare('SELECT count(*) n FROM entries').get().n, live, 'snapshot has every entry');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test('repo context files point agents at the hub', async () => {
  const { data } = await api('/repo-files?repo=notes-app');
  assert.ok(data['AGENTS.md'].includes(`${BASE}/mcp`));
  assert.equal(data['CLAUDE.md'].trim(), '@AGENTS.md');
  assert.ok(data['.cursor/rules/keepcontext.mdc'].includes('alwaysApply: true'));
});

test('sync errors: shown in status and sync runs, failed repos fetched again on the next run', async () => {
  const mock = `http://localhost:${MOCK_PORT}`;
  await fetch(`${mock}/_fail/weather-cli`, { method: 'POST' });
  const bad = await api('/sync', { method: 'POST' });
  assert.equal(bad.status, 200);
  assert.equal(bad.data.errors.length, 1);
  assert.match(bad.data.errors[0], /^weather-cli: GitHub 500/);

  const st = (await api('/status')).data;
  assert.equal(st.sync.lastRun.ok, true);
  assert.equal(st.sync.lastRun.errors.length, 1);
  assert.deepEqual(st.sync.retrying, ['weather-cli']);
  const notable = (await api('/sync-runs?notable=1')).data;
  assert.equal(notable[0].errors.length, 1, 'the failed run is listed first');
  const all = (await api('/sync-runs?limit=50')).data;
  assert.ok(all.length > notable.length, 'idle runs are left out of the notable list');
  assert.ok(all.every((r) => typeof r.seconds === 'number'));

  // Fixed, and pushed two days ago: only the retry list makes the hub fetch it again.
  await fetch(`${mock}/_fail/weather-cli`, { method: 'DELETE' });
  const good = await api('/sync', { method: 'POST' });
  assert.deepEqual(good.data.errors, []);
  assert.ok(good.data.reposChanged.includes('weather-cli'), 'retried');
  assert.deepEqual((await api('/status')).data.sync.retrying, []);
  const next = await api('/sync', { method: 'POST' });
  assert.ok(!next.data.reposChanged.includes('weather-cli'), 'not fetched again once it worked');
});

test('rate limits: failed logins, wrong tokens, requests per app', async () => {
  const port = HUB_PORT - 1;
  const base = `http://localhost:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-rl-'));
  const p = start('src/server.js', {
    HUB_TOKEN: TOKEN, ADMIN_PASSWORD: ADMIN_PW, GITHUB_TOKEN: '', DATA_DIR: dir, PORT: String(port), PUBLIC_URL: base,
    AUTO_SYNC_MINUTES: '0', GOOGLE_DOC_ID: '',
    LOGIN_MAX_FAILS: '3', LOGIN_MAX_FAILS_TOTAL: '5', BAD_TOKEN_MAX: '3', RATE_LIMIT_PER_MINUTE: '10',
  });
  try {
    await waitFor(`${base}/healthz`);
    // The test talks to the hub over loopback, which is a trusted proxy, so X-Forwarded-For sets the client IP.
    const login = (ip, password) => fetch(`${base}/login`, {
      method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }),
      headers: { 'X-Forwarded-For': ip },
    }).then((r) => r.headers.get('location'));

    for (let i = 0; i < 3; i++) assert.equal(await login('203.0.113.1', 'wrong'), '/?error=1');
    assert.equal(await login('203.0.113.1', ADMIN_PW), '/?error=locked', 'blocked IP: even the right password is refused');
    assert.equal(await login('203.0.113.2', ADMIN_PW), '/', 'another IP still signs in');
    // Failures from many IPs add up: 3 + 2 = 5 in total locks new sign-ins for everyone.
    await login('203.0.113.3', 'wrong'); await login('203.0.113.4', 'wrong');
    assert.equal(await login('203.0.113.5', ADMIN_PW), '/?error=locked');

    const call = (ip, token) => fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } });
    for (let i = 0; i < 3; i++) assert.equal((await call('198.51.100.7', 'wrong')).status, 401);
    const blocked = await call('198.51.100.7', 'wrong');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const mcp = await fetch(`${base}/mcp/k/wrong`, { method: 'POST', headers: { 'X-Forwarded-For': '198.51.100.7' } });
    assert.equal(mcp.status, 429, 'secret-URL guesses count too');
    assert.equal((await call('198.51.100.7', TOKEN)).status, 200, 'a valid token is never locked out');

    // Per app: 10 requests a minute here (600 by default). One was used just above.
    const codes = [];
    for (let i = 0; i < 10; i++) codes.push((await call('198.51.100.8', TOKEN)).status);
    assert.equal(codes.filter((c) => c === 200).length, 9);
    assert.equal(codes.at(-1), 429);
  } finally {
    p.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tasks: one app starts, another resumes from the last checkpoint, the first reviews; private tasks stay private', async () => {
  const conn = async (preset, canPrivate = false) => (await api('/apps', { method: 'POST', body: { preset, account: 'tasks', canPrivate } })).data;
  const claude = await conn('claude-code');
  const codex = await conn('codex');
  const chat = await conn('chatgpt');
  const client = async (url, headers) => {
    const c = new Client({ name: 'tasks', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
    return c;
  };
  const call = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content?.[0]?.text}`);
    const t = r.content[0].text;
    try { return JSON.parse(t); } catch { return t; }
  };
  const a = await client(`${BASE}/mcp`, { Authorization: `Bearer ${claude.token}` });
  const b = await client(`${BASE}/mcp`, { Authorization: `Bearer ${codex.token}` });
  const url = await client(`${BASE}/mcp/k/${chat.token}`);

  // Claude Code starts a task on a synced repo and checkpoints twice, the last time near its limit.
  const t = await call(a, 'start_task', { title: 'Audit log', goal: 'Record every status change', repo: 'notes-app', next: ['Add migration'] });
  assert.equal(t.branch, `wip/${t.id}-audit-log`);
  assert.equal(t.private, false, 'synced repo: public');
  assert.equal(t.createdBy.slug, 'claude-code-tasks');
  await call(a, 'checkpoint_task', { task_id: t.id, summary: 'Migration and model done', files: ['db/migrations/007_audit.sql'], commit: 'abc1234', next: ['Add PATCH /notes/:id/tags', 'Write the Supertest test'] });
  await call(a, 'checkpoint_task', { task_id: t.id, summary: 'Route half written', reason: 'limit-warning', next: ['Finish PATCH /notes/:id/tags', 'Write the Supertest test'] });

  // Every app sees the open task at the start, with its next step.
  assert.match(await call(url, 'get_context'), new RegExp(`\\[task ${t.id}\\] \\*\\*Audit log\\*\\*[\\s\\S]*Next: Finish PATCH`));
  const open = await call(b, 'list_open_tasks', { repo: 'notes-app' });
  assert.equal(open[0].id, t.id);
  assert.equal(open[0].owner.slug, 'claude-code-tasks');

  // Codex resumes: gets where Claude Code stopped, the branch, and a warning that Claude Code was active minutes ago.
  const brief = await call(b, 'resume_task', { repo: 'notes-app' });
  assert.match(brief, /Pick up here \(last checkpoint: Claude Code · tasks, just now, it was near its usage limit\)/);
  assert.match(brief, /1\. Finish PATCH \/notes\/:id\/tags/);
  assert.match(brief, new RegExp(`git switch wip/${t.id}-audit-log`));
  assert.match(brief, /Warning:.*Claude Code · tasks/);
  await call(b, 'checkpoint_task', { task_id: t.id, summary: 'Route and test done', commit: 'def5678', next: ['UI: show the audit trail'] });
  assert.equal((await call(b, 'resume_task', { task_id: t.id })).match(/Resumed by/g), null, 'history hides resume markers');
  const after = (await api(`/tasks/${t.id}`)).data;
  assert.equal(after.owner.slug, 'codex-tasks');
  assert.deepEqual(after.chain, ['Claude Code · tasks', 'Codex · tasks']);
  assert.equal(after.checkpoints.filter((c) => c.reason === 'resumed').length, 1, 'the owner resuming its own task is not a handoff');

  // Claude Code comes back: it sees what Codex did since its own last checkpoint, and how to diff it.
  const review = await call(a, 'resume_task', { task_id: t.id });
  assert.match(review, /Since your last checkpoint[\s\S]*Codex · tasks: Route and test done \(def5678\)/);
  assert.match(review, /git diff abc1234\.\.HEAD/);

  // Finish; a finished task is review-only and no longer open; checkpoints are refused until reopened.
  await call(b, 'finish_task', { task_id: t.id, summary: 'Merged in PR #20' });
  assert.equal((await call(a, 'list_open_tasks')).some((x) => x.id === t.id), false);
  assert.match(await call(a, 'resume_task', { task_id: t.id }), /## Result \(done\)\nMerged in PR #20/);
  const refused = await a.callTool({ name: 'checkpoint_task', arguments: { task_id: t.id, summary: 'late' } });
  assert.equal(refused.isError, true);
  assert.equal((await api(`/tasks/${t.id}/reopen`, { method: 'POST' })).data.status, 'active');
  await api(`/tasks/${t.id}/finish`, { method: 'POST', body: { summary: 'Done again' } });

  // Activity: one Task row per day naming the apps; never in the work log rows.
  const row = (await api('/activity?days=2')).data.find((r) => r.key === `task:${t.id}:${r.date}`);
  assert.equal(row.type, 'Task');
  assert.match(row.summary, /Audit log": Claude Code · tasks → Codex · tasks → .*checkpoints \(finished\)/);
  assert.ok(!(await api('/activity/unlogged')).data.events.some((r) => r.type === 'Task'));

  // A repo the hub doesn't sync (company work) is private: the creator and connections with private access see it,
  // other connections and the secret URL never do.
  const p = await call(a, 'start_task', { title: 'Company refactor', repo: 'acme-billing' });
  assert.equal(p.private, true);
  assert.ok((await call(a, 'list_open_tasks')).some((x) => x.id === p.id), 'creator sees it');
  assert.ok(!(await call(b, 'list_open_tasks')).some((x) => x.id === p.id), 'codex without private access does not');
  assert.equal((await b.callTool({ name: 'resume_task', arguments: { task_id: p.id } })).isError, true);
  assert.ok(!(await call(url, 'get_context')).includes('Company refactor'));
  const urlCreator = await client(`${BASE}/mcp/k/${claude.token}`);
  assert.ok(!(await call(urlCreator, 'list_open_tasks')).some((x) => x.id === p.id), 'not even the creator over the secret URL');
  assert.ok((await api('/tasks')).data.some((x) => x.id === p.id), 'the web UI sees it');
  assert.ok(!(await api('/activity?days=2')).data.some((r) => r.key.startsWith(`task:${p.id}:`)), 'not in the activity log');
  assert.equal((await call(url, 'start_task', { title: 'From chat', repo: 'acme-billing' })).private, false, 'secret-URL tasks default to public');

  for (const c of [a, b, url, urlCreator]) await c.close();
  for (const x of [claude, codex, chat]) await api(`/apps/${x.app.id}`, { method: 'DELETE' });
});

// A second hub with no HUB_TOKEN in the environment: the first-run setup and the Settings tab.
async function freshHub(port, env = {}) {
  const base = `http://localhost:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-fresh-'));
  const p = start('src/server.js', {
    HUB_TOKEN: '', ADMIN_PASSWORD: '', GITHUB_TOKEN: '', GITHUB_OWNER: '', OWNER_NAME: '', TIMEZONE: '',
    GITHUB_API_URL: `http://localhost:${MOCK_PORT}`, DATA_DIR: dir, PORT: String(port), PUBLIC_URL: base,
    AUTO_SYNC_MINUTES: '0', GOOGLE_DOC_ID: '', ...env,
  });
  await waitFor(`${base}/healthz`);
  return { base, stop: () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('first-run setup: setup code, password, generated admin token; then settings and GitHub from the UI', async () => {
  const { base, stop } = await freshHub(HUB_PORT - 2, { SETUP_CODE: 'C0DE42' });
  const call = (p, { method = 'GET', body, token, cookie } = {}) => fetch(`${base}${p}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
  try {
    // Before setup: the page is the setup form; the API and MCP say so.
    assert.match(await (await fetch(base)).text(), /Welcome to KeepContext/);
    assert.equal((await call('/api/status')).status, 503);
    assert.equal((await call('/mcp', { method: 'POST' })).status, 503);
    assert.match((await (await call('/setup', { method: 'POST', body: { code: 'nope', password: 'long-enough-pw' } })).json()).error, /setup code/);
    assert.match((await (await call('/setup', { method: 'POST', body: { code: 'c0de42', password: 'short' } })).json()).error, /8 characters/);
    const done = await call('/setup', { method: 'POST', body: { code: 'c0de42', password: 'long-enough-pw', ownerName: 'Sam', timezone: 'Europe/Berlin' } });
    assert.equal(done.status, 200);
    const { token } = await done.json();
    assert.match(token, /^[0-9a-f]{64}$/);
    const setupCookie = cookieOf(done);
    assert.equal((await call('/api/status', { cookie: setupCookie })).status, 200, 'signed in right after setup');
    assert.equal((await call('/setup', { method: 'POST', body: { code: 'c0de42', password: 'another-password' } })).status, 409);

    // The token, the password and the settings work.
    const status = await (await call('/api/status', { token })).json();
    assert.equal(status.owner, 'Sam');
    assert.equal(status.timezone, 'Europe/Berlin');
    assert.equal(status.githubConfigured, false);
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: 'long-enough-pw' }) });
    assert.equal(login.headers.get('location'), '/');
    const cookie = cookieOf(login);
    assert.equal((await call('/api/status', { cookie })).status, 200);
    assert.match(await (await fetch(base, { headers: { Cookie: cookie } })).text(), /id="tab-settings"/);

    let s = await (await call('/api/settings', { token })).json();
    assert.equal(s.github.connected, false);
    assert.match(s.github.tokenUrl, /^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?.*contents=read.*pull_requests=read/);
    assert.equal((await call('/api/settings', { method: 'PATCH', token, body: { timezone: 'Mars/Olympus' } })).status, 400);
    s = await (await call('/api/settings', { method: 'PATCH', token, body: { ownerName: 'Sam Lee', timezone: 'Asia/Tokyo' } })).json();
    assert.equal(s.ownerName, 'Sam Lee');
    assert.equal((await (await call('/api/status', { token })).json()).timezone, 'Asia/Tokyo');

    // GitHub: a wrong token is refused; the right one connects, syncs, and is never shown back.
    assert.match((await (await call('/api/settings/github', { method: 'POST', token, body: { token: 'wrong' } })).json()).error, /rejected/);
    s = await (await call('/api/settings/github', { method: 'POST', token, body: { token: 'ghtest' } })).json();
    assert.equal(s.github.connected, true);
    assert.equal(s.github.login, 'alexdev');
    assert.ok(!JSON.stringify(s).includes('ghtest') && !(await (await call('/api/status', { token })).text()).includes('ghtest'));
    assert.equal((await (await call('/api/sync', { method: 'POST', token })).json()).repos, 4);
    assert.equal((await (await call('/api/settings/github', { method: 'DELETE', token })).json()).github.connected, false);

    // New admin token: the old one stops working. New password: old sessions end.
    const { token: token2 } = await (await call('/api/settings/admin-token', { method: 'POST', token })).json();
    assert.equal((await call('/api/status', { token })).status, 401);
    assert.equal((await call('/api/status', { token: token2 })).status, 200);
    assert.equal((await call('/api/settings/password', { method: 'POST', token: token2, body: { current: 'wrong', password: 'new-password-1' } })).status, 400);
    assert.equal((await call('/api/settings/password', { method: 'POST', token: token2, body: { current: 'long-enough-pw', password: 'new-password-1' } })).status, 200);
    assert.equal((await call('/api/status', { cookie })).status, 401, 'old browser sessions are signed out');
  } finally { stop(); }
});

test('demo mode: a fictional person with entries from several apps, a handed-off task and GitHub-like activity', async () => {
  const { base, stop } = await freshHub(HUB_PORT - 3, { DEMO: '1' });
  try {
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.demo, true);
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: h.demoPassword }) });
    const cookie = cookieOf(login);
    const get = async (p) => (await fetch(`${base}/api${p}`, { headers: { Cookie: cookie } })).json();
    const entries = await get('/entries?limit=100');
    assert.ok(entries.length >= 8);
    assert.ok(new Set(entries.map((e) => e.createdBy?.slug)).size >= 4, 'added by several apps');
    const tasks = await get('/tasks?status=all');
    const handed = tasks.find((t) => t.status === 'done');
    assert.deepEqual(handed.chain, ['Claude Code', 'Codex', 'Cursor']);
    const types = new Set((await get('/activity?days=30')).map((r) => r.type));
    for (const t of ['Commits', 'PR merged', 'Context', 'Task']) assert.ok(types.has(t), t);
    assert.equal((await get('/status')).owner, 'Alex Rivera');
  } finally { stop(); }
});

test('hardening: odd repo names are refused, responses are nosniff, connection names are tidy', async () => {
  const r = await fetch(`${BASE}/api/context?repo=${encodeURIComponent('<script>alert(1)</script>')}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 400);
  assert.ok(!(await r.text()).includes('<script>'));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await api('/activity?repo=a%20b')).status, 400);
  assert.equal((await api('/activity?repo=notes-app')).status, 200);
  const { data } = await api('/apps', { method: 'POST', body: { preset: 'cursor', account: '--My  Laptop!!--' } });
  assert.equal(data.app.slug, 'cursor-my-laptop');
  await api(`/apps/${data.app.id}`, { method: 'DELETE' });
});
