import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { db, kvGet } from './db.js';
import * as ctx from './context.js';
import { syncGithub } from './github.js';
import { buildMcpServer } from './mcp.js';
import { gdocStatus, pushGdoc, startGdocMirror } from './gdoc.js';
import { limiter } from './ratelimit.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '1mb' }));

/* ---------- auth ---------- */
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sessionValue = crypto.createHmac('sha256', config.adminPassword).update('ui-session:' + config.hubToken).digest('hex');
const getCookie = (req, name) => (req.headers.cookie || '').split(';').map((s) => s.trim().split('='))
  .find(([k]) => k === name)?.[1];

/**
 * Who is calling: { kind: 'admin' | 'app' | 'web', via, app, slug }.
 * - admin: the shared HUB_TOKEN (scripts, old configs). Recorded as "shared-token".
 * - app:   a connection token (one per app and account). Recorded as the connection's slug.
 * - web:   the browser session cookie. Recorded as "web".
 */
function callerForToken(token, via) {
  if (!token) return null;
  if (safeEq(token, config.hubToken)) return { kind: 'admin', via, app: null, slug: 'shared-token' };
  const app = ctx.findAppByToken(token);
  if (!app) return null;
  ctx.touchApp(app.id);
  return { kind: 'app', via, app, slug: app.slug };
}
function resolveCaller(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return callerForToken(h.slice(7).trim(), 'bearer');
  if (req.headers['x-hub-token']) return callerForToken(String(req.headers['x-hub-token']).trim(), 'x-hub-token');
  const c = getCookie(req, 'hub_session');
  return c && safeEq(c, sessionValue) ? { kind: 'web', via: 'cookie', app: null, slug: 'web' } : null;
}
const authed = (req) => !!resolveCaller(req);

/* ---------- rate limits (src/ratelimit.js) ---------- */
const RL = config.rateLimit;
const WINDOW = 15 * 60e3;
const loginFailsIp = limiter({ limit: RL.loginFailsPerIp, windowMs: WINDOW });
const loginFailsAll = limiter({ limit: RL.loginFailsTotal, windowMs: WINDOW });
const badTokens = limiter({ limit: RL.badTokensPerIp, windowMs: WINDOW });
const perCaller = limiter({ limit: RL.perMinute, windowMs: 60e3 });
const tooMany = (res, seconds) => res.status(429).set('Retry-After', String(seconds))
  .json({ error: `Too many requests. Try again in ${Math.ceil(seconds / 60)} min.` });
// A wrong token or cookie is counted per IP and answered 429 once over the limit. A valid token is never
// blocked by this (tokens are too long to guess), so a noisy client can't lock the real apps out.
function deny(req, res) {
  const s = badTokens.hit(req.ip);
  return s ? tooMany(res, s) : res.status(401).json({ error: 'unauthorized' });
}
// Then a generous per-app cap, keyed by the caller (not the IP), so one runaway agent can't flood the hub.
function admit(caller, req, res, next) {
  const s = perCaller.hit(caller.slug);
  if (s) return tooMany(res, s);
  res.locals.caller = caller;
  next();
}

const requireAuth = (req, res, next) => {
  const caller = resolveCaller(req);
  return caller ? admit(caller, req, res, next) : deny(req, res);
};
// Private entries over MCP/REST: the web UI, or the Authorization header with the shared token or a connection
// allowed to see them. Never the secret URL, x-hub-token or cookie on /mcp.
const canSeePrivate = (caller) => caller.kind === 'web'
  || (caller.via === 'bearer' && (caller.kind === 'admin' || !!caller.app?.canPrivate));

app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
  // Failed logins: blocked per IP, and for everyone after many failures in total (guessing from many IPs).
  // Checked before the password, so a guess while blocked tells nothing. Signed-in browsers are unaffected.
  if (loginFailsIp.blocked(req.ip) || loginFailsAll.blocked('all')) return res.redirect(303, '/?error=locked');
  const pw = req.body?.password || '';
  if (!safeEq(pw, config.adminPassword)) {
    loginFailsIp.hit(req.ip);
    loginFailsAll.hit('all');
    await new Promise((r) => setTimeout(r, 800));
    return res.redirect('/?error=1');
  }
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `hub_session=${sessionValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.redirect('/');
});
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'hub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.redirect('/');
});

/* ---------- MCP (Streamable HTTP, stateless) ---------- */
async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }
  const server = buildMcpServer({ allowPrivate: !!res.locals.allowPrivate, caller: res.locals.caller });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('MCP error', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}
app.use('/mcp', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
  res.set('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Header auth: Authorization: Bearer <HUB_TOKEN> (Claude Code, Cursor, Antigravity, Gemini CLI, Codex...)
app.all('/mcp', requireAuth, (req, res, next) => {
  const c = res.locals.caller;
  res.locals.allowPrivate = c.kind !== 'web' && canSeePrivate(c);
  next();
}, handleMcp);
// Secret-URL auth for apps that only take a URL (ChatGPT "No authentication", claude.ai custom connectors).
// Accepts the shared token or a connection token; never unlocks private entries.
app.all('/mcp/k/:token', (req, res, next) => {
  const caller = callerForToken(req.params.token, 'url');
  if (!caller) return deny(req, res);
  res.locals.allowPrivate = false;
  admit(caller, req, res, next);
}, handleMcp);

/* ---------- REST API ---------- */
const api = express.Router();
api.use(requireAuth);
// Connection tokens may only read the bundle and read/add/edit entries (quick capture); everything else is admin.
api.use((req, res, next) => {
  if (res.locals.caller.kind !== 'app') return next();
  const p = req.path;
  const ok = (req.method === 'GET' && (p === '/context' || p === '/entries'))
    || (req.method === 'POST' && p === '/entries')
    || (req.method === 'PATCH' && /^\/entries\/\d+$/.test(p));
  return ok ? next() : res.status(403).json({ error: 'This connection token can only use /api/context and /api/entries' });
});
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(400).json({ error: e.message }); }
};

api.get('/status', wrap(() => ({
  owner: config.ownerName,
  version: config.version,
  githubOwner: kvGet('github_owner'),
  githubConfigured: !!config.github.token,
  lastSyncAt: kvGet('last_sync_at'),
  timezone: config.timezone,
  publicUrl: config.publicUrl,
  autoSyncMinutes: config.autoSyncMinutes,
  gdoc: gdocStatus(),
  counts: {
    repos: db.prepare('SELECT count(*) n FROM repos').get().n,
    commits: db.prepare('SELECT count(*) n FROM commits').get().n,
    prs: db.prepare('SELECT count(*) n FROM prs').get().n,
    entries: db.prepare('SELECT count(*) n FROM entries').get().n,
  },
  sync: ctx.syncHealth(),
})));
api.get('/sync-runs', wrap((req) => ctx.syncRuns({ limit: req.query.limit, notable: req.query.notable === '1' })));
api.post('/sync', wrap(() => syncGithub()));
api.post('/gdoc/push', wrap(() => pushGdoc({ force: true })));
api.get('/activity', wrap((req) => ctx.activity({ days: Number(req.query.days) || 60, repo: req.query.repo || null })));
api.get('/activity/unlogged', wrap((req) => ctx.workLogRows({ days: Number(req.query.days) || 60 })));
api.post('/activity/mark-logged', wrap((req) => ({ marked: ctx.markLogged(req.body?.keys || []) })));
api.get('/projects', wrap((req) => ctx.projects({ includeHidden: req.query.all === '1' })));
api.patch('/projects/:name', wrap((req) => ctx.updateProject(req.params.name, req.body || {})));
// The web UI sees everything, private entries included (shown with a lock); connections only if allowed.
api.get('/entries', wrap((req, res) => ctx.listEntries({ ...req.query, includePrivate: canSeePrivate(res.locals.caller) })));
api.post('/entries', wrap((req, res) => {
  const c = res.locals.caller;
  return ctx.createEntry({ ...req.body, source: req.body?.source || c.slug, app: c.slug, private: req.body?.private });
}));
api.patch('/entries/:id', wrap((req, res) => ctx.updateEntry(Number(req.params.id), req.body || {},
  { includePrivate: canSeePrivate(res.locals.caller), by: res.locals.caller.slug })));
api.delete('/entries/:id', wrap((req, res) => ({ deleted: ctx.deleteEntry(Number(req.params.id), { by: res.locals.caller.slug }) })));
// Connections (one token per app and account). The token is only in the create/rotate response.
api.get('/apps', wrap(() => ({ apps: ctx.listApps(), presets: ctx.APP_PRESETS })));
api.post('/apps', wrap((req) => ctx.createApp(req.body || {})));
api.post('/apps/:id/rotate', wrap((req) => ctx.rotateApp(Number(req.params.id))));
api.delete('/apps/:id', wrap((req) => ctx.revokeApp(Number(req.params.id))));
api.get('/overview', wrap(() => ctx.overview()));
// Continue-anywhere tasks (the web UI sees private ones too). Admin and web only, like every route outside /entries.
const taskViewer = (res) => ({ app: res.locals.caller.slug, includePrivate: canSeePrivate(res.locals.caller) });
api.get('/tasks', wrap((req, res) => ctx.listTasks({ status: req.query.status || 'active', repo: req.query.repo || null, limit: req.query.limit }, taskViewer(res))));
api.get('/tasks/:id', wrap((req, res) => ctx.getTask(Number(req.params.id), taskViewer(res))));
api.post('/tasks/:id/finish', wrap((req, res) => ctx.finishTask(Number(req.params.id), req.body || {}, taskViewer(res))));
api.post('/tasks/:id/reopen', wrap((req, res) => ctx.reopenTask(Number(req.params.id), taskViewer(res))));
api.get('/context', (req, res) => {
  res.type('text/markdown').send(ctx.contextBundle({ repo: req.query.repo || null }));
});
api.get('/repo-files', wrap((req) => ctx.repoContextFiles({ repo: req.query.repo || null })));
api.get('/export', wrap(() => ({
  exportedAt: new Date().toISOString(),
  entries: db.prepare('SELECT * FROM entries WHERE private = 0').all(), // private entries never leave via export
  repos: db.prepare('SELECT * FROM repos').all(),
})));
app.use('/api', api);

/* ---------- web UI ---------- */
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
app.get('/healthz', (req, res) => res.json({ ok: true }));
// Public helper script (no secrets): curl -fsSL <hub>/connect.sh | bash -s <app>
app.get('/connect.sh', (req, res) => res.type('text/x-shellscript').set('Cache-Control', 'no-store').send(ctx.connectScript()));
app.get('/', (req, res) => res.sendFile(path.join(pub, authed(req) ? 'index.html' : 'login.html')));
app.use(express.static(pub, { index: false }));

app.listen(config.port, () => {
  console.log(`KeepContext on ${config.publicUrl}  (MCP: ${config.publicUrl}/mcp)`);
  if (startGdocMirror()) console.log('Google Doc mirror on');
});

if (config.autoSyncMinutes > 0 && config.github.token) {
  // Idle runs cost ~2 GitHub calls, so a few minutes is fine. Only log when something happened.
  const run = () => syncGithub().then((r) => {
    if (r.reposChanged.length) console.log('auto-sync', { changed: r.reposChanged, newCommits: r.newCommits, prs: r.prsTouched });
    if (r.errors.length) console.error('auto-sync errors', r.errors);
  }, (e) => console.error('auto-sync failed', e.message));
  setTimeout(run, 10e3);
  setInterval(run, Math.max(1, config.autoSyncMinutes) * 60e3);
}
