// Fake Google OAuth token endpoint + Docs API, for testing the Google Doc mirror.
// Verifies the service-account JWT signature with the key in GOOGLE_SA_KEY_FILE, serves a fake VM metadata
// token endpoint (keyless mode), and keeps the Doc text in memory.
// Run: MOCK_GOOGLE_PORT=19912 GOOGLE_SA_KEY_FILE=... node test/mock-google.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';

const sa = JSON.parse(fs.readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
const publicKey = crypto.createPublicKey(sa.private_key);
const ACCESS = 'gtest-access';
let text = '';     // Doc body without the final newline Google always keeps
let writes = 0;
let styles = {};  // counts of formatting requests in the last batchUpdate

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.post('/token', (req, res) => {
  const [h, p, s] = String(req.body.assertion || '').split('.');
  const ok = h && p && s && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url'));
  const claims = ok ? JSON.parse(Buffer.from(p, 'base64url').toString()) : {};
  if (!ok || claims.iss !== sa.client_email || !String(claims.scope).includes('documents')) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'bad assertion' });
  }
  res.json({ access_token: ACCESS, expires_in: 3600, token_type: 'Bearer' });
});

app.get('/_doc', (req, res) => res.json({ text, writes, styles }));

// Keyless mode: the Google Cloud VM metadata server.
app.get('/computeMetadata/v1/instance/service-accounts/default/token', (req, res) => {
  if (req.headers['metadata-flavor'] !== 'Google') return res.status(403).send('Missing Metadata-Flavor header');
  res.json({ access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' });
});

// Docs API: GET /v1/documents/:id and POST /v1/documents/:id:batchUpdate
app.use('/v1/documents', (req, res) => {
  if (req.headers.authorization !== `Bearer ${ACCESS}`) return res.status(401).json({ error: { message: 'unauthenticated' } });
  if (req.method === 'GET') return res.json({ body: { content: [{ endIndex: 1 }, { endIndex: text.length + 2 }] } });
  if (req.method === 'POST' && req.path.endsWith(':batchUpdate')) {
    styles = {};
    for (const r of req.body.requests || []) {
      const [type, body] = Object.entries(r)[0];
      // Like Google: formatting ranges must fall inside the document.
      if (body.range && (body.range.startIndex < 1 || body.range.endIndex > text.length + 2 || body.range.endIndex <= body.range.startIndex)) {
        return res.status(400).json({ error: { message: `Invalid range in ${type}` } });
      }
      const named = body.paragraphStyle?.namedStyleType;
      const key = named && named !== 'NORMAL_TEXT' ? named : type;
      styles[key] = (styles[key] || 0) + 1;
      if (r.deleteContentRange) {
        const { startIndex, endIndex } = r.deleteContentRange.range;
        text = text.slice(0, startIndex - 1) + text.slice(endIndex - 1);
      } else if (r.insertText) {
        const i = r.insertText.location.index - 1;
        text = text.slice(0, i) + r.insertText.text + text.slice(i);
      }
    }
    writes++;
    return res.json({ replies: [] });
  }
  res.status(404).json({ error: { message: 'not found' } });
});

const port = Number(process.env.MOCK_GOOGLE_PORT || 9912);
app.listen(port, () => console.log(`mock Google on ${port}`));
