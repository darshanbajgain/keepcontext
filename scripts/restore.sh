#!/usr/bin/env bash
# Restore the hub's database from a snapshot (run on the server):
#   bash scripts/restore.sh ~/keepcontext-backups/hub-20261028-203000.db
# Checks the file, stops the hub, keeps the current database as a "pre-restore" copy, swaps in the snapshot,
# starts the hub and checks /healthz. If the hub doesn't come back, it puts the old database back.
set -euo pipefail

main() {
  local src="${1:-}" app_dir data_dir db port keep_dir saved
  [ -n "$src" ] && [ -f "$src" ] || { echo "Usage: bash scripts/restore.sh <snapshot.db>"; exit 1; }
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$app_dir"
  data_dir="${DATA_DIR:-$(grep -E '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2- || true)}"
  data_dir="${data_dir:-./data}"
  case "$data_dir" in /*) ;; *) data_dir="$app_dir/${data_dir#./}" ;; esac
  db="$data_dir/hub.db"
  port="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || true)"; port="${port:-8787}"
  keep_dir="${BACKUP_DIR:-$HOME/keepcontext-backups}"
  mkdir -p "$keep_dir" && chmod 700 "$keep_dir"

  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const s = new DatabaseSync(process.argv[1], { readOnly: true });
    const ok = s.prepare("PRAGMA integrity_check").get().integrity_check;
    if (ok !== "ok") { console.error("Snapshot is damaged: " + ok); process.exit(1); }
    console.log(`Snapshot ok: ${s.prepare("SELECT count(*) n FROM entries").get().n} entries`);
  ' "$src"

  healthy() { for _ in $(seq 1 30); do curl -fsS "http://localhost:${port}/healthz" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }

  echo "Stopping the hub…"
  sudo systemctl stop keepcontext
  saved="$keep_dir/pre-restore-$(date -u +%Y%m%d-%H%M%S).db"
  [ -f "$db" ] && mv "$db" "$saved" && echo "Current database kept as $saved"
  rm -f "$db-wal" "$db-shm"
  install -m 600 "$src" "$db"
  sudo systemctl start keepcontext

  if healthy; then
    echo "Restored from $src; the hub is healthy."
  else
    echo "The hub didn't come back; putting the previous database back." >&2
    sudo systemctl stop keepcontext
    [ -f "$saved" ] && mv "$saved" "$db"
    sudo systemctl start keepcontext
    exit 1
  fi
}

main "$@"
