#!/usr/bin/env bash
# Snapshot the hub's database safely while it runs (SQLite VACUUM INTO gives a consistent copy).
#   bash scripts/backup.sh            keep a snapshot in ~/keepcontext-backups (last 14 kept)
#   bash scripts/backup.sh --stdout   also write the snapshot to stdout (the nightly GitHub backup uses this)
# Env overrides: DATA_DIR (else .env, else ./data), BACKUP_DIR, BACKUP_KEEP.
# Messages go to stderr, so --stdout output is only the database file.
set -euo pipefail

main() {
  local app_dir data_dir db out_dir snap keep stdout=0
  [ "${1:-}" = "--stdout" ] && stdout=1
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$app_dir"
  data_dir="${DATA_DIR:-$(grep -E '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2- || true)}"
  data_dir="${data_dir:-./data}"
  case "$data_dir" in /*) ;; *) data_dir="$app_dir/${data_dir#./}" ;; esac
  db="$data_dir/hub.db"
  [ -f "$db" ] || { echo "No database at $db" >&2; exit 1; }
  out_dir="${BACKUP_DIR:-$HOME/keepcontext-backups}"
  keep="${BACKUP_KEEP:-14}"
  mkdir -p "$out_dir" && chmod 700 "$out_dir"
  snap="$out_dir/hub-$(date -u +%Y%m%d-%H%M%S).db"

  umask 077
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const [src, dst] = process.argv.slice(1);
    new DatabaseSync(src, { readOnly: true }).exec(`VACUUM INTO '"'"'${dst.replace(/'"'"'/g, "'"'"''"'"'")}'"'"'`);
    const s = new DatabaseSync(dst, { readOnly: true });
    const ok = s.prepare("PRAGMA integrity_check").get().integrity_check;
    if (ok !== "ok") { console.error("Integrity check failed: " + ok); process.exit(1); }
    const n = s.prepare("SELECT count(*) n FROM entries").get().n;
    console.error(`Snapshot ok: ${n} entries`);
  ' "$db" "$snap"
  chmod 600 "$snap"
  echo "Saved $snap" >&2

  # Keep the newest $keep snapshots.
  ls -1t "$out_dir"/hub-*.db 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f

  [ "$stdout" = 1 ] && cat "$snap"
  return 0
}

main "$@"
