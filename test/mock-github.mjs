// Fake GitHub API for tests and offline development. Token must be "ghtest".
// Run: MOCK_PORT=9911 node test/mock-github.mjs
import express from 'express';
const app = express();
const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const repos = [
  { name: 'notes-app', full_name: 'alexdev/notes-app', private: false, html_url: 'https://github.com/alexdev/notes-app', default_branch: 'main', pushed_at: iso(2), owner: { login: 'alexdev' }, fork: false },
  { name: 'weather-cli', full_name: 'alexdev/weather-cli', private: false, html_url: 'https://github.com/alexdev/weather-cli', default_branch: 'main', pushed_at: iso(30), owner: { login: 'alexdev' }, fork: false },
  { name: 'old-thing', full_name: 'alexdev/old-thing', private: true, html_url: 'x', default_branch: 'main', pushed_at: iso(24*400), owner: { login: 'alexdev' }, fork: false },
  { name: 'empty', full_name: 'alexdev/empty', private: false, html_url: 'x', default_branch: 'main', pushed_at: iso(5), owner: { login: 'alexdev' }, fork: false },
];
// Test switch: POST /_fail/<repo> makes that repo's commits fail with a 500, DELETE /_fail/<repo> fixes it.
const failing = new Set();
// Failing marks the repo as just pushed (so the hub fetches it); fixing dates the push 2 days back, so only the
// hub's retry list makes it fetch the repo again.
const setPushed = (name, h) => { const r = repos.find((x) => x.name === name); if (r) r.pushed_at = iso(h); };
app.post('/_fail/:r', (req, res) => { failing.add(req.params.r); setPushed(req.params.r, 0); res.json({ failing: [...failing] }); });
app.delete('/_fail/:r', (req, res) => { failing.delete(req.params.r); setPushed(req.params.r, 48); res.json({ failing: [...failing] }); });
app.use((req, res, next) => { if (req.headers.authorization !== 'Bearer ghtest') return res.status(401).json({ message: 'bad' }); next(); });
app.use('/repos/:o/:r/commits', (req, res, next) => failing.has(req.params.r) ? res.status(500).json({ message: 'Server Error' }) : next());
app.get('/users/:u/repos', (req, res) => res.json(repos.filter(r => !r.private)));
app.get('/user/repos', (req, res) => res.json(repos));
app.get('/repos/:o/empty/commits', (req, res) => res.status(409).json({ message: 'Git Repository is empty.' }));
app.get('/repos/:o/:r/commits', (req, res) => {
  const r = req.params.r;
  const c = r === 'notes-app'
    ? [['feat: add tag filter', 2], ['fix(db): index on created_at', 3], ['Merge pull request #1 from x', 3], ['Initial commit', 26]]
    : [['Release 0.9.1', 30], ['Release 0.9.1', 30], ["Merge branch 'feat/x'", 24 * 5]];
  res.json(c.map(([m, h], i) => ({ sha: r + i, html_url: 'u', commit: { message: m, author: { date: iso(h), name: 'D' } }, author: { login: 'alexdev' } })));
});
app.get('/repos/:o/:r/pulls', (req, res) => {
  if (req.params.r !== 'notes-app') return res.json([]);
  res.json([
    { number: 2, title: 'Dark mode', state: 'open', created_at: iso(1), closed_at: null, merged_at: null, updated_at: iso(1), html_url: 'p2' },
    { number: 1, title: 'Search by tag', state: 'closed', created_at: iso(10), closed_at: iso(3), merged_at: iso(3), updated_at: iso(3), html_url: 'p1' },
  ]);
});
const port = Number(process.env.MOCK_PORT || 9911);
app.listen(port, () => console.log(`mock GitHub on ${port}`));
