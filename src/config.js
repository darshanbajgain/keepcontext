// Central configuration, read once from environment variables.
// See .env.example for every option.
import fs from 'node:fs';
import path from 'node:path';

// Tiny .env loader (no dependency). Real env vars win over the file.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;

// The app version, from package.json (shown in /api/status, the UI footer and the MCP server info).
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const config = {
  version: pkg.version,
  port: Number(env.PORT || 8787),
  // Public base URL, used only to print copy-paste config snippets in the UI.
  publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 8787}`).replace(/\/$/, ''),
  // One secret that unlocks the API and the MCP endpoint. Required.
  hubToken: env.HUB_TOKEN || '',
  // Password for the web UI. Defaults to HUB_TOKEN.
  adminPassword: env.ADMIN_PASSWORD || env.HUB_TOKEN || '',
  dataDir: path.resolve(env.DATA_DIR || './data'),
  github: {
    token: env.GITHUB_TOKEN || '',
    owner: env.GITHUB_OWNER || '', // empty = the token's own account
    windowDays: Number(env.SYNC_WINDOW_DAYS || 60),
    includeForks: env.INCLUDE_FORKS === 'true',
  },
  // Timezone for activity-log dates (an IANA name, e.g. Europe/Berlin).
  timezone: env.TIMEZONE || 'UTC',
  // Auto-sync every N minutes (0 = off; use the Sync button or POST /api/sync).
  // AUTO_SYNC_MINUTES wins; AUTO_SYNC_HOURS is the older, coarser setting.
  autoSyncMinutes: Number(env.AUTO_SYNC_MINUTES || 0) || Number(env.AUTO_SYNC_HOURS || 0) * 60,
  // Your name, used in the context bundle and repo files ("Context for Alex"). Optional.
  ownerName: env.OWNER_NAME || '',
  // Which proxies to believe for the client IP (Express "trust proxy"). loopback = a proxy on this machine
  // (Tailscale Funnel, cloudflared, Caddy); clients can't fake their IP through it.
  trustProxy: env.TRUST_PROXY || 'loopback',
  // Rate limits (0 = off). Failed logins and wrong tokens per 15 minutes; requests per minute per app.
  rateLimit: {
    loginFailsPerIp: Number(env.LOGIN_MAX_FAILS ?? 10),
    loginFailsTotal: Number(env.LOGIN_MAX_FAILS_TOTAL ?? 50),
    badTokensPerIp: Number(env.BAD_TOKEN_MAX ?? 30),
    perMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 600),
  },
  // Google Doc mirror (off unless GOOGLE_DOC_ID is set). Auth: the key file if it exists, else keyless on a Google Cloud VM.
  gdoc: {
    docId: env.GOOGLE_DOC_ID || '',
    keyFile: path.resolve(env.GOOGLE_SA_KEY_FILE || './google-sa.json'),
    debounceMs: Number(env.GDOC_DEBOUNCE_SECONDS || 30) * 1000,
    // Overrides for tests (a fake Google); normally empty.
    tokenUrl: env.GOOGLE_TOKEN_URL || '',
    // On a Google Cloud VM with no key file, tokens come from the metadata server (keyless).
    metadataUrl: (env.GOOGLE_METADATA_URL || 'http://metadata.google.internal').replace(/\/$/, ''),
    docsApi: (env.GOOGLE_DOCS_API_URL || 'https://docs.googleapis.com').replace(/\/$/, ''),
  },
};

if (!config.hubToken || config.hubToken.length < 16) {
  console.error('HUB_TOKEN is missing or shorter than 16 characters. Set it in .env (see .env.example).');
  process.exit(1);
}
