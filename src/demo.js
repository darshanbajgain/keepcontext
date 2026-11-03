// Demo mode (DEMO=1): fills an empty hub with a fictional developer, for trying KeepContext and for screenshots.
// Sign in with DEMO_PASSWORD. Nothing here talks to GitHub or any AI app; all data is made up.
import { db, kvSet } from './db.js';
import * as ctx from './context.js';
import * as S from './settings.js';

export const DEMO_PASSWORD = 'demo-keepcontext';
const iso = (days, hours = 0) => new Date(Date.now() - days * 864e5 - hours * 3600e3).toISOString();

export function seedDemo() {
  if (S.setupNeeded()) {
    S.completeSetup({ code: S.setupCodeForLog(), password: DEMO_PASSWORD, ownerName: 'Alex Rivera', timezone: 'Europe/Berlin' });
  }
  if (db.prepare('SELECT count(*) n FROM entries').get().n > 0) return false;

  // Fictional repos first, so tasks for them count as synced (public) repos.
  const repos = [
    ['recall-notes', 'Notes app with tags, search and sharing', 0],
    ['trailmap', 'Hiking route planner (PWA)', 0],
    ['weather-cli', 'Weather in your terminal', 0],
    ['dotfiles', 'My shell and editor setup', 1],
  ];
  const insRepo = db.prepare(`INSERT OR IGNORE INTO repos(name, full_name, private, html_url, description, default_branch, pushed_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  repos.forEach(([name, desc, priv], i) => insRepo.run(name, `alexrivera/${name}`, priv, `https://github.com/alexrivera/${name}`, desc, 'main', iso(i), iso(0)));

  // Connections (their tokens are thrown away: nobody can use them).
  const conn = (preset, account = '') => ctx.createApp({ preset, account }).app.slug;
  const chatgpt = conn('chatgpt', 'personal');
  const claude = conn('claude-web');
  const code = conn('claude-code');
  const codex = conn('codex');
  const cursor = conn('cursor');

  // Entries, each added by some app, spread over the last two weeks.
  const add = (app, days, e) => {
    const r = ctx.createEntry({ ...e, app, source: app });
    const at = iso(days, Math.random() * 8);
    db.prepare('UPDATE entries SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, r.id);
    db.prepare('UPDATE entry_events SET at = ? WHERE entry_id = ?').run(at, r.id);
    return r;
  };
  add('web', 14, { kind: 'profile', title: 'Full-stack developer (TypeScript, Node, Postgres), Berlin', body: 'Building Recall Notes on the side; looking for a remote senior role in 2027.' });
  add('web', 14, { kind: 'instruction', title: 'Keep answers short and practical', body: 'Code first, then two or three lines of why. No filler.' });
  add('web', 13, { kind: 'instruction', title: 'Explain decisions so I can defend them in interviews' });
  add(chatgpt, 12, { kind: 'idea', title: 'Recall Notes: weekly digest email of notes you starred', tags: 'recall-notes, growth', repo: 'recall-notes' });
  add(claude, 10, { kind: 'decision', title: 'Use Postgres full-text search before adding a vector DB', body: 'Good enough for 100k notes; revisit if search quality complaints show up.', tags: 'recall-notes, search', repo: 'recall-notes', pinned: true });
  add(cursor, 8, { kind: 'todo', title: 'Add rate limiting to the public share links', tags: 'security', repo: 'recall-notes' });
  add(codex, 6, { kind: 'note', title: 'weather-cli: OpenWeather free tier allows 60 calls/min', repo: 'weather-cli' });
  add(chatgpt, 4, { kind: 'idea', title: 'Talk idea: "One memory for all my AI tools"', tags: 'speaking' });
  add(code, 3, { kind: 'todo', title: 'Write the README section on self-hosting', repo: 'trailmap' });
  add(claude, 1, { kind: 'decision', title: 'Ship tags before folders in Recall Notes', tags: 'recall-notes, product', repo: 'recall-notes' });

  // A task Claude Code started, Codex continued when Claude Code hit its limit, and Cursor finished; plus one still open.
  const viewer = (app) => ({ app, includePrivate: true });
  const t = ctx.startTask({ title: 'Tag filter for notes', goal: 'Filter notes by one or more tags in the API and the UI', repo: 'recall-notes', next: ['Add a tags index'] }, viewer(code));
  ctx.checkpointTask(t.id, { summary: 'Migration and GIN index on notes.tags', files: ['db/migrations/012_tags_index.sql'], commit: 'a1f9c3e', next: ['GET /notes?tags=a,b', 'Supertest for the filter'] }, viewer(code));
  ctx.checkpointTask(t.id, { summary: 'Route half done; near the usage limit', reason: 'limit-warning', next: ['Finish GET /notes?tags=a,b', 'Supertest for the filter'], questions: ['AND or OR between tags?'] }, viewer(code));
  ctx.resumeTask({ id: t.id }, viewer(codex));
  ctx.checkpointTask(t.id, { summary: 'Route and tests done (AND between tags)', commit: 'b7d2e90', decisions: ['Tags combine with AND'], next: ['UI chips for selected tags'] }, viewer(codex));
  ctx.resumeTask({ id: t.id }, viewer(cursor));
  ctx.finishTask(t.id, { summary: 'Tag filter shipped in PR #41' }, viewer(cursor));
  const open = ctx.startTask({ title: 'Offline mode for trailmap', goal: 'Cache the last 5 routes for offline use', repo: 'trailmap', next: ['Service worker with a cache-first strategy'] }, viewer(code));
  ctx.checkpointTask(open.id, { summary: 'Service worker registered; caching the route list', files: ['src/sw.js'], next: ['Cache map tiles for saved routes', 'Test in airplane mode'] }, viewer(code));
  // Spread the checkpoints over the last days.
  const cps = db.prepare('SELECT id, task_id FROM task_checkpoints ORDER BY id').all();
  cps.forEach((c, i) => db.prepare('UPDATE task_checkpoints SET at = ? WHERE id = ?').run(iso(c.task_id === t.id ? 5 - i * 0.6 : 0.2, i), c.id));
  db.prepare('UPDATE tasks SET created_at = (SELECT min(at) FROM task_checkpoints WHERE task_id = tasks.id), updated_at = (SELECT max(at) FROM task_checkpoints WHERE task_id = tasks.id)').run();

  // GitHub-like commits and pull requests (no GitHub involved).
  const insCommit = db.prepare('INSERT OR IGNORE INTO commits(sha, repo, date_utc, message, author, url) VALUES(?,?,?,?,?,?)');
  const commits = [
    ['recall-notes', 1, 'feat: tag chips in the note list'], ['recall-notes', 1, 'test: tag filter edge cases'],
    ['recall-notes', 4, 'feat: GET /notes?tags= filter'], ['recall-notes', 5, 'db: GIN index on notes.tags'],
    ['recall-notes', 9, 'fix: share links expire after 7 days'], ['trailmap', 0, 'feat: register service worker'],
    ['trailmap', 2, 'feat: save routes locally'], ['trailmap', 11, 'chore: upgrade Vite'],
    ['weather-cli', 6, 'feat: --units flag'], ['weather-cli', 6, 'docs: usage examples'], ['dotfiles', 13, 'zsh: faster prompt'],
  ];
  commits.forEach(([repo, days, msg], i) => insCommit.run(`demo${i}`, repo, iso(days, i), msg, 'alexrivera', `https://github.com/alexrivera/${repo}`));
  const insPr = db.prepare(`INSERT OR IGNORE INTO prs(id, repo, number, title, state, created_at, closed_at, merged_at, updated_at, url) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  insPr.run('recall-notes#41', 'recall-notes', 41, 'Tag filter for notes', 'closed', iso(5), iso(1), iso(1), iso(1), 'https://github.com/alexrivera/recall-notes/pull/41');
  insPr.run('trailmap#7', 'trailmap', 7, 'Offline mode', 'open', iso(0, 3), null, null, iso(0, 3), 'https://github.com/alexrivera/trailmap/pull/7');
  kvSet('last_sync_at', iso(0, 0.2));
  kvSet('github_owner', 'alexrivera');
  return true;
}
