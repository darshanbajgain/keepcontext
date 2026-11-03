# Self-hosting KeepContext

KeepContext is one Node process and one SQLite file. Anything that keeps a disk works: your laptop, a home server or Raspberry Pi, a small VPS, or Railway, Render or Fly.io with a volume. Serverless hosts without a disk (Vercel, Netlify) don't.

Where to run it:

- **Only coding apps on this computer** (Claude Code, Codex, Cursor, Copilot, Gemini CLI)? Run it locally and use `http://localhost:8787`.
- **Web apps too** (ChatGPT, Claude, Gemini)? They need a public HTTPS address that stays the same, so run it somewhere always on and use one of the HTTPS options below.

## 1. Docker Compose (recommended)

Get [docker-compose.yml](../docker-compose.yml) and [docker/tailscale-funnel.json](../docker/tailscale-funnel.json) (or clone the repo), then:

```bash
docker compose up -d                              # local only: http://localhost:8787
docker compose logs keepcontext                   # the setup code (first start only)
```

Optional `.env` next to the compose file: every setting in [.env.example](../.env.example) works there.

**Public HTTPS**, pick one:

| Option | How | Notes |
| --- | --- | --- |
| Tailscale Funnel | `TS_AUTHKEY=tskey-…` in `.env`, then `docker compose --profile tailscale up -d` | Fixed `https://keepcontext.<tailnet>.ts.net`. Create the auth key in the Tailscale admin console (Settings → Keys); allow Funnel for the node in your tailnet policy ([docs](https://tailscale.com/kb/1223/funnel)). |
| Cloudflare quick tunnel | `docker compose --profile quick-tunnel up -d`, address in `docker compose logs quick-tunnel` | No account. The address changes on every restart, so connectors in web apps break: for trying it out only. |
| Your own domain | A reverse proxy such as Caddy (`reverse_proxy localhost:8787`) | If the proxy runs in another container or machine, set `TRUST_PROXY` to its address or network, and `PUBLIC_URL` to your address. |

The tunnel containers share KeepContext's network, so the hub sees them as a trusted local proxy: HTTPS is detected, and the Apps tab shows the public address on its own.

**Update:**

```bash
docker compose pull && docker compose up -d
```

## 2. Plain Docker

```bash
docker run -d --name keepcontext --restart unless-stopped -p 8787:8787 -v keepcontext-data:/data ghcr.io/darshanbajgain/keepcontext:latest
```

The image runs as the unprivileged `node` user (uid 1000). For a bind mount instead of a named volume, make the folder writable for that user: `mkdir data && sudo chown 1000:1000 data`, then `-v "$PWD/data:/data"`.

## 3. Without Docker (a Debian or Ubuntu VM)

```bash
git clone https://github.com/darshanbajgain/keepcontext.git ~/keepcontext
cd ~/keepcontext && bash scripts/vm-setup.sh    # Node 22, swap, dependencies, systemd service "keepcontext"
journalctl -u keepcontext | grep "setup code"
```

Update with `bash scripts/deploy.sh` (fast-forwards to `origin/main`, reinstalls dependencies only if they changed, restarts, checks `/healthz`, and rolls back if the check fails).

## 4. Backups

The database is a single file, `hub.db`, in the data folder. It holds **everything, including private entries and your GitHub token**, so keep backups private and encrypted.

```bash
# Docker: a consistent snapshot while the hub runs
docker exec keepcontext bash scripts/backup.sh --stdout > keepcontext-$(date +%F).db

# Without Docker: keeps the newest 14 in ~/keepcontext-backups
bash scripts/backup.sh
```

Encrypt before storing it elsewhere, for example `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in keepcontext-….db -out keepcontext-….db.enc`.

**Restore:**

- **Docker:** stop the container, copy the file into the volume as `hub.db`, start it again:
  ```bash
  docker stop keepcontext
  docker run --rm -v keepcontext-data:/data -v "$PWD":/backup alpine sh -c 'cp /backup/keepcontext-2026-11-03.db /data/hub.db && rm -f /data/hub.db-wal /data/hub.db-shm && chown 1000:1000 /data/hub.db'
  docker start keepcontext
  ```
- **Without Docker:** `bash scripts/restore.sh <file>` checks the file, keeps the current database as `pre-restore-…`, swaps it in, and undoes the swap if the health check fails.

`GET /api/export` is not a backup: it leaves private entries out.

## 5. Checklist for a public server

- Use HTTPS only, through one of the options above.
- A long password on the setup page. Keep the admin token from setup in a password manager; apps get their own tokens in the Apps tab.
- Back up `hub.db` regularly (section 4).
- Watch the header for GitHub sync errors; the Activity tab lists recent sync runs.
