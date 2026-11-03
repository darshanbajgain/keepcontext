const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Small Markdown renderer for the bundle and entry details: headings, lists, rules, `code`, **bold**, links.
   Everything is escaped first, so entry text and commit messages stay plain data. */
function mdInline(text) {
  return text.split(/(`[^`]*`)/).map((part) => {
    if (/^`[^`]*`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+)/g, (m, label, href, bare) => {
        let url = href || bare, tail = '';
        if (bare) { const t = url.match(/(&quot;|&#39;|[.,;:!?)])+$/); if (t) { tail = t[0]; url = url.slice(0, -tail.length); } }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>${tail}`;
      });
  }).join('');
}
function mdToHtml(md) {
  const out = [];
  let list = false, para = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(mdInline).join('<br>')}</p>`); para = []; };
  const closeList = () => { if (list) out.push('</li></ul>'); list = false; };
  for (const line of String(md).split('\n')) {
    let m;
    if (!line.trim()) { flushPara(); closeList(); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flushPara(); closeList(); const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${mdInline(m[2])}</h${n}>`); continue; }
    if (/^-{3,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) { flushPara(); out.push(list ? `</li><li>${mdInline(m[1])}` : `<ul><li>${mdInline(m[1])}`); list = true; continue; }
    if (list && /^\s+\S/.test(line)) { out.push(`<br><span class="muted">${mdInline(line.trim())}</span>`); continue; }
    closeList(); para.push(line);
  }
  flushPara(); closeList();
  return out.join('');
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  if (res.status === 401) { location.reload(); throw new Error('signed out'); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false; t.classList.toggle('bad', bad);
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4000);
}

/* ---------- small helpers ---------- */
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return day(iso);
}
// One colour per app; the label is the connection name (e.g. "ChatGPT · work"). Dashed = reported, not verified.
const PRESET_CLASS = { chatgpt: 'chatgpt', 'claude-web': 'claude', 'claude-code': 'claudecode', 'gemini-web': 'gemini',
  'gemini-cli': 'geminicli', antigravity: 'antigravity', codex: 'codex', cursor: 'cursor', copilot: 'copilot', web: 'web', 'shared-token': 'shared' };
function appBadge(a) {
  if (!a) return '';
  const cls = PRESET_CLASS[a.preset] || 'other';
  const title = a.verified ? 'Verified by its connection token' : 'Reported by the app, not verified by a token';
  return `<span class="src src-${cls}${a.verified ? '' : ' unverified'}" title="${title}">${esc(a.name)}</span>`;
}
const every = (m) => (!m ? '' : m >= 60 && m % 60 === 0 ? ` · every ${m / 60} h` : ` · every ${m} min`);
const kindPill = (k) => `<span class="pill k-${esc(k)}">${esc(k)}</span>`;
const lock = '<span class="pill private" title="Hidden from agents by default">🔒 private</span>';

/* ---------- tabs ---------- */
function show(tab) {
  if (!$(`#tab-${tab}`)) tab = 'overview';
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  try { localStorage.setItem('tab', tab); } catch {}
  window.scrollTo({ top: 0 });
  ({ overview: loadOverview, context: loadContext, tasks: loadTasks, activity: loadActivity, projects: loadProjects, connect: () => { loadApps(); loadConnect(); }, repo: () => {}, settings: loadSettings })[tab]?.();
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
document.addEventListener('click', (ev) => { const g = ev.target.closest('[data-goto]'); if (g) show(g.dataset.goto); });

/* ---------- status + sync ---------- */
let status = {};
async function loadStatus() {
  status = await api('/status');
  $('#owner').textContent = status.owner;
  $('#version').textContent = status.version ? `v${status.version}` : '';
  $('#tz').textContent = status.timezone;
  $('#lastSync').textContent = status.lastSyncAt ? `Last sync: ${ago(status.lastSyncAt)}` : 'Never synced';
  $('#lastSync').title = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '';
  // Demo mode has made-up GitHub activity but no GitHub connection.
  $('#lastSync').hidden = !(status.githubConfigured || status.demo);
  $('#syncBtn').hidden = !status.githubConfigured;
  $('#connectGh').hidden = status.githubConfigured || status.demo;
  showSyncErr(status.sync);
  showGdoc(status.gdoc);
  const repos = await api('/projects?all=1');
  $('#repoList').innerHTML = repos.map((r) => `<option value="${esc(r.name)}">`).join('');
}
// Header warning when the last sync failed or some repos had errors; click → Activity tab (sync runs).
function syncProblem(sync) {
  const run = sync?.lastRun;
  if (!run) return null;
  if (run.ok === false) return { text: 'Sync failed', detail: run.error };
  if (run.errors.length) return { text: `${run.errors.length} repo error${run.errors.length > 1 ? 's' : ''}`, detail: run.errors.join('\n') };
  return null;
}
function showSyncErr(sync) {
  const p = syncProblem(sync);
  $('#syncErr').hidden = !p;
  if (p) { $('#syncErr').textContent = `⚠ ${p.text}`; $('#syncErr').title = p.detail || ''; }
}
const currentTab = () => { try { return localStorage.getItem('tab') || 'overview'; } catch { return 'overview'; } };
$('#syncBtn').addEventListener('click', async () => {
  const b = $('#syncBtn'); b.disabled = true; b.textContent = 'Syncing…';
  try {
    const r = await api('/sync', { method: 'POST' });
    toast(`Synced ${r.repos} repos · ${r.reposChanged.length} changed · ${r.newCommits} new commits${r.errors.length ? ` · ${r.errors.length} errors` : ''}`, r.errors.length > 0);
    await loadStatus();
    show(currentTab());
  } catch (e) { toast(e.message, true); }
  b.disabled = false; b.textContent = 'Sync GitHub';
});

/* ---------- settings ---------- */
async function loadSettings() {
  const s = await api('/settings');
  const pf = $('#profileForm');
  pf.ownerName.value = s.ownerName || ''; pf.ownerName.disabled = s.fromEnv.ownerName;
  pf.timezone.value = s.timezone || ''; pf.timezone.disabled = s.fromEnv.timezone;
  $('#profileEnv').hidden = !(s.fromEnv.ownerName || s.fromEnv.timezone);
  $('#ghConnected').hidden = !s.github.connected;
  $('#ghForm').hidden = s.github.connected || s.fromEnv.githubToken;
  $('#ghLogin').textContent = s.github.login ? `@${s.github.login}` : 'your account';
  $('#ghDisconnect').hidden = s.fromEnv.githubToken;
  $('#ghEnv').hidden = !s.fromEnv.githubToken;
  $('#ghTokenLink').href = s.github.tokenUrl;
  $('#pwForm').hidden = s.fromEnv.password;
  $('#rotateAdmin').hidden = s.fromEnv.hubToken;
  $('#adminEnv').hidden = !s.fromEnv.hubToken;
}
const settingsAction = (fn) => async (ev) => {
  ev.preventDefault?.();
  try { await fn(ev); } catch (e) { toast(e.message, true); }
};
$('#profileForm').addEventListener('submit', settingsAction(async (ev) => {
  const f = ev.target;
  await api('/settings', { method: 'PATCH', body: { ownerName: f.ownerName.value, timezone: f.timezone.value } });
  toast('Saved'); await loadStatus();
}));
$('#ghForm').addEventListener('submit', settingsAction(async (ev) => {
  const s = await api('/settings/github', { method: 'POST', body: { token: ev.target.token.value } });
  ev.target.token.value = '';
  toast(`Connected as @${s.github.login}. Syncing…`);
  await loadSettings(); await loadStatus();
  $('#syncBtn').click();
}));
$('#ghSync').addEventListener('click', () => $('#syncBtn').click());
$('#ghDisconnect').addEventListener('click', settingsAction(async () => {
  if (!confirm('Disconnect GitHub? Synced repos and activity stay; new activity stops syncing. Delete the token on GitHub too.')) return;
  await api('/settings/github', { method: 'DELETE' });
  toast('GitHub disconnected'); await loadSettings(); await loadStatus();
}));
$('#pwForm').addEventListener('submit', settingsAction(async (ev) => {
  await api('/settings/password', { method: 'POST', body: { current: ev.target.current.value, password: ev.target.password.value } });
  location.reload();
}));
$('#rotateAdmin').addEventListener('click', settingsAction(async () => {
  if (!confirm('Make a new admin token? The old one stops working at once (scripts and apps using it need the new one).')) return;
  const { token } = await api('/settings/admin-token', { method: 'POST' });
  $('#adminToken').textContent = token; $('#adminTokenBox').hidden = false;
  toast('New admin token: shown once, copy it now');
}));

/* ---------- overview ---------- */
const ACTION = { added: 'added', updated: 'updated', done: 'marked done', reopened: 'reopened', archived: 'archived', pinned: 'pinned', unpinned: 'unpinned', deleted: 'deleted' };
async function loadOverview() {
  const o = await api('/overview');
  // First steps for a new hub; hidden once apps are connected and GitHub is connected (or skipped).
  let skipGh = false; try { skipGh = localStorage.getItem('skipGithub') === '1'; } catch {}
  const steps = [
    { done: o.apps.length > 0, html: 'Connect your AI apps: <button class="link" data-goto="connect">Apps tab →</button> (one connection per app and account)' },
    { done: status.githubConfigured || skipGh, html: 'Optional: connect GitHub for an activity log of your repos: <button class="link" data-goto="settings">Settings →</button> <button class="link muted" id="skipGh">skip</button>' },
    { done: o.apps.length > 0 && !!o.byApp.find((a) => a.slug !== 'web'), html: 'Ask any connected app to "save an idea to KeepContext", then see it here.' },
  ];
  $('#getStarted').hidden = status.demo || steps.every((s) => s.done);
  $('#gsSteps').innerHTML = steps.map((s) => `<li class="${s.done ? 'done' : ''}">${s.done ? '✓ ' : ''}${s.html}</li>`).join('');
  $('#skipGh')?.addEventListener('click', () => { try { localStorage.setItem('skipGithub', '1'); } catch {} loadOverview(); });
  const c = (k, s = 'open') => o.counts[k]?.[s] || 0;
  const tiles = [
    ['Open todos', c('todo'), 'todo'], ['Ideas', c('idea'), 'idea'], ['Notes', c('note'), 'note'],
    ['Decisions', c('decision'), 'decision'], ['Instructions', c('instruction'), 'instruction'], ['Profile facts', c('profile'), 'profile'],
  ];
  $('#stats').innerHTML = tiles.map(([label, n, k]) => `<button class="stat" data-kind="${k}"><span class="n">${n}</span><span class="l">${label}</span></button>`).join('');

  $('#ovPinned').innerHTML = o.pinned.length ? o.pinned.map((e) => `<div class="li">
      <div>${kindPill(e.kind)}${e.private ? lock : ''} <strong>${esc(e.title)}</strong></div>
      <div class="muted small">${e.tags.map((t) => `#${esc(t)}`).join(' ')} ${e.repo ? `· ${esc(e.repo)}` : ''}</div></div>`).join('')
    : '<p class="muted">Nothing pinned. Pin your most important todos and ideas.</p>';

  const g = status.gdoc || {};
  const rows = [
    ['GitHub sync', (o.lastSyncAt ? `${ago(o.lastSyncAt)}${every(status.autoSyncMinutes)}` : 'never')
      + (syncProblem(status.sync) ? ` · <button class="link bad" data-goto="activity">${esc(syncProblem(status.sync).text)}</button>` : '')],
    ['Google Doc mirror', g.configured ? (g.lastError ? `<span class="bad">error: ${esc(g.lastError)}</span>` : `updated ${g.lastPushAt ? ago(g.lastPushAt) : '—'} · <a href="${esc(g.docUrl)}" target="_blank" rel="noopener noreferrer">Open Doc</a>`) : 'off'],
    ['Public URL', `<code>${esc(status.publicUrl)}</code>`],
    ['Entries', `${o.counts ? Object.values(o.counts).reduce((a, x) => a + (x.open || 0) + (x.done || 0) + (x.archived || 0), 0) : 0} total`],
  ];
  $('#ovStatus').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const seen = new Set(o.byApp.map((a) => a.slug));
  const appRows = [
    ...o.byApp.map((a) => ({ a, line: `${a.changes} change${a.changes === 1 ? '' : 's'} · last ${ago(a.lastAt)}` })),
    ...o.apps.filter((c) => !seen.has(c.slug)).map((c) => ({ a: { slug: c.slug, name: c.name, preset: c.preset, verified: true },
      line: c.lastUsedAt ? `connected ${ago(c.lastUsedAt)}, no changes yet` : 'not used yet' })),
  ];
  $('#ovApps').innerHTML = appRows.length ? appRows.map(({ a, line }) => `<div class="li app-line"><span>${appBadge(a)}</span><span class="muted small">${line}</span></div>`).join('')
    : '<p class="muted">No apps yet. Add one in the Apps tab.</p>';

  $('#ovChanges').innerHTML = o.recentChanges.length ? o.recentChanges.map((ev) => `<div class="li">
      <div>${appBadge(ev.app) || '<span class="src src-other">unknown</span>'}${ev.reported ? ` <span class="muted small" title="What the app said it was">(said “${esc(ev.reported)}”)</span>` : ''} ${ACTION[ev.action] || esc(ev.action)} ${kindPill(ev.kind)}${ev.private ? lock : ''} <strong>${esc(ev.title)}</strong></div>
      <div class="muted small" title="${esc(new Date(ev.at).toLocaleString())}">${ago(ev.at)}</div></div>`).join('')
    : '<p class="muted">No changes yet. Save something from any app and it shows up here.</p>';

  $('#ovTasks').innerHTML = o.activeTasks.length ? o.activeTasks.map(taskLine).join('')
    : '<p class="muted">No open tasks. Ask a coding app to <code>start_task</code> for multi-step work, so another app can continue if it stops.</p>';

  $('#ovGithub').innerHTML = o.recentGithub.length ? o.recentGithub.map((r) => `<div class="li">
      <div><span class="pill">${esc(r.type)}</span> <strong>${esc(r.repo)}</strong></div>
      <div class="small">${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.summary)}</a>` : esc(r.summary)}</div>
      <div class="muted small">${esc(r.date)}</div></div>`).join('')
    : '<p class="muted">No GitHub activity yet. Press Sync GitHub.</p>';
}
$('#stats').addEventListener('click', (ev) => {
  const b = ev.target.closest('.stat'); if (!b) return;
  $('#kindFilter').value = b.dataset.kind; $('#statusFilter').value = 'open'; filters.tag = '';
  if (!$('#entryForm').elements.id.value) $('#entryForm').elements.kind.value = b.dataset.kind; // ready to add one of these
  show('context');
});

/* ---------- context ---------- */
const KINDS = ['idea', 'note', 'decision', 'todo', 'instruction', 'profile'];
$('#kindFilter').innerHTML += KINDS.map((k) => `<option>${k}</option>`).join('');
const filters = { tag: '' };
let allEntries = [];

async function loadContext() {
  const [entries, bundle] = await Promise.all([api('/entries?limit=500'), api('/context')]);
  allEntries = entries;
  $('#bundle').textContent = bundle;
  $('#bundlePreview').innerHTML = mdToHtml(bundle);
  const apps = new Map();
  for (const e of entries) for (const a of [e.createdBy, e.updatedBy]) if (a) apps.set(a.slug, a);
  const byPreset = {};
  for (const a of apps.values()) (byPreset[a.preset] ??= []).push(a);
  const cur = $('#sourceFilter').value;
  const opt = (v, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`;
  $('#sourceFilter').innerHTML = '<option value="">Any app</option>' + Object.entries(byPreset)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([preset, list]) => (list.length > 1 ? opt(`preset:${preset}`, `All ${list[0].name.split(' · ')[0]}`) : '')
      + list.sort((x, y) => x.name.localeCompare(y.name)).map((a) => opt(a.slug, a.name)).join('')).join('');
  renderEntries();
}

// Filtering happens in the browser: the full list is small and already loaded.
function renderEntries() {
  const q = $('#q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kind = $('#kindFilter').value, st = $('#statusFilter').value, src = $('#sourceFilter').value;
  const byApp = (e) => !src || [e.createdBy, e.updatedBy].some((a) => a && (src.startsWith('preset:') ? a.preset === src.slice(7) : a.slug === src));
  const base = allEntries.filter((e) => (!kind || e.kind === kind) && (!st || e.status === st) && byApp(e)
    && q.every((w) => `${e.title} ${e.body} ${e.tags.join(' ')} ${e.repo || ''}`.toLowerCase().includes(w)));
  const tagCounts = {};
  for (const e of base) for (const t of e.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const list = filters.tag ? base.filter((e) => e.tags.includes(filters.tag)) : base;
  $('#tagChips').innerHTML = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) =>
    `<button class="chip${filters.tag === t ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)} <span>${n}</span></button>`).join('')
    + (filters.tag && !tagCounts[filters.tag] ? `<button class="chip on" data-tag="${esc(filters.tag)}">#${esc(filters.tag)} ×</button>` : '');
  $('#entryCount').textContent = `${list.length} of ${allEntries.length}`;
  $('#listTitle').textContent = listTitle(kind, st, src ? $('#sourceFilter').selectedOptions[0]?.textContent : '', filters.tag);
  $('#clearFilters').hidden = !(q.length || kind || st !== 'open' || src || filters.tag);
  $('#entries').innerHTML = list.length ? list.map(entryCard).join('') : '<p class="muted">Nothing matches. Clear a filter, or add something above.</p>';
}

function entryCard(e) {
  const long = (e.body || '').length > 420 || (e.body || '').split('\n').length > 8;
  return `<article class="entry ${e.status !== 'open' ? 'dim' : ''}" data-id="${e.id}">
    <div class="meta">${kindPill(e.kind)}${e.pinned ? '<span class="pill pin">📌 pinned</span>' : ''}${e.private ? lock : ''}
      ${e.status !== 'open' ? `<span class="pill">${esc(e.status)}</span>` : ''}${e.repo ? `<span class="pill repo">${esc(e.repo)}</span>` : ''}
      ${e.tags.map((t) => `<button class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>
    <h3>${esc(e.title)}</h3>
    ${e.body ? `<div class="body md${long ? ' clamp' : ''}">${mdToHtml(e.body)}</div>${long ? '<button class="link more">Show more</button>' : ''}` : ''}
    <div class="foot">
      <span class="muted small">#${e.id} · added ${e.createdBy ? `via ${appBadge(e.createdBy)} ` : ''}${day(e.created_at)}${e.updated_at !== e.created_at ? ` · updated ${ago(e.updated_at)}${e.updatedBy && e.updatedBy.slug !== e.createdBy?.slug ? ` via ${appBadge(e.updatedBy)}` : ''}` : ''}</span>
      <span class="actions">
        <button class="ghost sm" data-act="edit">Edit</button>
        <button class="ghost sm" data-act="status">${e.status === 'open' ? 'Mark done' : 'Reopen'}</button>
        <button class="ghost sm" data-act="pin">${e.pinned ? 'Unpin' : 'Pin'}</button>
        <button class="ghost sm danger" data-act="delete">Delete</button>
      </span>
    </div>
  </article>`;
}

const KIND_LABEL = { idea: 'ideas', note: 'notes', decision: 'decisions', todo: 'todos', instruction: 'instructions', profile: 'profile facts' };
function listTitle(kind, st, src, tag) {
  const what = kind ? KIND_LABEL[kind] : 'entries';
  const t = `${{ open: 'Open ', done: 'Done ', archived: 'Archived ' }[st] || 'All '}${what}`;
  return t + (tag ? ` · #${tag}` : '') + (src ? ` · ${src}` : '');
}
$('#clearFilters').addEventListener('click', () => {
  $('#q').value = ''; $('#kindFilter').value = ''; $('#statusFilter').value = 'open'; $('#sourceFilter').value = ''; filters.tag = '';
  renderEntries();
});

let qTimer;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(renderEntries, 150); });
for (const id of ['#kindFilter', '#statusFilter', '#sourceFilter']) $(id).addEventListener('change', renderEntries);
$('#tagChips').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-tag]'); if (!b) return;
  filters.tag = filters.tag === b.dataset.tag ? '' : b.dataset.tag; renderEntries();
});

$('#entries').addEventListener('click', async (ev) => {
  const tag = ev.target.closest('.tag[data-tag]');
  if (tag) { filters.tag = tag.dataset.tag; renderEntries(); return; }
  const more = ev.target.closest('.more');
  if (more) { const body = more.previousElementSibling; body.classList.toggle('clamp'); more.textContent = body.classList.contains('clamp') ? 'Show more' : 'Show less'; return; }
  const btn = ev.target.closest('button[data-act]'); if (!btn) return;
  const id = Number(btn.closest('.entry').dataset.id);
  const e = allEntries.find((x) => x.id === id);
  const act = btn.dataset.act;
  try {
    if (act === 'edit') {
      const f = $('#entryForm'); const el = f.elements;
      for (const k of ['kind', 'repo', 'title', 'body', 'id']) el[k].value = e[k] ?? '';
      el.tags.value = e.tags.join(', '); el.pinned.checked = e.pinned; el.private.checked = e.private;
      $('#cancelEdit').hidden = false; f.querySelector('h2').textContent = `Edit #${id}`; f.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (act === 'delete') { if (!confirm('Delete this entry?')) return; await api(`/entries/${id}`, { method: 'DELETE' }); }
    if (act === 'status') await api(`/entries/${id}`, { method: 'PATCH', body: { status: e.status === 'open' ? 'done' : 'open' } });
    if (act === 'pin') await api(`/entries/${id}`, { method: 'PATCH', body: { pinned: !e.pinned } });
    loadContext();
  } catch (err) { toast(err.message, true); }
});

function resetForm() {
  const f = $('#entryForm'); f.reset(); f.elements.id.value = ''; $('#cancelEdit').hidden = true; f.querySelector('h2').textContent = 'Add to context';
}
$('#cancelEdit').addEventListener('click', resetForm);
$('#entryForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const body = { kind: f.kind.value, title: f.title.value, body: f.body.value, tags: f.tags.value, repo: f.repo.value || null, pinned: f.pinned.checked, private: f.private.checked };
  try {
    if (f.id.value) await api(`/entries/${f.id.value}`, { method: 'PATCH', body });
    else await api('/entries', { method: 'POST', body });
    toast('Saved'); resetForm(); loadContext();
  } catch (e) { toast(e.message, true); }
});

/* ---------- tasks (continue-anywhere handoffs) ---------- */
const REASON = { start: 'started', step: 'checkpoint', 'limit-warning': 'near limit', resumed: 'took over', finished: 'finished', abandoned: 'abandoned', reopened: 'reopened' };
const taskStatusPill = (t) => t.status === 'active' ? (t.stale ? '<span class="pill warnpill" title="No checkpoint for over 2 hours">idle</span>' : '<span class="pill k-decision">open</span>')
  : `<span class="pill">${esc(t.status)}</span>`;
// One task as a summary line (Overview and the Tasks list): title, apps so far, last checkpoint, next step.
function taskLine(t) {
  return `<div class="li">
    <div>${taskStatusPill(t)}${t.private ? lock : ''} <strong>#${t.id} ${esc(t.title)}</strong>${t.repo ? ` <span class="muted small">${esc(t.repo)} · <code>${esc(t.branch || '')}</code></span>` : ''}</div>
    <div class="small">${t.chain.map((n) => esc(n)).join(' → ')}${t.last ? ` · last: ${appBadge(t.last.app)} <span class="muted" title="${esc(new Date(t.last.at).toLocaleString())}">${ago(t.last.at)}</span> ${esc(t.last.summary)}` : ''}</div>
    ${t.next.length && t.status === 'active' ? `<div class="small muted">Next: ${esc(t.next[0])}</div>` : ''}</div>`;
}
const listItems = (label, xs) => xs.length ? `<div class="small"><span class="muted">${label}:</span> ${xs.map(esc).join(' · ')}</div>` : '';
async function loadTasks() {
  const tasks = await api(`/tasks?status=${$('#taskStatus').value}`);
  $('#taskList').innerHTML = tasks.length ? tasks.map((t) => `<details class="task" data-id="${t.id}">
      <summary>${taskLine(t)}</summary>
      <div class="task-body"><p class="muted small">Loading…</p></div></details>`).join('')
    : '<p class="muted">No tasks here yet.</p>';
}
async function openTask(el) {
  const t = await api(`/tasks/${el.dataset.id}`);
  const actions = t.status === 'active'
    ? '<button class="ghost sm" data-task-act="done">Mark done</button> <button class="ghost sm" data-task-act="abandoned">Abandon</button>'
    : '<button class="ghost sm" data-task-act="reopen">Reopen</button>';
  $('.task-body', el).innerHTML = `
    ${t.goal ? `<p><strong>Goal:</strong> ${esc(t.goal)}</p>` : ''}
    ${t.result ? `<p><strong>Result:</strong> ${esc(t.result)}</p>` : ''}
    <p class="small muted">Started by ${appBadge(t.createdBy) || '—'} ${ago(t.createdAt)}${t.owner ? ` · with ${appBadge(t.owner)} now` : ''}. Continue in any app: <code>resume_task ${t.id}</code></p>
    <ol class="timeline">${t.checkpoints.slice().reverse().map((c) => `<li class="${c.reason === 'resumed' ? 'handoff' : ''}">
      <div>${appBadge(c.app)} <span class="pill${c.reason === 'limit-warning' ? ' warnpill' : ''}">${REASON[c.reason] || esc(c.reason)}</span>
        <span class="muted small" title="${esc(new Date(c.at).toLocaleString())}">${ago(c.at)}</span>${c.commit ? ` <code class="small">${esc(c.commit.slice(0, 10))}</code>` : ''}</div>
      ${c.reason === 'resumed' ? '' : `<div>${esc(c.summary)}</div>`}
      ${listItems('Done', c.done)}${listItems('Next', c.next)}${listItems('Files', c.files)}${listItems('Decided', c.decisions)}${listItems('Questions', c.questions)}
    </li>`).join('')}</ol>
    <div class="row">${actions}</div>`;
}
$('#taskStatus').addEventListener('change', loadTasks);
$('#taskList').addEventListener('toggle', (ev) => { if (ev.target.open) openTask(ev.target).catch((e) => toast(e.message, true)); }, true);
$('#taskList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-task-act]'); if (!b) return;
  const el = b.closest('details.task'); const act = b.dataset.taskAct;
  try {
    if (act === 'reopen') await api(`/tasks/${el.dataset.id}/reopen`, { method: 'POST' });
    else {
      const summary = prompt(act === 'done' ? 'Result (what was built, where it is):' : 'Why abandon it?');
      if (summary === null) return;
      await api(`/tasks/${el.dataset.id}/finish`, { method: 'POST', body: { summary, status: act } });
    }
    toast('Saved'); loadTasks();
  } catch (e) { toast(e.message, true); }
});

/* ---------- activity ---------- */
let shownActivity = [];
// Context and Task rows come from the hub itself; the work log export tracks GitHub rows only.
const isHubRow = (r) => r.type === 'Context' || r.type === 'Task';
const logRows = () => shownActivity.filter((r) => !isHubRow(r));
async function loadActivity() {
  let rows = $('#onlyUnlogged').checked ? (await api('/activity/unlogged')).events : await api('/activity?days=60');
  if (!$('#showContext').checked) rows = rows.filter((r) => !isHubRow(r));
  shownActivity = rows;
  $('#activityTable tbody').innerHTML = rows.length ? rows.map((r) => `<tr class="${r.logged ? 'dim' : ''}${isHubRow(r) ? ' ctx' : ''}">
    <td class="nowrap">${r.date}</td><td class="nowrap">${esc(r.repo)}</td><td class="nowrap">${isHubRow(r) ? `<span class="pill k-context">${esc(r.type)}</span>` : esc(r.type)}</td>
    <td>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.summary)}</a>` : esc(r.summary)}</td>
    <td class="muted nowrap">${isHubRow(r) ? '' : r.logged ? 'in doc' : r.loggedBefore ? 'changed' : ''}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No activity yet. Press Sync GitHub.</td></tr>';
  loadSyncRuns();
}
async function loadSyncRuns() {
  const runs = await api(`/sync-runs?limit=20${$('#notableRuns').checked ? '&notable=1' : ''}`);
  const result = (r) => r.ok === null ? '<span class="muted">unfinished</span>'
    : !r.ok ? `<span class="bad">failed</span>` : r.errors.length ? '<span class="bad">partly</span>' : 'ok';
  $('#syncRunsTable tbody').innerHTML = runs.length ? runs.map((r) => `<tr>
    <td class="nowrap" title="${esc(new Date(r.startedAt).toLocaleString())}">${ago(r.startedAt)}${r.seconds != null ? ` <span class="muted small">${r.seconds}s</span>` : ''}</td>
    <td>${result(r)}</td><td>${r.repos}${r.reposChanged.length ? ` <span class="muted small">(${esc(r.reposChanged.join(', '))})</span>` : ''}</td>
    <td>${r.newCommits}</td><td>${r.prsTouched}</td>
    <td class="small">${[r.error, ...r.errors].filter(Boolean).map((e) => `<div class="bad">${esc(e)}</div>`).join('') || '—'}</td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">No runs with new commits or errors yet.</td></tr>';
}
$('#notableRuns').addEventListener('change', loadSyncRuns);
$('#onlyUnlogged').addEventListener('change', loadActivity);
$('#showContext').addEventListener('change', loadActivity);
$('#copyRows').addEventListener('click', async () => {
  const rows = logRows();
  const md = ['| Date | Repo | Type | Summary |', '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.date} | ${r.repo} | ${r.type} | ${r.summary.replace(/\|/g, '/')} |`)].join('\n');
  try { await navigator.clipboard.writeText(md); toast(`Copied ${rows.length} GitHub rows`); } catch { toast('Clipboard blocked by the browser', true); }
});
$('#csvRows').addEventListener('click', () => {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [['Date', 'Repo', 'Type', 'Summary', 'URL'], ...logRows().map((r) => [r.date, r.repo, r.type, r.summary, r.url || ''])]
    .map((row) => row.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `work-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#markLogged').addEventListener('click', async () => {
  const keys = logRows().filter((r) => !r.logged).map((r) => r.key);
  if (!keys.length) return toast('Nothing to mark');
  if (!confirm(`Mark ${keys.length} GitHub rows as already in your work log?`)) return;
  const r = await api('/activity/mark-logged', { method: 'POST', body: { keys } });
  toast(`Marked ${r.marked} rows`); loadActivity();
});

/* ---------- projects ---------- */
async function loadProjects() {
  const rows = await api('/projects?all=1');
  $('#projectsTable tbody').innerHTML = rows.length ? rows.map((r) => `<tr data-name="${esc(r.name)}" class="${r.hidden ? 'dim' : ''}">
    <td>${r.html_url ? `<a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.name)}</a>` : esc(r.name)}${r.description ? `<div class="muted small">${esc(r.description)}</div>` : ''}</td>
    <td><span class="pill">${r.private ? 'Private' : 'Public'}</span></td><td class="nowrap">${r.last_push || '—'}</td>
    <td><input class="inline" data-f="status" value="${esc(r.status || '')}" placeholder="—"></td>
    <td><input class="inline wide" data-f="use_for" value="${esc(r.use_for || '')}" placeholder="—"></td>
    <td><button class="ghost sm" data-act="hide">${r.hidden ? 'Show' : 'Hide'}</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="muted">No repos yet. Press Sync GitHub.</td></tr>';
}
$('#projectsTable').addEventListener('change', async (ev) => {
  const inp = ev.target.closest('input.inline'); if (!inp) return;
  const name = inp.closest('tr').dataset.name;
  try { await api(`/projects/${encodeURIComponent(name)}`, { method: 'PATCH', body: { [inp.dataset.f]: inp.value } }); toast('Saved'); } catch (e) { toast(e.message, true); }
});
$('#projectsTable').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-act=hide]'); if (!b) return;
  const tr = b.closest('tr');
  await api(`/projects/${encodeURIComponent(tr.dataset.name)}`, { method: 'PATCH', body: { hidden: !tr.classList.contains('dim') } });
  loadProjects();
});

/* ---------- connect snippets ---------- */
function loadConnect() {
  const url = `${status.publicUrl}/mcp`;
  const secret = `${status.publicUrl}/mcp/k/HUB_TOKEN`;
  const items = [
    ['Claude Code (terminal, VS Code, JetBrains)', 'Run once in a terminal:', `claude mcp add --transport http --scope user keepcontext ${url} \\\n  --header "Authorization: Bearer HUB_TOKEN"`],
    ['Claude app (claude.ai, desktop, mobile)', 'Settings → Connectors → Add custom connector → name KeepContext → paste the secret URL → No sign-in. (Or the /mcp URL plus a request header "Authorization: Bearer HUB_TOKEN", which also allows include_private.)', secret],
    ['ChatGPT', 'Plugins (left sidebar) → add your own plugin: paste the secret URL, no authentication. Then set the plugin to "Allow all tools" so saving doesn\'t ask every time. Works on the free plan.', secret],
    ['Gemini (web)', 'Customise → Connectors → + Custom → paste the secret URL → Next. Gemini can also read the Google Doc mirror (Gems → Knowledge).', secret],
    ['Cursor', '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a repo:', JSON.stringify({ mcpServers: { 'keepcontext': { url, headers: { Authorization: 'Bearer HUB_TOKEN' } } } }, null, 2)],
    ['Antigravity', 'Agent panel → … → MCP Servers → Manage → View raw config (the file is ~/.gemini/antigravity/mcp_config.json). The app does not read shell variables, so put the token itself in the header and keep the file private (chmod 600):', JSON.stringify({ mcpServers: { 'keepcontext': { serverUrl: url, headers: { Authorization: 'Bearer HUB_TOKEN' } } } }, null, 2)],
    ['Gemini CLI', '~/.gemini/settings.json ("${HUB_TOKEN}" is read from your shell). Gemini only enables MCP servers in trusted folders: answer "Trust folder" on first run, then check with gemini mcp list:', JSON.stringify({ mcpServers: { 'keepcontext': { httpUrl: url, headers: { Authorization: 'Bearer ${HUB_TOKEN}' } } } }, null, 2)],
    ['OpenAI Codex CLI', '~/.codex/config.toml (export HUB_TOKEN in your shell, then codex login; check with codex mcp list):', `[mcp_servers.keepcontext]\nurl = "${url}"\nbearer_token_env_var = "HUB_TOKEN"`],
    ['VS Code (Copilot agent mode)', '.vscode/mcp.json:', JSON.stringify({ servers: { 'keepcontext': { type: 'http', url, headers: { Authorization: 'Bearer ${input:hubToken}' } } }, inputs: [{ id: 'hubToken', type: 'promptString', description: 'KeepContext token', password: true }] }, null, 2)],
    ['Anything else (REST)', 'Plain HTTP, for scripts, n8n, Shortcuts, other agents:', `curl -H "Authorization: Bearer HUB_TOKEN" ${status.publicUrl}/api/context\ncurl -X POST -H "Authorization: Bearer HUB_TOKEN" -H "Content-Type: application/json" \\\n  -d '{"kind":"idea","title":"…","source":"shortcut"}' ${status.publicUrl}/api/entries`],
  ];
  $('#snippets').innerHTML = items.map(([t, how, code]) => `<div class="snippet"><h3>${esc(t)}</h3><p class="muted">${esc(how)}</p>
    <div class="code"><pre>${esc(code)}</pre><button class="ghost sm copy">Copy</button></div></div>`).join('');
}
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button.copy'); if (!b) return;
  try { await navigator.clipboard.writeText(b.previousElementSibling.textContent); toast('Copied'); } catch { toast('Clipboard blocked', true); }
});

/* ---------- apps: one connection (token) per app and account ---------- */
let presets = {};
async function loadApps() {
  const { apps, presets: p } = await api('/apps');
  presets = p;
  if (!$('#appPreset').options.length) {
    $('#appPreset').innerHTML = Object.entries(p).map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
    presetHint();
  }
  const groups = {};
  for (const a of apps) (groups[a.preset] ??= []).push(a);
  $('#appsList').innerHTML = apps.length ? Object.entries(groups).map(([preset, list]) => `<div class="app-group">
    <h3 class="sub">${esc(p[preset]?.label || preset)}</h3>
    ${list.map((a) => `<div class="app-row${a.revoked ? ' dim' : ''}" data-id="${a.id}">
      <div>${appBadge({ ...a, verified: true })} <span class="muted small">${esc(a.kind)} · token …${esc(a.tokenHint)}${a.canPrivate ? ' · private access' : ''}</span></div>
      <div class="muted small">${a.revoked ? `revoked ${day(a.revokedAt)}` : a.lastUsedAt ? `last used ${ago(a.lastUsedAt)}` : 'not used yet'} · ${a.changes} change${a.changes === 1 ? '' : 's'}</div>
      ${a.revoked ? '' : '<div class="actions"><button class="ghost sm" data-act="rotate">Rotate</button><button class="ghost sm danger" data-act="revoke">Revoke</button></div>'}
    </div>`).join('')}</div>`).join('')
    : '<p class="muted">No connections yet. Add one on the right for each app and account you use (ChatGPT · main, ChatGPT · work, Cursor, …).</p>';
}
function presetHint() {
  const p = presets[$('#appPreset').value];
  if (!p) return;
  const url = p.connect === 'secret-url';
  $('#appPrivateRow').hidden = url && $('#appPreset').value !== 'claude-web';
  $('#appPresetHint').textContent = url
    ? `${p.label} connects with a secret URL (no private entries${$('#appPreset').value === 'claude-web' ? ', unless you use the header option shown after creating' : ''}).`
    : `${p.label} connects with a header; you'll get a ready config and a one-line local setup command.`;
}
$('#appPreset').addEventListener('change', presetHint);

// Ready-to-paste setup for one connection. The token only exists in this browser view until "Done".
function setupFor(app, token) {
  const url = `${status.publicUrl}/mcp`, secret = `${url}/k/${token}`, header = `Bearer ${token}`;
  // Works from any terminal: the hub serves the helper; it asks for the token (hidden) and edits that app's config once.
  const local = (name) => `curl -fsSL ${status.publicUrl}/connect.sh | bash -s ${name}`;
  const S = {
    chatgpt: [['ChatGPT', 'Plugins (left sidebar) → add your own plugin. Name: KeepContext. URL: this. No authentication. Then set it to "Allow all tools".', secret]],
    'claude-web': [['Claude (web, desktop, mobile)', 'Settings → Connectors → Add custom connector → Name: KeepContext → URL: this → Authentication: No sign-in, no headers.', secret],
      ['Or, with private access', `URL ${url} plus request header "Authorization" with this value (needs "Allow private entries").`, header]],
    'gemini-web': [['Gemini', 'Customise → Connectors → + Custom → paste this URL → Next.', secret]],
    'claude-code': [['Claude Code', 'Run in a terminal (output hidden because it repeats the token):', `claude mcp add --transport http --scope user keepcontext ${url} --header "Authorization: ${header}" >/dev/null && echo added`],
      ['Or', 'Same thing with the helper (asks for the token, hidden):', local('claude-code')]],
    cursor: [['Cursor', 'Run in any terminal, then paste the token when asked (needs Node.js):', local('cursor')], ['Or ~/.cursor/mcp.json (keep it private: chmod 600)', '', JSON.stringify({ mcpServers: { 'keepcontext': { url, headers: { Authorization: header } } } }, null, 2)]],
    antigravity: [['Antigravity', 'Run in any terminal, then paste the token when asked (needs Node.js):', local('antigravity')], ['Or ~/.gemini/antigravity/mcp_config.json (chmod 600)', '', JSON.stringify({ mcpServers: { 'keepcontext': { serverUrl: url, headers: { Authorization: header } } } }, null, 2)]],
    'gemini-cli': [['Gemini CLI', 'Stores the token in ~/.config/keepcontext/env and points ~/.gemini/settings.json at it:', local('gemini-cli')]],
    codex: [['Codex CLI', 'Stores the token in ~/.config/keepcontext/env and points ~/.codex/config.toml at it:', local('codex')]],
    copilot: [['VS Code Copilot', 'Writes the token into your VS Code user mcp.json, then: Ctrl+Shift+P → MCP: List Servers → keepcontext → Restart:', local('copilot')]],
  }[app.preset] || [['Any MCP client', `URL ${url} with header Authorization:`, header]];
  return [...S, ['The token itself', 'Only if you need it elsewhere:', token]];
}
function showToken({ app, token }, rotated = false) {
  $('#tokenTitle').textContent = `${rotated ? 'New token for' : 'Connect'} ${app.name}`;
  $('#tokenSetup').innerHTML = setupFor(app, token).map(([t, how, code]) => `<div class="snippet"><h3>${esc(t)}</h3>${how ? `<p class="muted">${esc(how)}</p>` : ''}
    <div class="code"><pre>${esc(code)}</pre><button class="ghost sm copy">Copy</button></div></div>`).join('');
  $('#tokenCard').hidden = false;
  $('#tokenCard').scrollIntoView({ behavior: 'smooth' });
}
$('#tokenDone').addEventListener('click', () => { $('#tokenSetup').innerHTML = ''; $('#tokenCard').hidden = true; });
$('#appForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  try {
    const r = await api('/apps', { method: 'POST', body: { preset: f.preset.value, account: f.account.value, canPrivate: f.canPrivate.checked } });
    f.account.value = ''; f.canPrivate.checked = false;
    showToken(r); loadApps();
  } catch (e) { toast(e.message, true); }
});
$('#appsList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const id = b.closest('.app-row').dataset.id;
  try {
    if (b.dataset.act === 'rotate') {
      if (!confirm('Create a new token? The old one stops working immediately, so update that app right after.')) return;
      showToken(await api(`/apps/${id}/rotate`, { method: 'POST' }), true);
    }
    if (b.dataset.act === 'revoke') {
      if (!confirm('Revoke this connection? The app loses access immediately.')) return;
      await api(`/apps/${id}`, { method: 'DELETE' }); toast('Revoked');
    }
    loadApps();
  } catch (e) { toast(e.message, true); }
});

/* ---------- repo files ---------- */
$('#genFiles').addEventListener('click', async () => {
  const repo = $('#repoFor').value.trim();
  const files = await api(`/repo-files${repo ? `?repo=${encodeURIComponent(repo)}` : ''}`);
  $('#repoFiles').innerHTML = Object.entries(files).map(([name, content]) => `<div class="snippet"><h3><code>${esc(name)}</code></h3>
    <div class="code"><pre>${esc(content)}</pre><button class="ghost sm copy">Copy</button></div></div>`).join('');
});

/* ---------- Google Doc mirror ---------- */
function showGdoc(g) {
  $('#gdocRow').hidden = !g?.configured;
  if (!g?.configured) return;
  $('#gdocInfo').textContent = g.lastError ? `error: ${g.lastError}` : (g.lastPushAt ? `updated ${ago(g.lastPushAt)}` : 'not pushed yet');
  $('#gdocInfo').classList.toggle('bad', !!g.lastError);
  $('#gdocLink').href = g.docUrl;
}
$('#gdocPush').addEventListener('click', async () => {
  try {
    const r = await api('/gdoc/push', { method: 'POST' });
    toast(`Google Doc updated (${r.chars} characters)`);
  } catch (e) { toast(e.message, true); }
  try { status.gdoc = (await api('/status')).gdoc; showGdoc(status.gdoc); } catch {}
});

/* ---------- bundle view: Markdown preview or raw text ---------- */
function setBundleMode(mode) {
  $('#bundlePreview').hidden = mode === 'raw';
  $('#bundle').hidden = mode !== 'raw';
  $$('#bundleMode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  try { localStorage.setItem('bundleMode', mode); } catch {}
}
$$('#bundleMode button').forEach((b) => b.addEventListener('click', () => setBundleMode(b.dataset.mode)));
{ let mode = 'preview'; try { mode = localStorage.getItem('bundleMode') || mode; } catch {} setBundleMode(mode); }

/* ---------- boot ---------- */
(async () => {
  try { await loadStatus(); } catch (e) { toast(e.message, true); }
  show(currentTab());
})();
// Auto-sync runs in the background: refresh the header (last sync, errors) when you come back to the page.
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus().catch(() => {}); });
