// Write AGENTS.md / CLAUDE.md / GEMINI.md / .cursor/rules into a LOCAL repo clone.
// It never commits or pushes; review the files and commit them yourself.
//   HUB_URL=https://hub.example.com HUB_TOKEN=... node scripts/inject.mjs /path/to/repo [--repo name] [--force]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
const force = args.includes('--force');
const repoIdx = args.indexOf('--repo');
const repo = repoIdx >= 0 ? args[repoIdx + 1] : path.basename(dir);
const url = (process.env.HUB_URL || 'http://localhost:8787').replace(/\/$/, '');
const token = process.env.HUB_TOKEN;
if (!token) { console.error('Set HUB_TOKEN (and HUB_URL).'); process.exit(1); }
if (!fs.existsSync(dir)) { console.error(`No such folder: ${dir}`); process.exit(1); }

const res = await fetch(`${url}/api/repo-files?repo=${encodeURIComponent(repo)}`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) { console.error(`Hub answered ${res.status}: ${await res.text()}`); process.exit(1); }
const files = await res.json();

for (const [name, content] of Object.entries(files)) {
  const target = path.join(dir, name);
  if (fs.existsSync(target) && !force) {
    const cur = fs.readFileSync(target, 'utf8');
    if (cur.includes('keepcontext') || cur.trim() === content.trim()) {
      fs.writeFileSync(target, content);
      console.log(`updated  ${name}`);
    } else {
      // Don't clobber a hand-written file: append a pointer instead.
      const pointer = name === 'AGENTS.md'
        ? `\n\n<!-- keepcontext -->\n${content}`
        : (name.endsWith('.md') ? `\n\n@AGENTS.md\n` : null);
      if (pointer && !cur.includes('@AGENTS.md')) { fs.appendFileSync(target, pointer); console.log(`appended ${name}`); }
      else console.log(`skipped  ${name} (exists; use --force to overwrite)`);
    }
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`wrote    ${name}`);
}
console.log('\nReview with `git diff`, then commit when you are happy.');
