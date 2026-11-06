# Self-hosting KeepContext

KeepContext is one Node process and one SQLite file. Anything that keeps a disk works: your laptop, a home server or Raspberry Pi, a small VPS, or Railway, Render or Fly.io with a volume. Serverless hosts without a disk (Vercel, Netlify) don't.

Where to run it:

- **Only coding apps on this computer** (Claude Code, Codex, Cursor, Copilot, Gemini CLI)? Run it locally and use `http://localhost:8787`.
- **Web apps too** (ChatGPT, Claude, Gemini)? They connect from their own servers, so they need a public HTTPS address: see [Public HTTPS](#public-https). For everyday use, run KeepContext somewhere that stays on, with an address that stays the same.

## Public HTTPS

The easiest way is built in: **Settings → Public access** in the web UI. KeepContext runs `cloudflared` for you (the Docker image includes it), checks the address from the internet, uses it in every connection link, and starts it again whenever KeepContext starts.

| Option | How | Address |
| --- | --- | --- |
| **Quick tunnel** | Settings → Public access → Quick tunnel → Save | `https://….trycloudflare.com`. No account, ready in about a minute. **Changes when KeepContext restarts**: the web apps then need the new address (the Settings tab tells you). Good for trying it out. |
| **Cloudflare tunnel** | Settings → Public access → Cloudflare tunnel: paste the token and your hostname ([steps below](#cloudflare-tunnel-with-your-domain)) | Fixed, on your own domain. Free Cloudflare account. |
| Tailscale Funnel | `docker compose --profile tailscale up -d` ([section 1](#1-docker-compose-recommended)) | Fixed `https://keepcontext.<tailnet>.ts.net`. Free Tailscale account, no domain needed. |
| Your own reverse proxy | Caddy / Nginx in front of port 8787 | Your domain. Set `TRUST_PROXY` and `PUBLIC_URL` (section 1). |

Without Docker, the built-in tunnel needs [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed (or `CLOUDFLARED_BIN` pointing to it). The same settings work from `.env`: `TUNNEL=quick`, or `TUNNEL=cloudflare` with `CLOUDFLARE_TUNNEL_TOKEN` and `TUNNEL_HOSTNAME`.

### Cloudflare tunnel with your domain

You need a free Cloudflare account and a domain that uses Cloudflare's DNS. Names in the Cloudflare dashboard change now and then; the steps are the same.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels** and **create a tunnel** of type **Cloudflared**. Name it `keepcontext`.
2. On the install step, copy the **token**: the long string after `--token` in any of the commands (it starts with `eyJ`). You don't need to run their command.
3. Add a **public hostname**: for example subdomain `keepcontext` on your domain, service type **HTTP**, URL **`localhost:8787`**.
4. In KeepContext: **Settings → Public access → Cloudflare tunnel**, paste the token and the hostname (`keepcontext.example.com`), **Save**. After a few seconds it shows the address as reachable.

The token lets anyone run your tunnel, so treat it like a password. KeepContext stores it in its database (like the GitHub token), passes it to `cloudflared` through the environment, and never shows it again.

## 1. Docker Compose (recommended)

Get [docker-compose.yml](../docker-compose.yml) and [docker/tailscale-funnel.json](../docker/tailscale-funnel.json) (or clone the repo), then:

```bash
docker compose up -d                              # local only: http://localhost:8787
docker compose logs keepcontext                   # the setup code (first start only)
```

Optional `.env` next to the compose file: every setting in [.env.example](../.env.example) works there.

**Public HTTPS:** the built-in tunnel (Settings → Public access, [above](#public-https)) needs nothing here. The compose file also has file-based options:

| Option | How | Notes |
| --- | --- | --- |
| Tailscale Funnel | `TS_AUTHKEY=tskey-…` in `.env`, then `docker compose --profile tailscale up -d` | Fixed `https://keepcontext.<tailnet>.ts.net`. Create the auth key in the Tailscale admin console (Settings → Keys); allow Funnel for the node in your tailnet policy ([docs](https://tailscale.com/kb/1223/funnel)). |
| Cloudflare quick tunnel | `docker compose --profile quick-tunnel up -d`, address in `docker compose logs quick-tunnel` | Same as the built-in quick tunnel, as a separate container. The address changes on every restart. |
| Your own domain | A reverse proxy such as Caddy (`reverse_proxy localhost:8787`) | If the proxy runs in another container or machine, set `TRUST_PROXY` to its address or network, and `PUBLIC_URL` to your address. |

The tunnel containers share KeepContext's network, so the hub sees them as a trusted local proxy: HTTPS is detected, and the Apps tab shows the public address when you open the hub through it.

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
