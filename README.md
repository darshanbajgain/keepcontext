# KeepContext

[![CI](https://github.com/darshanbajgain/keepcontext/actions/workflows/ci.yml/badge.svg)](https://github.com/darshanbajgain/keepcontext/actions/workflows/ci.yml) · [Changelog](CHANGELOG.md) · [AGPL-3.0](LICENSE)

**One self-hosted memory for every AI app you use.** Tell ChatGPT an idea, and Claude Code, Cursor and Gemini know it too. Start a task in Claude Code, and when it hits its usage limit, Codex continues from where it stopped.

KeepContext is a small server with a web dashboard and one [MCP](https://modelcontextprotocol.io) endpoint. ChatGPT, Claude (web, desktop, Claude Code), Gemini (web, CLI), Cursor, Codex, GitHub Copilot and Antigravity all connect to it. Your data stays on your machine or server.

**Built for students, researchers and developers**: anyone whose work is spread across several AI tools and who wants every one of them to know the same ideas, todos and project status.

[![KeepContext demo video: setup, saving an idea in ChatGPT, Claude already knowing it, and a coding task handed from Claude Code to Copilot](https://img.youtube.com/vi/2RkaAdRqNhY/maxresdefault.jpg)](https://youtu.be/2RkaAdRqNhY)

▶ **[Watch the 2½-minute demo](https://youtu.be/2RkaAdRqNhY)**: setup with Docker, public access for web apps, GitHub, saving an idea in ChatGPT that Claude already knows, and a coding task that Copilot continues after Claude Code hits its limit.

## Who it's for

| | What KeepContext keeps for you | Example |
| --- | --- | --- |
| 🎓 **Students** | Course notes, study plans, deadlines and todos, the same in every AI app | Plan your week in ChatGPT, then ask Claude what's due on Friday |
| 🔬 **Researchers** | Hypotheses, reading notes, experiment decisions and open questions | Save a paper idea in one chat; any assistant can recall it and build on it later |
| 💻 **Developers** | Project decisions, coding rules, GitHub progress, and multi-step tasks | Claude Code hits its usage limit mid-task; Codex, Cursor or Copilot continues from the last checkpoint |

Wherever you are and whichever AI you open, it starts from the same context: your current projects, open todos, recent decisions and what changed today.

![Overview: counts, pinned items, which apps changed what, active tasks](docs/images/overview.png)

## What it does

- **One memory for all your AI apps.** Ideas, decisions, todos, notes, standing instructions ("keep answers short") and facts about you. Every connected app loads them with `get_context` and adds to them with `save_entry`.
- **Continue anywhere.** For multi-step coding work, apps start a task and save a short checkpoint after each step on the task's git branch. When one app hits its limit, another says "resume my task" and gets the goal, the next steps, the branch and the history. Later, the first app can review what the others did.
- **Know which app did what.** Each app and account gets its own token, so the dashboard shows verified badges (ChatGPT · personal, Claude Code, Cursor…) instead of trusting what a model says about itself. Rotate or revoke one app without touching the others.
- **Private by design.** Self-hosted, with private entries and tasks that never go to apps connected by URL. Tokens are stored only as hashes, there are rate limits, and GitHub access is read-only.
- **Your work log (optional).** Connect GitHub (read-only) to see commits and pull requests per day in an activity log, ready to copy into a status report or CV notes.

![Tasks: Claude Code started, hit its limit, Codex took over, Cursor finished](docs/images/tasks.png)

## Quick start

### Docker

```bash
docker run -d --name keepcontext -p 8787:8787 -v keepcontext-data:/data ghcr.io/darshanbajgain/keepcontext:latest
docker logs keepcontext      # shows a one-time setup code
```

Open http://localhost:8787, enter the setup code, and choose a password. That's all the configuration there is.

Want to look around first? `docker run --rm -p 8787:8787 -e DEMO=1 ghcr.io/darshanbajgain/keepcontext:latest` starts a demo with a fictional developer (the password is on the login page).

### Reach it from ChatGPT, Claude and Gemini on the web

Web apps connect from their own servers, so they can't reach `localhost`: KeepContext needs a public HTTPS address. It's built in: open **Settings → Public access**.

| Option | Address | Good for |
| --- | --- | --- |
| **Quick tunnel** (one click) | `https://….trycloudflare.com`, **changes when KeepContext restarts** | Trying it out. No account needed |
| **Cloudflare tunnel** (paste a token) | a fixed address on your own domain | Everyday use. Free Cloudflare account and a domain ([how](docs/SELF_HOSTING.md#cloudflare-tunnel-with-your-domain)) |
| Tailscale Funnel (`docker compose --profile tailscale up -d`) | a fixed `https://keepcontext.<your-tailnet>.ts.net` | Everyday use without a domain. Free [Tailscale](https://tailscale.com) account |

KeepContext checks the address from the internet and uses it in every connection link. Coding apps on the same machine keep using `http://localhost:8787`. More options (Caddy, Nginx, a VPS): [self-hosting guide](docs/SELF_HOSTING.md).

### Without Docker

Node 22.13 or newer: `npm install && npm start`, then open http://localhost:8787. The setup code is printed in the terminal.

## Connect your apps

In the **Apps** tab, **Add a connection** for each app (and account). It shows that app's setup once:

| App | How |
| --- | --- |
| **ChatGPT** | **Plugins** (left sidebar) → **Add** → **Add custom MCP server** → Server URL = the secret URL, **No authentication** → then set it to **Allow all tools**. Works on the free plan. |
| **Claude** (web, desktop, mobile) | Settings → Connectors → Add custom connector → the secret URL |
| **Gemini** | Customise → Connectors → Custom → the secret URL |
| **Claude Code, Codex, Cursor, Copilot, Gemini CLI, Antigravity** | One command in any terminal: `curl -fsSL https://YOUR-HUB/connect.sh \| bash -s codex` (or `claude-code`, `cursor`, `copilot`, `gemini-cli`, `antigravity`), then paste the token |

Step by step, with troubleshooting: [docs/CONNECT_APPS.md](docs/CONNECT_APPS.md).

![Apps: one connection per app and account](docs/images/apps.png)

### Tell your apps to use it

Connected isn't the same as used. Add this once to each app's personal instructions:

| App | File or setting |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` |
| Gemini CLI, Antigravity | `~/.gemini/GEMINI.md` |
| Cursor | Settings → Rules → User Rules |
| Copilot (VS Code) | a `*.instructions.md` file in your VS Code user `prompts` folder with `applyTo: '**'` |
| ChatGPT, Claude, Gemini web | Custom instructions / personal preferences |

```markdown
## KeepContext: my shared memory across AI apps
- At the start of a task, call `get_context` from the keepcontext MCP server (pass `repo` = the repository name) and follow its standing instructions.
- Before asking me for background, use `search_context`.
- Save new ideas, decisions, todos and notes with `save_entry`.
- For multi-step work, `start_task`, then `checkpoint_task` after each step, so another app can continue with `resume_task` if you stop. At the start, check `list_open_tasks`.
- Never print tokens or the secret `/mcp/k/…` URL.
```

This lives in your home folder, so every project is covered and nothing is committed to any repo. For a single repo, the **Repo files** tab generates `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / Cursor rule files instead.

## MCP tools

| Tool | What it does |
| --- | --- |
| `get_context` | The bundle to load first: profile, standing instructions, pinned items, recent ideas, decisions and todos, open tasks, projects, recent activity |
| `search_context`, `list_entries` | Find earlier ideas, notes and decisions |
| `save_entry`, `update_entry` | Add or edit an idea, note, decision, todo, instruction or profile fact |
| `start_task`, `checkpoint_task` | Start multi-step work (returns a task id and a branch), then record progress after each step |
| `list_open_tasks`, `resume_task` | See unfinished tasks; continue one from its last checkpoint, or review what other apps did since yours |
| `finish_task` | Mark a task done or abandoned, with the result |
| `list_projects`, `update_project` | Your GitHub repos with your own status and notes |
| `get_activity`, `sync_github` | Activity log rows; sync GitHub now |
| `get_unlogged_activity`, `mark_activity_logged` | Activity not yet copied to your work log, then mark it copied |
| `get_repo_context_files` | The AGENTS.md / CLAUDE.md / GEMINI.md / Cursor rule contents for a repo |

## Security and privacy

- **Your server, your data.** Everything is in one SQLite file in the data volume. Nothing is sent anywhere except to the AI apps you connect, to GitHub's API if you connect it (read-only), and to one Google Doc if you turn on the optional mirror (never private entries).
- **Tokens:** each app has its own token, stored only as a SHA-256 hash and shown once. The admin password is hashed with scrypt. A one-time setup code stops anyone else from claiming a freshly started server.
- **Private entries and tasks** stay in the dashboard. Apps connected by a secret URL (the web apps) never receive them; header-based apps only when you allow it per connection. Tasks for repos KeepContext doesn't sync (for example work repos) are private automatically.
- **Rate limits** on failed logins, wrong tokens and requests per app.
- **Treat secret URLs like passwords.** If one leaks, rotate that connection in the Apps tab.

Details: [docs/ARCHITECTURE.md §6](docs/ARCHITECTURE.md#6-security-model). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Configuration

Nothing is required. The setup page and the **Settings** tab cover the password, your name, timezone and GitHub. Every setting can also be set as an environment variable or in `.env`; those win over the UI. See [.env.example](.env.example) and [docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-configuration). Backups, updates and running without Docker: [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## FAQ

**Does it need GitHub?** No. Without it, KeepContext is a shared memory with tasks. GitHub adds the activity log and the Projects tab.

**Does it work on the ChatGPT free plan?** Yes, as a custom plugin (checked November 2026). Set the plugin to "Allow all tools", or ChatGPT asks before every save.

**Can I run it on a Raspberry Pi?** Yes. The image is published for arm64 too.

**I'm not a developer. Is it for me?** Yes, if you can run one Docker command. Students and researchers use the same ideas, notes, todos and decisions; tasks and GitHub are optional extras.

**How is this different from each app's own memory?** Each app's memory stays inside that app. KeepContext is one memory that every app reads and writes, on your own server, and it can hand a task from one app to another.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before opening a pull request.

## License

[AGPL-3.0](LICENSE). You can use, self-host and modify KeepContext freely. If you offer a modified version to others as a network service, you must publish your changes under the same license.
