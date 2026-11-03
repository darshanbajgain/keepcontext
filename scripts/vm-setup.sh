#!/usr/bin/env bash
# One-time (and re-runnable) server setup for a Debian/Ubuntu VM (any cloud, or a home server).
# Run on the VM from the cloned repo:  bash scripts/vm-setup.sh
# It installs Node 22, adds 1 GB swap, installs dependencies and a systemd service.
# It does not touch GitHub and does not print secrets.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=/etc/systemd/system/keepcontext.service

echo "==> App folder: $APP_DIR"

# 1 GB swap: small VMs often have 1 GB RAM, so npm and Node get some headroom.
if ! swapon --show | grep -q '/swapfile'; then
  echo "==> Adding 1 GB swap"
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Node 22 (needs >= 22.13 for node:sqlite without a flag).
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' 2>/dev/null; then
  echo "==> Installing Node 22"
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl ca-certificates git >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "==> Node $(node -v)"

cd "$APP_DIR"
echo "==> Installing dependencies"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data

echo "==> Writing systemd service"
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=KeepContext
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) --no-warnings src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable keepcontext >/dev/null 2>&1

if [ -f "$APP_DIR/.env" ]; then
  sudo systemctl restart keepcontext
  sleep 2
  if curl -fsS http://localhost:8787/healthz >/dev/null; then
    echo "==> KeepContext is running on http://localhost:8787"
  else
    echo "!! Service did not answer. Check: journalctl -u keepcontext -n 50"
  fi
else
  echo "==> No .env yet. Upload or create $APP_DIR/.env, then run: sudo systemctl start keepcontext"
fi
