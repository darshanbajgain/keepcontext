# Connecting your AI apps

How to connect ChatGPT, Claude, Gemini, Claude Code, Cursor, Antigravity, Codex, Gemini CLI and Copilot to your KeepContext, so they all share one memory, and the dashboard shows which app (and which account) did what.

You do this **once per app** (and per account). After that the app is connected **in every project**, new or old.

## 1. How it works

```
Hub → Apps tab → Add a connection → token (shown once) → put it into the app → the app shows up by name
```

- A **connection** is one app + one account: `ChatGPT · main`, `ChatGPT · work`, `Claude · work`, `Cursor`, `Codex`…
- Each connection has its **own token** (`chub_…`). The hub stores only a fingerprint (hash) of it, so it can show it **only once**, right after you create it.
- Whatever that app saves is recorded under that connection, from the token itself. Even if the AI claims to be something else, the dashboard shows the real app (and "said …" if they differ).
- You can **rotate** (new token, old one dies at once) or **revoke** (cut off) one connection without touching the others.

Where the app keeps its token depends on the app:

| App | Connects with | Token is stored in |
| --- | --- | --- |
| ChatGPT, Claude, Gemini (web/desktop/mobile) | a **secret URL** `…/mcp/k/<token>` | that app's connector settings (your account) |
| Claude Code, Cursor, Antigravity, Copilot | a **header** `Authorization: Bearer <token>` | the app's config file in your home folder |
| Codex (CLI and VS Code extension) | a header | `~/.codex/config.toml` (private file) |
| Gemini CLI | a header, read from a variable | `~/.config/keepcontext/env` (private file your shell loads) |

## 2. Create a connection

1. Open your hub (e.g. `https://keepcontext.example.com`) and sign in.
2. **Apps** tab → **Add a connection** (right side):
   - **App:** which app.
   - **Account:** a label of your choice, to keep accounts apart (`personal`, `work`). Leave empty if you have one account.
   - **Allow private entries:** only for apps you fully trust and that connect with a header. Secret URLs never get private entries.
3. **Create token.** A yellow card shows the setup for that app. **Copy what you need now**; when done, click **Done, hide it**.

## 3. Set up each app

### Web apps: ChatGPT, Claude, Gemini (one connection per account)

Sign in to the right account first, then paste the **secret URL** from the card:

| App | Where |
| --- | --- |
| **ChatGPT** | Settings → Apps & Connectors → Advanced → **Developer mode** on → **Create** → name `KeepContext`, URL = secret URL, Authentication **No authentication** → Create. In a chat, enable it from **+ → Developer mode**. |
| **Claude** (web, desktop, mobile) | Settings → **Connectors** → **Add custom connector** → name `KeepContext`, URL = secret URL, **No sign-in**, no headers. |
| **Claude with private access** | Same, but URL = `https://YOUR-HUB/mcp` and a **request header** `Authorization` = `Bearer <token>` (create the connection with "Allow private entries"). |
| **Gemini** | **Customise → Connectors → + Custom** → URL = secret URL → Next. |

Changing a connector: most apps don't let you edit the URL; **remove the old connector and add it again**.

### Local apps: one command, from any terminal

The card shows a command like:

```bash
curl -fsSL https://YOUR-HUB/connect.sh | bash -s cursor
```

Run it in **any** terminal (it doesn't matter which folder), paste the token when it asks (nothing shows while you paste), then restart the app. Replace `cursor` with the app:

| App | Command ends with | Then |
| --- | --- | --- |
| Claude Code | `bash -s claude-code` | start a new Claude session |
| Cursor | `bash -s cursor` | restart Cursor |
| Antigravity | `bash -s antigravity` | restart Antigravity |
| Copilot (VS Code) | `bash -s copilot` | `Ctrl+Shift+P` → **MCP: List Servers** → `keepcontext` → **Restart** |
| Gemini CLI | `bash -s gemini-cli` | open a new terminal; in each new folder answer **Trust folder** |
| Codex (CLI and VS Code extension) | `bash -s codex` | restart Codex (or reload VS Code for the extension) |

The command downloads a small script **from your own hub** (it contains no secrets), checks the token against the hub, and edits only that app's config. It never prints the token. It needs `bash`, `curl` and Node.js (Claude Code only needs the `claude` command). If a config file has comments it can't safely edit, it changes nothing and tells you to add the entry by hand.

**Windows:** use the manual snippets at the bottom of the Apps tab ("Manual setup reference") and put the token in place of `HUB_TOKEN`.

## 4. Make every project use the hub

Being connected isn't the same as being used: add a short **global instruction** to each app once, telling it to load your context at the start and save decisions back. See README section 4 ("Make every repo use the hub") for the file per app and the text to paste. Nothing is committed to any repo, so this is safe for work repos too.

## 5. Check it works

In the app, ask:

```
Call get_context from keepcontext and list my pinned todos.
Save an idea to keepcontext: "Test from <app>".
```

Then in the hub: the **Overview → Apps** card shows the connection with "last change just now", and the idea shows its badge.

## 6. Rotate, revoke, leaks

| Situation | Do |
| --- | --- |
| A token was pasted somewhere it shouldn't be | **Apps → Rotate** on that connection, then set up only that app again |
| Stop an app or account from using the hub | **Apps → Revoke** |
| The shared `HUB_TOKEN` leaked | Change it in the server's `.env` and restart; apps on their own connections keep working |

Rules of thumb: never paste a token or secret URL into a chat, a screenshot or a file in a repo. If an app prints one, rotate it.

## 7. Troubleshooting

| You see | Cause | Fix |
| --- | --- | --- |
| VS Code: "The MCP server keepcontext requires authentication. Authenticate?" | The token it has is old or wrong (the hub answered 401), so VS Code offers its own sign-in, which the hub doesn't use | **Cancel**, create a Copilot connection, `… \| bash -s copilot`, restart the server |
| The app says the hub tools aren't connected | Not restarted, wrong token, or (Gemini CLI) untrusted folder | Restart the app; check its MCP list (`/mcp` in Claude/Gemini/Codex, Settings → MCP in Cursor, Manage MCP Servers in Antigravity) |
| An agent "updated the hub" but nothing changed on the website | It wrote to a local file instead of using the MCP tools | Make sure the app's MCP list shows `keepcontext` connected; global instructions tell agents never to use a local database |
| Codex in VS Code says the hub tools aren't connected | Set up with an older helper that kept the token in a shell variable, which VS Code opened from the app menu can't see | Run `… \| bash -s codex` again (it now stores the token in `~/.codex/config.toml`), then reload VS Code |
| Codex (or another app with many MCP servers) says the hub isn't connected, but the Apps tab shows it was "last used" just now | The app searches its tools and older hub versions' tools didn't mention "KeepContext" | Fixed in the hub (tool names now start with "KeepContext"); start a **new** chat in the app |
| `rejected this token (HTTP 401)` from the command | Wrong, rotated or revoked token, or a space at the end | Copy the token again from a fresh connection |
| A badge shows a **dashed** outline | Entries from before connections existed (or the shared token): the app name is what the AI reported, not verified | Connect that app with its own connection; new changes get a solid badge |
| "Shared token" in the Apps card | That app still uses `HUB_TOKEN` | Give it its own connection (optional, but you then see its real name) |
