// GitHub sync: repos, commits on the default branch, and pull requests.
// Read-only: it never writes to GitHub.
import { config } from './config.js';
import { db, now, kvGet, kvSet, notifyChange } from './db.js';
import './settings.js'; // a token connected in the Settings tab fills in config.github

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

async function gh(pathOrUrl) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'keepcontext',
      ...(config.github.token ? { Authorization: `Bearer ${config.github.token}` } : {}),
    },
  });
  if (res.status === 409) return { data: [], next: null }; // empty repository
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status} on ${url.replace(API, '')}: ${body.slice(0, 200)}`);
  }
  const link = res.headers.get('link') || '';
  const next = (link.match(/<([^>]+)>;\s*rel="next"/) || [])[1] || null;
  return { data: await res.json(), next };
}

async function ghAll(path, { maxPages = 10, stop } = {}) {
  const out = [];
  let url = path;
  for (let i = 0; url && i < maxPages; i++) {
    const { data, next } = await gh(url);
    for (const item of data) {
      if (stop && stop(item)) return out;
      out.push(item);
    }
    url = next;
  }
  return out;
}

let running = null;

/** Run a sync. Concurrent calls share the same run. */
export function syncGithub() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  if (!config.github.token) throw new Error('GitHub is not connected. Connect it in the Settings tab (or set GITHUB_TOKEN in .env).');
  const startedAt = now();
  const runId = db.prepare('INSERT INTO sync_runs(started_at) VALUES(?)').run(startedAt).lastInsertRowid;
  const summary = { repos: 0, reposChanged: [], newCommits: 0, prsTouched: 0, errors: [] };

  try {
    const windowStart = new Date(Date.now() - config.github.windowDays * 864e5).toISOString();
    const lastSync = kvGet('last_sync_at');
    // First run backfills the whole window; later runs go back to the last sync (with 1h overlap).
    const since = lastSync ? new Date(new Date(lastSync).getTime() - 3600e3).toISOString() : windowStart;

    // Repos whose last fetch failed, with the point to fetch from again, so their commits aren't skipped.
    const retry = JSON.parse(kvGet('sync_retry') || '{}');

    let owner = config.github.owner;
    let repos;
    if (owner) {
      repos = await ghAll(`/users/${owner}/repos?type=owner&sort=pushed&per_page=100`);
      // Private repos only show up through /user/repos for the token owner.
      try {
        const mine = await ghAll('/user/repos?affiliation=owner&sort=pushed&per_page=100');
        const seen = new Set(repos.map((r) => r.full_name));
        for (const r of mine) if (r.owner?.login?.toLowerCase() === owner.toLowerCase() && !seen.has(r.full_name)) repos.push(r);
      } catch { /* token may not belong to owner */ }
    } else {
      repos = await ghAll('/user/repos?affiliation=owner&sort=pushed&per_page=100');
      owner = repos[0]?.owner?.login || '';
    }

    const upsertRepo = db.prepare(`
      INSERT INTO repos(name, full_name, private, html_url, description, default_branch, pushed_at, updated_at)
      VALUES($name, $full_name, $private, $html_url, $description, $default_branch, $pushed_at, $updated_at)
      ON CONFLICT(name) DO UPDATE SET full_name=excluded.full_name, private=excluded.private, html_url=excluded.html_url,
        description=excluded.description, default_branch=excluded.default_branch, pushed_at=excluded.pushed_at, updated_at=excluded.updated_at`);
    const insCommit = db.prepare(`INSERT OR IGNORE INTO commits(sha, repo, date_utc, message, author, url) VALUES(?,?,?,?,?,?)`);
    const upsertPr = db.prepare(`
      INSERT INTO prs(id, repo, number, title, state, created_at, closed_at, merged_at, updated_at, url)
      VALUES($id, $repo, $number, $title, $state, $created_at, $closed_at, $merged_at, $updated_at, $url)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, state=excluded.state, closed_at=excluded.closed_at,
        merged_at=excluded.merged_at, updated_at=excluded.updated_at`);

    for (const r of repos) {
      if (r.fork && !config.github.includeForks) continue;
      summary.repos++;
      upsertRepo.run({
        $name: r.name, $full_name: r.full_name, $private: r.private ? 1 : 0, $html_url: r.html_url,
        $description: r.description || '', $default_branch: r.default_branch || 'main', $pushed_at: r.pushed_at, $updated_at: now(),
      });
      const repoSince = retry[r.name] || since;
      if (!retry[r.name] && (!r.pushed_at || r.pushed_at < since)) continue;

      summary.reposChanged.push(r.name);
      try {
        const commits = await ghAll(
          `/repos/${r.full_name}/commits?sha=${encodeURIComponent(r.default_branch)}&since=${repoSince}&per_page=100`);
        for (const c of commits) {
          const res = insCommit.run(c.sha, r.name, c.commit?.author?.date || c.commit?.committer?.date,
            c.commit?.message || '', c.author?.login || c.commit?.author?.name || '', c.html_url);
          summary.newCommits += Number(res.changes);
        }
        const prs = await ghAll(`/repos/${r.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
          { maxPages: 5, stop: (p) => p.updated_at < repoSince });
        for (const p of prs) {
          upsertPr.run({
            $id: `${r.name}#${p.number}`, $repo: r.name, $number: p.number, $title: p.title, $state: p.state,
            $created_at: p.created_at, $closed_at: p.closed_at, $merged_at: p.merged_at, $updated_at: p.updated_at, $url: p.html_url,
          });
          summary.prsTouched++;
        }
        delete retry[r.name];
      } catch (e) {
        summary.errors.push(`${r.name}: ${e.message}`);
        retry[r.name] = repoSince;
      }
    }

    kvSet('sync_retry', JSON.stringify(retry));
    kvSet('last_sync_at', startedAt);
    if (owner) kvSet('github_owner', owner);
    db.prepare('UPDATE sync_runs SET finished_at=?, ok=1, summary=? WHERE id=?').run(now(), JSON.stringify(summary), runId);
    if (summary.reposChanged.length) notifyChange('sync');
    return { ok: true, startedAt, ...summary };
  } catch (e) {
    db.prepare('UPDATE sync_runs SET finished_at=?, ok=0, summary=? WHERE id=?').run(now(), JSON.stringify({ ...summary, error: e.message }), runId);
    throw e;
  } finally {
    // Auto-sync adds a run every few minutes; keep the newest 500.
    db.prepare('DELETE FROM sync_runs WHERE id <= ?').run(Number(runId) - 500);
  }
}
