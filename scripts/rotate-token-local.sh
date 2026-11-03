#!/usr/bin/env bash
# After changing HUB_TOKEN on the server, update every MCP client config on this laptop.
# The token is typed/pasted invisibly and never printed. Run from the repo folder:
#   bash scripts/rotate-token-local.sh
# Web connectors (claude.ai, ChatGPT, Gemini) and VS Code's stored input are updated by hand (it lists them at the end).
set -euo pipefail

main() {
  local repo url token code
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  url="${HUB_URL:-http://localhost:8787}"

  read -rsp "Paste the NEW HUB_TOKEN (input hidden): " token; echo
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  [[ "$token" =~ ^[0-9a-f]{32,}$ ]] || { echo "That doesn't look like a hex token; nothing changed."; exit 1; }

  code="$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url/api/status")"
  [ "$code" = "200" ] || { echo "The live hub rejected this token (HTTP $code). Did you restart the server after changing it? Nothing changed."; exit 1; }
  echo "Live hub accepts the new token."

  export NEW_TOKEN="$token" REPO="$repo" HUB_URL_BASE="$url"
  node - <<'EOF'
const fs = require('fs');
const H = process.env.HOME, tok = process.env.NEW_TOKEN, repo = process.env.REPO, url = process.env.HUB_URL_BASE;
const setLine = (file, key, value) => {
  if (!fs.existsSync(file)) return false;
  const s = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^(export )?${key}=.*$`, 'm');
  fs.writeFileSync(file, re.test(s) ? s.replace(re, (m, ex) => `${ex || ''}${key}=${value}`) : s + `\n${key}=${value}\n`);
  return true;
};
const setHeader = (file, pick) => {
  if (!fs.existsSync(file)) return false;
  const j = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  const srv = pick(j);
  if (!srv) return false;
  srv.headers = { ...(srv.headers || {}), Authorization: `Bearer ${tok}` };
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return true;
};
const done = [];
if (setLine(`${repo}/.env`, 'HUB_TOKEN', tok)) done.push('repo .env');
if (setLine(`${H}/.config/keepcontext/env`, 'HUB_TOKEN', tok)) done.push('~/.config/keepcontext/env (Gemini CLI, Codex, .mcp.json)');
if (setHeader(`${H}/.gemini/antigravity/mcp_config.json`, (j) => j.mcpServers?.['keepcontext'])) done.push('Antigravity');
if (setHeader(`${H}/.cursor/mcp.json`, (j) => j.mcpServers?.['keepcontext'])) done.push('Cursor');
console.log('Updated: ' + done.join(', '));
EOF

  if command -v claude >/dev/null; then
    claude mcp remove keepcontext -s user >/dev/null 2>&1 || true
    claude mcp add --transport http --scope user keepcontext "$url/mcp" --header "Authorization: Bearer $token" >/dev/null 2>&1
    (cd "$repo" && claude mcp remove keepcontext -s local >/dev/null 2>&1 || true
     claude mcp add --transport http --scope local keepcontext "$url/mcp" --header "Authorization: Bearer $token" >/dev/null 2>&1)
    echo "Updated: Claude Code (user scope + this repo)"
  fi
  unset NEW_TOKEN token

  cat <<'TXT'

Still to update by hand (the old token stops working everywhere):
  - claude.ai, ChatGPT, Gemini connectors: replace the secret URL  …/mcp/k/<NEW TOKEN>
    (Claude Pro header connector: replace the Authorization header value)
  - VS Code Copilot: Ctrl+Shift+P → "MCP: List Servers" → keepcontext → restart; enter the new token when asked
    (if it doesn't ask, open your user mcp.json and use the "hubToken" input's edit/clear action)
  - Restart Antigravity and Cursor; open a new terminal for the CLIs.
TXT
}

main "$@"
