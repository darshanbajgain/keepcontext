# KeepContext

One self-hosted memory for every AI app you use. Tell ChatGPT an idea, and Cursor, Claude Code and Gemini know it too. Start a task in Claude Code, and when it hits its usage limit, Codex continues from the last checkpoint.

KeepContext is a small Node app with a web UI and one MCP server that Claude (web, desktop, Claude Code), ChatGPT, Gemini, Cursor, Codex, Copilot and Antigravity all connect to.

> Work in progress: preparing the first public release. See [TODO.md](TODO.md).

## Features

- **Shared memory:** ideas, notes, decisions, todos, standing instructions and profile facts that every connected app reads with `get_context` and adds to with `save_entry`.
- **Verified per-app attribution:** each app and account gets its own token, so you see which app added or changed what; rotate or revoke one without touching the others.
- **Continue anywhere:** tasks with checkpoints and a git branch, so another app picks up where one stopped, and the first can review what the others did.
- **Private by design:** self-hosted; private entries and private tasks never reach URL-only apps or mirrors.
- **GitHub activity** (optional, read-only): commits and pull requests in an activity log, with a work log export.

## Run it

**Docker** (recommended):

```bash
docker run -d --name keepcontext -p 8787:8787 -v keepcontext-data:/data ghcr.io/darshanbajgain/keepcontext:latest
docker logs keepcontext   # shows the setup code; then open http://localhost:8787
```

To reach it from ChatGPT, Claude or Gemini on the web, it needs a public HTTPS address. With the [compose file](docker-compose.yml):

- `docker compose --profile quick-tunnel up -d`: an instant `https://….trycloudflare.com` address, no account. It changes when the container restarts, so it's for trying it out.
- `docker compose --profile tailscale up -d`: a fixed `https://keepcontext.<your-tailnet>.ts.net` address through Tailscale Funnel (free account; put `TS_AUTHKEY` in `.env`, and allow Funnel in your tailnet policy).

Coding apps on the same machine (Claude Code, Codex, Cursor, Copilot, Gemini CLI) work with plain `http://localhost:8787`.

**Node** 22.13 or newer:

```bash
npm install
npm start                # prints a setup code, then open http://localhost:8787
```

The setup page asks for that code, a password and your timezone, and creates your admin token. Then:

1. **Apps** tab: connect your AI apps ([docs/CONNECT_APPS.md](docs/CONNECT_APPS.md)).
2. **Settings** tab (optional): **Connect GitHub** opens GitHub with a read-only token already filled in; paste it back.

No `.env` is needed; every setting in [.env.example](.env.example) is optional and wins over the UI. To look around first: `DEMO=1 npm start` fills the hub with a fictional person.

## Docs

- [docs/CONNECT_APPS.md](docs/CONNECT_APPS.md): connecting each AI app
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works, data model, security model, configuration
- [docs/HANDOFF_PLAN.md](docs/HANDOFF_PLAN.md): the continue-anywhere design

## License

[AGPL-3.0](LICENSE). You may self-host and modify it; if you offer a modified version as a network service, you must publish your changes.
