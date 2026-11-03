# Roadmap

## First public release (1.0.0)

- [x] **First-run setup page:** setup code from the log, password, timezone; the admin token is generated and shown once. No `.env` needed.
- [x] **GitHub optional everywhere**, and **Connect GitHub** in the Settings tab (pre-filled read-only token link).
- [x] **Demo mode** (`DEMO=1`) with a fictional person, for screenshots and trying it out.
- [x] **Docker:** non-root user, `HEALTHCHECK`, OCI labels, clean stop; multi-arch image on GitHub Container Registry on every release; compose file with optional Cloudflare quick tunnel and Tailscale Funnel.
- [ ] Test the `tailscale` compose profile with a real auth key.
- [x] **Docs:** README with screenshots and a quick start, self-hosting guide (Docker, tunnels, VPS, backups), security model.
- [x] **Community files:** LICENSE (AGPL-3.0), CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue and PR templates, Dependabot, CodeQL (runs once public).
- [x] Launch (2026-11-04): repo public, private vulnerability reporting and secret scanning on, ghcr.io package public, `v1.0.0` tagged.

## Later

- [ ] OAuth 2.1 for MCP, so web apps sign in instead of using a secret URL.
- [ ] MCP `resume` prompt and resources (`context://bundle`).
- [ ] GitHub compare links per task checkpoint; public tasks in the Google Doc mirror.
- [ ] Better search (SQLite FTS5, then optional embeddings).
- [ ] More sources (GitLab, other GitHub accounts) and mirrors (Notion, Markdown).
- [ ] Postgres option behind a small storage interface.
- [ ] Pagination and inline editing in the UI.
