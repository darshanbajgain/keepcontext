// Public access: runs cloudflared so ChatGPT, Claude and Gemini on the web (which connect from their own servers)
// can reach this hub. Two modes:
//   quick       Cloudflare quick tunnel: free, no account; the https://….trycloudflare.com address changes on restart.
//   cloudflare  A named Cloudflare Tunnel (token from the Cloudflare dashboard): a fixed address on your own domain.
// The mode is stored in kv (Settings tab) or set with TUNNEL in .env, and the tunnel starts again with the server.
// While it runs, its address is the hub's public URL (connection links, connect.sh, repo files).
import { spawn, spawnSync } from 'node:child_process';
import { config } from './config.js';
import { kvGet, kvSet, db } from './db.js';

const env = process.env;
const BIN = env.CLOUDFLARED_BIN || 'cloudflared';
const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const MODES = ['off', 'quick', 'cloudflare'];
const BACKOFF = [5e3, 15e3, 60e3, 300e3];
// A new quick-tunnel name can take a minute or more to resolve (and a failed lookup is cached for a while),
// so the first check retries with growing gaps for about 5 minutes. TUNNEL_CHECK_TRIES shortens it (tests).
const CHECK_GAPS = [3, 5, 10, 15, 20, 30, 30, 45, 60, 60, 60].map((s) => s * 1e3);
const CHECK_TRIES = Number(env.TUNNEL_CHECK_TRIES || CHECK_GAPS.length + 1);

/** Which tunnel settings come from .env (locked in the UI). */
export const fromEnv = { mode: !!env.TUNNEL, token: !!env.CLOUDFLARE_TUNNEL_TOKEN, hostname: !!env.TUNNEL_HOSTNAME };

const state = { status: 'off', url: null, error: null, reachable: null, checkedAt: null, startedAt: null, checking: false };
let checkRun = 0;
let child = null;
let wanted = false;
let failures = 0;
let restartTimer = null;
let available = null;

const mode = () => (MODES.includes(env.TUNNEL) ? env.TUNNEL : kvGet('tunnel_mode', 'off') || 'off');
const token = () => env.CLOUDFLARE_TUNNEL_TOKEN || kvGet('tunnel_token', '') || '';
const hostname = () => env.TUNNEL_HOSTNAME || kvGet('tunnel_hostname', '') || '';

/** "keepcontext.example.com" (with or without https:// and a trailing slash) → "https://keepcontext.example.com". */
export function normalizeHostname(h) {
  // Plain string steps (no regex on the raw input, which could be long): cap, drop the scheme and trailing slashes.
  let host = String(h || '').trim().slice(0, 300).toLowerCase();
  for (const scheme of ['https://', 'http://']) if (host.startsWith(scheme)) host = host.slice(scheme.length);
  while (host.endsWith('/')) host = host.slice(0, -1);
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new Error('Enter the public hostname you set up in Cloudflare, e.g. keepcontext.example.com');
  }
  return `https://${host}`;
}

/** True if cloudflared can be run here (the Docker image includes it). Checked once. */
export function cloudflaredAvailable() {
  if (available === null) {
    const r = spawnSync(BIN, ['--version'], { stdio: 'ignore', timeout: 10e3 });
    available = !r.error && r.status === 0;
  }
  return available;
}

/** The tunnel's https address while it runs, else null. */
export const publicUrl = () => (state.status === 'running' && state.url ? state.url : null);

function setUrl(url) {
  if (state.url === url && state.status === 'running') return;
  state.url = url; state.status = 'running'; state.error = null; state.reachable = null; state.checkedAt = null;
  // A quick tunnel gets a new address on every start: remember the old one so the UI can say "update your web apps".
  const last = kvGet('tunnel_last_url', '');
  if (last && last !== url && mode() === 'quick') kvSet('tunnel_changed_from', last);
  kvSet('tunnel_last_url', url);
  check({ tries: CHECK_TRIES }).catch(() => {});
}

/** Fetch <url>/healthz from the internet side. New quick-tunnel addresses can take a few seconds to resolve. */
export async function check({ tries = 1 } = {}) {
  const run = ++checkRun; // a newer check (or a new address) takes over from this one
  state.checking = true;
  try {
    for (let i = 0; i < tries; i++) {
      const url = publicUrl();
      if (!url || run !== checkRun) return status();
      let ok = false;
      try { ok = (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8e3) })).ok; } catch {}
      if (run !== checkRun || url !== publicUrl()) return status();
      state.reachable = ok; state.checkedAt = new Date().toISOString();
      if (ok || i === tries - 1) break;
      await new Promise((r) => setTimeout(r, CHECK_GAPS[Math.min(i, CHECK_GAPS.length - 1)]).unref?.());
    }
  } finally { if (run === checkRun) state.checking = false; }
  return status();
}

function launch() {
  clearTimeout(restartTimer);
  const m = mode();
  if (m === 'off' || !wanted) return;
  if (!cloudflaredAvailable()) {
    Object.assign(state, { status: 'unavailable', url: null, error: "cloudflared isn't installed here. The Docker image includes it; without Docker, install cloudflared and restart KeepContext." });
    return;
  }
  let fixed = null;
  if (m === 'cloudflare') {
    try { fixed = normalizeHostname(hostname()); if (!token()) throw new Error('No Cloudflare tunnel token saved.'); }
    catch (e) { Object.assign(state, { status: 'error', url: null, error: `${e.message} Fix it in Settings → Public access.` }); return; }
  }
  const local = `http://127.0.0.1:${config.port}`;
  const args = m === 'quick' ? ['tunnel', '--no-autoupdate', '--url', local] : ['tunnel', '--no-autoupdate', 'run'];
  // The token goes in through the environment, never the command line (other users could read it in `ps`).
  const childEnv = { PATH: env.PATH, HOME: env.HOME || '/tmp', ...(m === 'cloudflare' ? { TUNNEL_TOKEN: token() } : {}) };
  Object.assign(state, { status: 'starting', url: null, error: null, reachable: null, startedAt: new Date().toISOString() });
  const p = spawn(BIN, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  child = p;
  const onLine = (line) => {
    if (child !== p) return;
    if (m === 'quick') { const u = line.match(QUICK_URL); if (u) setUrl(u[0]); }
    else if (/Registered tunnel connection/i.test(line)) setUrl(fixed);
    // Keep cloudflared's last complaint, so the UI can say why it stopped.
    if (/\b(ERR|error|failed|unable)\b/i.test(line) && state.status !== 'running') {
      state.error = line.replace(/^\d{4}-\d\d-\d\dT\S+\s+(ERR|WRN|INF)\s+/, '').trim().slice(0, 240);
    }
  };
  for (const s of [p.stdout, p.stderr]) {
    let buf = '';
    s.on('data', (d) => { buf += d; const lines = buf.split('\n'); buf = lines.pop(); lines.forEach(onLine); });
  }
  p.on('error', (e) => { if (child === p) Object.assign(state, { status: 'error', error: e.message }); });
  p.on('exit', (code) => {
    if (child !== p) return;
    child = null;
    if (!wanted) return;
    // Back off after repeated failures; a tunnel that ran a while starts over at the shortest wait.
    failures = Date.now() - Date.parse(state.startedAt) > 120e3 ? 0 : failures + 1;
    const wait = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
    const why = state.error ? `${state.error} ` : '';
    Object.assign(state, { status: 'error', url: null, reachable: null, error: `${why}(cloudflared stopped, exit ${code}; retrying in ${wait / 1e3} s)` });
    restartTimer = setTimeout(launch, wait);
    restartTimer.unref?.();
  });
}

/** Start (or restart) the tunnel for the stored mode; called at server start and after a settings change. */
export function start() {
  stop({ keepWanted: true });
  wanted = mode() !== 'off';
  failures = 0;
  launch();
  return status();
}

export function stop({ keepWanted = false } = {}) {
  if (!keepWanted) wanted = false;
  clearTimeout(restartTimer);
  checkRun++;
  const p = child; child = null;
  if (p) p.kill('SIGTERM');
  Object.assign(state, { status: 'off', url: null, error: null, reachable: null, checkedAt: null, startedAt: null, checking: false });
}

/** Settings tab: { mode, token?, hostname? }. An empty token keeps the saved one. */
export function configure({ mode: m, token: t, hostname: h } = {}) {
  if (fromEnv.mode) throw new Error('TUNNEL is set in .env; change it there.');
  if (!MODES.includes(m)) throw new Error('mode must be off, quick or cloudflare');
  if (m === 'cloudflare') {
    const host = fromEnv.hostname ? hostname() : normalizeHostname(h);
    const tok = String(t || '').trim();
    if (!tok && !token()) throw new Error('Paste the tunnel token from the Cloudflare dashboard.');
    if (tok && !/^[A-Za-z0-9+/=_-]{20,}$/.test(tok)) throw new Error("That doesn't look like a Cloudflare tunnel token (a long string starting with eyJ).");
    if (tok && !fromEnv.token) kvSet('tunnel_token', tok);
    if (!fromEnv.hostname) kvSet('tunnel_hostname', host.replace(/^https:\/\//, ''));
  }
  kvSet('tunnel_mode', m);
  if (m === 'off') { stop(); return status(); }
  return start();
}

/** The UI dismissed the "your address changed" notice. */
export function ackChange() { db.prepare("DELETE FROM kv WHERE key = 'tunnel_changed_from'").run(); return status(); }

/** For the UI and /api/status: never includes the token. */
export function status() {
  return {
    mode: mode(), status: state.status, url: state.url, reachable: state.reachable, checkedAt: state.checkedAt, checking: state.checking, error: state.error,
    hostname: hostname() || null, hasToken: !!token(), changedFrom: kvGet('tunnel_changed_from', '') || null,
    cloudflared: cloudflaredAvailable(), fromEnv,
  };
}

process.once('exit', () => { if (child) child.kill('SIGTERM'); });
