# Changelog

All notable changes to KeepContext. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/): **MAJOR** for breaking changes (API, MCP tools, data), **MINOR** for new features, **PATCH** for fixes. How to cut a release: [CONTRIBUTING.md](CONTRIBUTING.md).

## [Unreleased]

## [1.0.1] - 2026-11-04

### Security

- The `repo` parameter of the REST API only accepts repository names (letters, digits, `.`, `-`, `_`), so it can never be echoed back as markup; every response sends `X-Content-Type-Options: nosniff`. Found by CodeQL.
- Connection names are built without a backtracking regular expression.

## [1.0.0] - 2026-11-04

First public version: one self-hosted memory for every AI app, with tasks any app can continue.

### Added

- **One memory for every AI app** over MCP: ideas, notes, decisions, todos, standing instructions and profile facts, with search, tags, pins and private entries.
- **Connections:** one token per app and account, verified attribution (which app created or changed what), rotate and revoke per app, scoped access.
- **Continue anywhere:** tasks with checkpoints, so when one app hits its usage limit another resumes from the last checkpoint and the task's git branch; the first app can review what the others did.
- **GitHub activity** (read-only, optional): repos, commits and pull requests in an activity log, with a work log export.
- **Web UI:** Overview, Context, Tasks, Activity log, Projects, Apps and Repo files tabs; light and dark; mobile.
- **Google Doc mirror** (optional) of your public context for Drive-connected apps.
- **Security:** hashed connection tokens, private entries never over the secret URL, rate limits, read-only GitHub.
- Backup and restore scripts, end-to-end tests against a fake GitHub and a fake Google.
- **First-run setup:** no `.env` needed. Open the hub, enter the setup code from the server log, choose a password and timezone; the admin token is created and shown once. A **Get started** checklist on the Overview.
- **Settings tab:** name, timezone, password, a new admin token, and **Connect GitHub** (opens GitHub with a read-only token pre-filled; paste it back). Values in `.env` still win.
- **Demo mode** (`DEMO=1`): a fictional person with entries from several apps, a handed-off task and GitHub-like activity.
- **Work log CSV** download in the Activity log.
- **Docker image** for amd64 and arm64 on GitHub Container Registry (non-root, health check, clean stop), and a compose file with optional public HTTPS: a Cloudflare quick tunnel (no account) or Tailscale Funnel (fixed address).
- The hub detects its public address from the request when `PUBLIC_URL` isn't set, so snippets in the Apps tab show the tunnel's address.
- Docs: README with screenshots, self-hosting guide (Docker, tunnels, VPS, backups and restore), contributing guide with the release process, security policy.

### Security

- Dependencies updated: body-parser (high) and fast-uri (moderate) advisories fixed.

[Unreleased]: https://github.com/darshanbajgain/keepcontext/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/darshanbajgain/keepcontext/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/darshanbajgain/keepcontext/releases/tag/v1.0.0
