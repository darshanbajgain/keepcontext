// Settings made in the web UI (first-run setup, Settings tab), stored in the database's kv table.
// .env always wins: a value set there is used as is and can't be changed in the UI.
// On load, stored values fill in `config` wherever .env left them empty, so the rest of the code reads `config`.
import crypto from 'node:crypto';
import { config } from './config.js';
import { kvGet, kvSet, db } from './db.js';

const env = process.env;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
/** Which settings come from .env (locked in the UI). */
export const fromEnv = {
  hubToken: !!env.HUB_TOKEN,
  password: !!(env.ADMIN_PASSWORD || env.HUB_TOKEN),
  ownerName: !!env.OWNER_NAME,
  timezone: !!env.TIMEZONE,
  githubToken: !!env.GITHUB_TOKEN,
  githubOwner: !!env.GITHUB_OWNER,
};

function applyStored() {
  if (!fromEnv.ownerName) config.ownerName = kvGet('owner_name', '') || '';
  if (!fromEnv.timezone) config.timezone = kvGet('timezone', '') || 'UTC';
  if (!fromEnv.githubToken) config.github.token = kvGet('github_token', '') || '';
  if (!fromEnv.githubOwner) config.github.owner = kvGet('github_login', '') || '';
}
applyStored();

/* ---------- admin credentials ---------- */

/** True until the first-run setup is done (no HUB_TOKEN in .env and none stored). */
export const setupNeeded = () => !fromEnv.hubToken && !kvGet('admin_token_sha256');

// A one-time code printed in the server log, so only someone who can see the server can finish setup.
let setupCode = null;
export function setupCodeForLog() {
  if (!setupNeeded()) return null;
  setupCode ??= env.SETUP_CODE || crypto.randomBytes(4).toString('hex').toUpperCase();
  return setupCode;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  return !!salt && safeEq(crypto.scryptSync(String(pw), salt, 32).toString('hex'), hash);
}
const newAdminToken = () => crypto.randomBytes(32).toString('hex');

export function isAdminToken(token) {
  if (!token) return false;
  if (fromEnv.hubToken) return safeEq(token, config.hubToken);
  const stored = kvGet('admin_token_sha256');
  return !!stored && safeEq(sha256(token), stored);
}
export function isAdminPassword(pw) {
  if (fromEnv.password) return safeEq(pw, config.adminPassword);
  const stored = kvGet('admin_password');
  return !!stored && verifyPassword(pw, stored);
}
/** The browser session cookie value. Changing the password (or HUB_TOKEN) signs every browser out. */
export function sessionValue() {
  if (fromEnv.hubToken) return crypto.createHmac('sha256', config.adminPassword).update('ui-session:' + config.hubToken).digest('hex');
  let secret = kvGet('session_secret');
  if (!secret) { secret = crypto.randomBytes(32).toString('hex'); kvSet('session_secret', secret); }
  return crypto.createHmac('sha256', secret).update('ui-session:' + (kvGet('admin_password') || '')).digest('hex');
}

/** First-run setup. Returns the admin token, shown once. */
export function completeSetup({ code, password, ownerName = '', timezone = '' } = {}) {
  if (!setupNeeded()) throw new Error('Setup is already done.');
  if (!setupCode || !safeEq(String(code || '').trim().toUpperCase(), setupCode)) throw new Error('Wrong setup code. It is printed in the server log.');
  if (String(password || '').length < 8) throw new Error('Choose a password of at least 8 characters.');
  const token = newAdminToken();
  db.exec('BEGIN');
  try {
    kvSet('admin_password', hashPassword(password));
    kvSet('admin_token_sha256', sha256(token));
    kvSet('session_secret', crypto.randomBytes(32).toString('hex'));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  setupCode = null;
  updateSettings({ ownerName, timezone });
  return { token };
}

/** A new admin token (the old one stops working at once). Not available when HUB_TOKEN is in .env. */
export function rotateAdminToken() {
  if (fromEnv.hubToken) throw new Error('HUB_TOKEN is set in .env; change it there.');
  const token = newAdminToken();
  kvSet('admin_token_sha256', sha256(token));
  return { token };
}

export function changePassword({ current, password } = {}) {
  if (fromEnv.password) throw new Error('The password is set in .env (ADMIN_PASSWORD); change it there.');
  if (!isAdminPassword(current || '')) throw new Error('The current password is wrong.');
  if (String(password || '').length < 8) throw new Error('Choose a password of at least 8 characters.');
  kvSet('admin_password', hashPassword(password));
  return { ok: true };
}

/* ---------- profile and GitHub ---------- */

const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };

export function updateSettings({ ownerName, timezone } = {}) {
  if (ownerName !== undefined && !fromEnv.ownerName) kvSet('owner_name', String(ownerName).trim().slice(0, 80));
  if (timezone !== undefined && timezone !== '' && !fromEnv.timezone) {
    if (!validTimezone(timezone)) throw new Error(`Unknown timezone: ${timezone}`);
    kvSet('timezone', timezone);
  }
  applyStored();
  return publicSettings();
}

/** Check a GitHub token (read-only fine-grained token) and store it. Returns the account it belongs to. */
export async function connectGithub(token) {
  if (fromEnv.githubToken) throw new Error('GITHUB_TOKEN is set in .env; change it there.');
  token = String(token || '').trim();
  if (!token) throw new Error('Paste the token GitHub showed you.');
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const res = await fetch(`${api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'keepcontext' } });
  if (!res.ok) throw new Error(`GitHub rejected this token (HTTP ${res.status}). Create a new one and paste it right away.`);
  const { login } = await res.json();
  kvSet('github_token', token);
  kvSet('github_login', login || '');
  applyStored();
  return publicSettings();
}
export function disconnectGithub() {
  if (fromEnv.githubToken) throw new Error('GITHUB_TOKEN is set in .env; remove it there.');
  db.prepare("DELETE FROM kv WHERE key IN ('github_token', 'github_login')").run();
  applyStored();
  return publicSettings();
}

/** Link to GitHub's token page with a read-only token pre-filled (GitHub can't pre-select "All repositories"). */
export const githubTokenUrl = () => 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'KeepContext', description: 'Read-only: lets KeepContext list your repos, commits and pull requests.',
  expires_in: '366', contents: 'read', pull_requests: 'read', metadata: 'read',
});

/** For the UI: never includes a secret. */
export function publicSettings() {
  return {
    ownerName: config.ownerName, timezone: config.timezone,
    github: { connected: !!config.github.token, login: config.github.owner || kvGet('github_owner') || null, tokenUrl: githubTokenUrl() },
    fromEnv,
  };
}
