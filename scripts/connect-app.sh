#!/usr/bin/env bash
# Put a connection token (created in the hub's Apps tab) into one app's local config, once:
# the config lives in your home folder, so the app is connected in every project.
#   From any terminal:   curl -fsSL https://YOUR-HUB/connect.sh | bash -s <app>
#   From this repo:      bash scripts/connect-app.sh <app>
#   app: claude-code | cursor | antigravity | gemini-cli | codex | copilot
# The token is pasted invisibly (read from the keyboard), checked against the hub, and never printed.
# For automation only: CONNECT_TOKEN=<token> skips the prompt. Needs bash, curl and (except claude-code) node.
# Web apps (ChatGPT, Claude, Gemini) are set up in their own UI (the Apps tab shows how).
set -euo pipefail

main() {
  local app="${1:-}" repo url token code
  # Only set when run from a checkout of this repo (not when piped from the hub).
  repo=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "$(dirname "${BASH_SOURCE[0]}")/connect-app.sh" ]; then
    repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  fi
  url="${HUB_URL:-http://localhost:8787}"
  case "$app" in
    claude-code|cursor|antigravity|gemini-cli|codex|copilot) ;;
    *) echo "Usage: … | bash -s <claude-code|cursor|antigravity|gemini-cli|codex|copilot>"; exit 1 ;;
  esac
  if [ "$app" = "claude-code" ]; then
    command -v claude >/dev/null || { echo "Claude Code (claude) isn't installed. Nothing changed."; exit 1; }
  else
    command -v node >/dev/null || { echo "This needs Node.js to edit the app's config. Install Node, or use the manual config shown in the hub's Apps tab. Nothing changed."; exit 1; }
  fi

  if [ -n "${CONNECT_TOKEN:-}" ]; then
    token="$CONNECT_TOKEN"
  elif { exec 3</dev/tty; } 2>/dev/null; then
    # Read from the keyboard: when piped (curl … | bash), standard input is the script itself.
    read -rsp "Paste the ${app} connection token (input hidden): " token <&3; echo; exec 3<&-
  else
    read -rsp "Paste the ${app} connection token (input hidden): " token; echo
  fi
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  [[ "$token" =~ ^chub_[0-9a-f]{64}$ ]] || { echo "That isn't a connection token (chub_…). Nothing changed."; exit 1; }
  code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url/api/entries?limit=1")"
  [ "$code" = "200" ] || { echo "The hub at $url rejected this token (HTTP $code). Nothing changed."; exit 1; }
  echo "The hub accepts the token."

  if [ "$app" = "claude-code" ]; then
    claude mcp remove keepcontext -s user >/dev/null 2>&1 || true
    claude mcp add --transport http --scope user keepcontext "$url/mcp" --header "Authorization: Bearer $token" >/dev/null 2>&1
    # Inside this repo, a local override wins over the user-wide entry, so update it too.
    if [ -n "$repo" ] && (cd "$repo" && claude mcp get keepcontext 2>/dev/null | grep -q 'Local config'); then
      (cd "$repo" && { claude mcp remove keepcontext -s local >/dev/null 2>&1 || true; }
       claude mcp add --transport http --scope local keepcontext "$url/mcp" --header "Authorization: Bearer $token" >/dev/null 2>&1)
    fi
    echo "Updated Claude Code (all projects). Start a new Claude session."
    return
  fi

  umask 077
  NEW_TOKEN="$token" APP="$app" MCP_URL="$url/mcp" node - <<'EOF'
const fs = require('fs');
const H = process.env.HOME, tok = process.env.NEW_TOKEN, app = process.env.APP, url = process.env.MCP_URL;
// Never overwrite a config we can't parse (it may have comments): stop and say how to do it by hand.
const readJson = (f) => {
  if (!fs.existsSync(f)) return {};
  const t = fs.readFileSync(f, 'utf8');
  if (!t.trim()) return {};
  try { return JSON.parse(t); } catch {
    console.log(`Couldn't parse ${f} (comments?). Nothing changed; add the keepcontext entry by hand (see the hub's Apps tab).`);
    process.exit(1);
  }
};
const writeJson = (f, j, mode) => { fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n', mode ? { mode } : {}); if (mode) fs.chmodSync(f, mode); };
// Per-app token variables live in one private env file that ~/.bashrc loads.
const setEnv = (name) => {
  const f = `${H}/.config/keepcontext/env`;
  fs.mkdirSync(`${H}/.config/keepcontext`, { recursive: true });
  let s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const line = `export ${name}=${tok}`;
  s = new RegExp(`^export ${name}=.*$`, 'm').test(s) ? s.replace(new RegExp(`^export ${name}=.*$`, 'm'), line) : `${s.replace(/\n?$/, '\n')}${line}\n`;
  fs.writeFileSync(f, s, { mode: 0o600 }); fs.chmodSync(f, 0o600);
  // Make new terminals load it (bash and zsh).
  for (const rc of [`${H}/.bashrc`, `${H}/.zshrc`]) {
    if (rc.endsWith('.zshrc') && !fs.existsSync(rc)) continue;
    const cur = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    if (!cur.includes('.config/keepcontext/env')) fs.appendFileSync(rc, '\n# KeepContext tokens for MCP clients\n[ -f ~/.config/keepcontext/env ] && . ~/.config/keepcontext/env\n');
  }
};
if (app === 'cursor') {
  const f = `${H}/.cursor/mcp.json`, j = readJson(f);
  j.mcpServers = { ...(j.mcpServers || {}), 'keepcontext': { url, headers: { Authorization: `Bearer ${tok}` } } };
  writeJson(f, j, 0o600); console.log('Updated ~/.cursor/mcp.json. Restart Cursor.');
}
if (app === 'antigravity') {
  const f = `${H}/.gemini/antigravity/mcp_config.json`, j = readJson(f);
  j.mcpServers = { ...(j.mcpServers || {}), 'keepcontext': { serverUrl: url, headers: { Authorization: `Bearer ${tok}` } } };
  writeJson(f, j, 0o600); console.log('Updated Antigravity mcp_config.json. Restart Antigravity.');
}
if (app === 'gemini-cli') {
  setEnv('KEEPCONTEXT_TOKEN_GEMINI_CLI');
  const f = `${H}/.gemini/settings.json`, j = readJson(f);
  j.mcpServers = { ...(j.mcpServers || {}), 'keepcontext': { httpUrl: url, headers: { Authorization: 'Bearer ${KEEPCONTEXT_TOKEN_GEMINI_CLI}' }, timeout: 30000 } };
  writeJson(f, j); console.log('Updated Gemini CLI (token in ~/.config/keepcontext/env). Open a new terminal.');
}
if (app === 'copilot') {
  // VS Code user MCP config. It may contain comments (JSONC); if it doesn't parse, stop rather than drop other servers.
  // macOS keeps it under ~/Library/Application Support/Code/User.
  const f = process.platform === 'darwin' ? `${H}/Library/Application Support/Code/User/mcp.json` : `${H}/.config/Code/User/mcp.json`;
  const j = readJson(f);
  j.servers = { ...(j.servers || {}), 'keepcontext': { type: 'http', url, headers: { Authorization: `Bearer ${tok}` } } };
  // The old prompt-for-token input isn't needed any more.
  if (Array.isArray(j.inputs)) j.inputs = j.inputs.filter((i) => i.id !== 'hubToken');
  writeJson(f, j, 0o600);
  console.log('Updated VS Code mcp.json. In VS Code: Ctrl+Shift+P → MCP: List Servers → keepcontext → Restart.');
}
if (app === 'codex') {
  // A fixed header in config.toml (not an env var): the Codex VS Code extension doesn't see shell variables
  // when VS Code is opened from the app menu. The file is private (600).
  const f = `${H}/.codex/config.toml`;
  let s = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const block = `[mcp_servers.keepcontext]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${tok}" }\n`;
  s = /\[mcp_servers\.keepcontext\][^\[]*/.test(s) ? s.replace(/\[mcp_servers\.keepcontext\][^\[]*/, block + '\n') : `${s.replace(/\n?$/, '\n')}\n${block}`;
  fs.mkdirSync(`${H}/.codex`, { recursive: true }); fs.writeFileSync(f, s, { mode: 0o600 }); fs.chmodSync(f, 0o600);
  console.log('Updated Codex (~/.codex/config.toml). Restart Codex (CLI or the VS Code extension).');
}
EOF
}

main "$@"
