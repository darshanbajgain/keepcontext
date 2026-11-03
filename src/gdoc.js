// Google Doc mirror: keeps a private Google Doc in sync with the agent bundle, so Gemini and other
// Drive-connected apps can read your context. Auth: a Google service account the Doc is shared with
// as Editor, either keyless (the VM runs as that account; tokens from the metadata server) or with a
// JSON key file (JWT signed with node:crypto). No googleapis dependency.
// Never writes private entries. Never logs the key or access tokens.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { changes, kvGet, kvSet, now } from './db.js';
import { mirrorModel } from './context.js';

const SCOPE = 'https://www.googleapis.com/auth/documents';
const state = { lastPushAt: kvGet('gdoc_last_push_at'), lastError: null };
let key = null;
let token = null;
let pushing = null;
let timer = null;

// 'key' when a key file exists, 'metadata' (Google Cloud VM, keyless) otherwise, null when the mirror is off.
const authMode = () => (!config.gdoc.docId ? null : fs.existsSync(config.gdoc.keyFile) ? 'key' : 'metadata');

function loadKey() {
  if (key) return key;
  if (authMode() !== 'key') return null;
  const k = JSON.parse(fs.readFileSync(config.gdoc.keyFile, 'utf8'));
  if (!k.client_email || !k.private_key) throw new Error('Service-account key file has no client_email or private_key');
  return (key = k);
}

export function gdocConfigured() {
  try { return authMode() === 'metadata' || !!loadKey(); } catch { return false; }
}

export const gdocStatus = () => ({
  configured: gdocConfigured(),
  auth: authMode(),
  lastPushAt: state.lastPushAt,
  lastError: state.lastError,
  docUrl: config.gdoc.docId ? `https://docs.google.com/document/d/${config.gdoc.docId}/edit` : null,
});

const b64url = (s) => Buffer.from(s).toString('base64url');

// Keyless: the VM's attached service account (needs the documents scope on the VM).
async function metadataToken() {
  let res;
  try {
    res = await fetch(`${config.gdoc.metadataUrl}/computeMetadata/v1/instance/service-accounts/default/token`, { headers: { 'Metadata-Flavor': 'Google' } });
  } catch {
    throw new Error('No key file, and the Google metadata server is not reachable (keyless mode only works on a Google Cloud VM)');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Metadata token request failed (${res.status})`);
  return j;
}

// Tokens are cached until a minute before expiry. Key mode uses the OAuth 2.0 JWT bearer flow.
async function accessToken() {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  if (authMode() === 'metadata') {
    const j = await metadataToken();
    token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return token.value;
  }
  const k = loadKey();
  const aud = config.gdoc.tokenUrl || k.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: k.client_email, scope: SCOPE, aud, iat, exp: iat + 3600 }))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), k.private_key).toString('base64url');
  const res = await fetch(aud, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed (${res.status}): ${j.error_description || j.error || 'no token'}`);
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

async function docsApi(method, suffix, body) {
  const res = await fetch(`${config.gdoc.docsApi}/v1/documents/${encodeURIComponent(config.gdoc.docId)}${suffix}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Docs ${res.status}: ${j.error?.message || 'request failed'}`);
  return j;
}

const PARA_STYLE = { title: 'TITLE', h1: 'HEADING_1', h2: 'HEADING_2', h3: 'HEADING_3' };
const MUTED = { color: { rgbColor: { red: 0.42, green: 0.42, blue: 0.4 } } };

/**
 * Turn mirrorModel() blocks into one text insert plus Docs formatting requests.
 * Indices are UTF-16 code units (same as JS string length); the Doc body starts at index 1.
 */
export function renderDoc({ blocks, stamp }) {
  let text = '';
  const paras = [];
  const runs = [];
  for (const b of blocks) {
    const start = text.length;
    for (const r of b.runs) {
      const s0 = text.length;
      text += String(r.text).replace(/\n/g, ' ');
      if (r.bold || r.italic || r.muted || r.link) runs.push({ ...r, s: s0, e: text.length });
    }
    text += '\n';
    paras.push({ t: b.t, start, end: text.length });
  }
  const R = (a0, b0) => ({ startIndex: a0 + 1, endIndex: b0 + 1 });
  const all = R(0, text.length);
  const requests = [
    { insertText: { location: { index: 1 }, text } },
    // Start from plain text, so styles left over from the old content don't leak in.
    { updateParagraphStyle: { range: all, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
    { deleteParagraphBullets: { range: all } },
    { updateTextStyle: { range: all, textStyle: {}, fields: 'bold,italic,link,foregroundColor' } },
  ];
  for (const p of paras) {
    if (PARA_STYLE[p.t]) requests.push({ updateParagraphStyle: { range: R(p.start, p.end), paragraphStyle: { namedStyleType: PARA_STYLE[p.t] }, fields: 'namedStyleType' } });
  }
  for (let i = 0; i < paras.length; i++) {
    if (paras[i].t !== 'li') continue;
    let j = i;
    while (j + 1 < paras.length && paras[j + 1].t === 'li') j++;
    requests.push({ createParagraphBullets: { range: R(paras[i].start, paras[j].end), bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    i = j;
  }
  for (const r of runs) {
    if (r.e <= r.s) continue;
    const textStyle = {};
    const fields = [];
    if (r.bold) { textStyle.bold = true; fields.push('bold'); }
    if (r.italic) { textStyle.italic = true; fields.push('italic'); }
    if (r.muted) { textStyle.foregroundColor = MUTED; fields.push('foregroundColor'); }
    if (r.link) { textStyle.link = { url: r.link }; fields.push('link'); }
    requests.push({ updateTextStyle: { range: R(r.s, r.e), textStyle, fields: fields.join(',') } });
  }
  // Change detection ignores the "Last updated" line.
  const hash = crypto.createHash('sha256').update(JSON.stringify(blocks.filter((_, i) => i !== stamp))).digest('hex');
  return { text, requests, hash };
}

/** Rewrite the Doc. Without force, skips the write when nothing but the timestamp changed. */
export function pushGdoc({ force = false } = {}) {
  if (!gdocConfigured()) return Promise.reject(new Error('Google Doc mirror is not configured: set GOOGLE_DOC_ID (plus a key file, or run on a Google Cloud VM as the service account).'));
  if (pushing) return pushing;
  pushing = (async () => {
    const { text, requests, hash } = renderDoc(mirrorModel());
    if (!force && hash === kvGet('gdoc_last_hash')) return { ok: true, skipped: true, lastPushAt: state.lastPushAt };
    const doc = await docsApi('GET', '?fields=body.content(endIndex)');
    const end = Math.max(1, ...(doc.body?.content || []).map((c) => c.endIndex || 0));
    // A Doc always keeps one final newline, so delete [1, end-1) first, then insert and format.
    const del = end > 2 ? [{ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } }] : [];
    await docsApi('POST', ':batchUpdate', { requests: [...del, ...requests] });
    state.lastPushAt = now();
    state.lastError = null;
    kvSet('gdoc_last_push_at', state.lastPushAt);
    kvSet('gdoc_last_hash', hash);
    return { ok: true, skipped: false, lastPushAt: state.lastPushAt, chars: text.length };
  })()
    .catch((e) => { state.lastError = e.message; throw e; })
    .finally(() => { pushing = null; });
  return pushing;
}

/** Push once shortly after start, then after every change (debounced). Returns false when not configured. */
export function startGdocMirror() {
  if (!gdocConfigured()) return false;
  const run = () => pushGdoc().then(
    (r) => { if (!r.skipped) console.log('gdoc mirror updated'); },
    (e) => console.error('gdoc mirror failed:', e.message),
  );
  changes.on('change', () => { clearTimeout(timer); timer = setTimeout(run, config.gdoc.debounceMs); });
  setTimeout(run, 5e3);
  return true;
}
