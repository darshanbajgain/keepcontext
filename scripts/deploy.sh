#!/usr/bin/env bash
# Update a server install to the latest main, by hand or from your own CI:
#   bash ~/keepcontext/scripts/deploy.sh
# Steps: fast-forward to origin/main → npm ci (only if dependencies changed) → restart the service →
# wait for /healthz → if it never gets healthy, roll back to the previous commit and restart again.
# Never prints secrets. Only reads from GitHub (git fetch).
set -euo pipefail

# Everything is inside main() so bash reads the whole script before running it:
# the merge below may replace this very file.
main() {
  local app_dir port prev next
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$app_dir"
  port="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
  port="${port:-8787}"

  # One deploy at a time.
  exec 9>/tmp/keepcontext-deploy.lock
  flock -n 9 || { echo "Another deploy is already running."; exit 1; }

  healthy() {
    for _ in $(seq 1 30); do
      curl -fsS "http://localhost:${port}/healthz" >/dev/null 2>&1 && return 0
      sleep 1
    done
    return 1
  }
  restart() { sudo systemctl restart keepcontext; }
  install() { npm ci --omit=dev --no-audit --no-fund --loglevel=error; }

  prev="$(git rev-parse HEAD)"
  git fetch --quiet origin main
  next="$(git rev-parse origin/main)"

  if [ "$prev" = "$next" ]; then
    echo "Already up to date: $(git log -1 --format='%h %s')"
    if healthy; then echo "Service is healthy."; exit 0; fi
    echo "Service is not healthy; restarting." >&2
    restart
    healthy && { echo "Healthy after restart."; exit 0; }
    journalctl -u keepcontext -n 30 --no-pager >&2 || true
    exit 1
  fi

  echo "Deploying $(git log -1 --format='%h %s' "$next") (was ${prev:0:7})"
  git merge --ff-only --quiet origin/main

  if git diff --quiet "$prev" "$next" -- package.json package-lock.json; then
    echo "Dependencies unchanged; skipping npm ci."
  else
    echo "Dependencies changed; running npm ci."
    install
  fi
  restart

  if healthy; then
    echo "Deployed $(git rev-parse --short HEAD) and healthy."
    return 0
  fi

  echo "Health check failed. Last log lines:" >&2
  journalctl -u keepcontext -n 30 --no-pager >&2 || true
  echo "Rolling back to ${prev:0:7}…" >&2
  git reset --hard --quiet "$prev"
  install
  restart
  if healthy; then echo "Rolled back to ${prev:0:7}; the service is healthy on the old version." >&2; else echo "Rollback also unhealthy. Check: journalctl -u keepcontext -n 100" >&2; fi
  exit 1
}

main "$@"
