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

Node 22.13 or newer:

```bash
cp .env.example .env     # set HUB_TOKEN (openssl rand -hex 32); GITHUB_TOKEN is optional
npm install
npm start                # http://localhost:8787
```

Then open the **Apps** tab to connect your AI apps ([docs/CONNECT_APPS.md](docs/CONNECT_APPS.md)).

## Docs

- [docs/CONNECT_APPS.md](docs/CONNECT_APPS.md): connecting each AI app
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works, data model, security model, configuration
- [docs/HANDOFF_PLAN.md](docs/HANDOFF_PLAN.md): the continue-anywhere design

## License

[AGPL-3.0](LICENSE). You may self-host and modify it; if you offer a modified version as a network service, you must publish your changes.
