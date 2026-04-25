#!/bin/bash
# 一键部署 webhook-server 到远程服务器
# Usage: ./scripts/deploy-webhook.sh
#
# 用 rsync 推送本地 webhook-server/ 到远端（远端不依赖 git 仓库）。
# 排除 venv / __pycache__ / logs / .env，保护远端运行时状态。

set -euo pipefail

SERVER="170.106.181.89"
USER="ubuntu"
REMOTE_DIR="/opt/MailAgent/webhook-server"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="$(cd "$SCRIPT_DIR/../webhook-server" && pwd)"

if [ ! -d "$LOCAL_DIR" ]; then
    echo "ERROR: local webhook-server dir not found: $LOCAL_DIR" >&2
    exit 1
fi

echo "==> Syncing $LOCAL_DIR -> $USER@$SERVER:$REMOTE_DIR"
rsync -avz --delete \
    --exclude='venv/' \
    --exclude='__pycache__/' \
    --exclude='logs/' \
    --exclude='.env' \
    --exclude='.env.local' \
    --exclude='*.pyc' \
    -e "ssh -o StrictHostKeyChecking=no" \
    "$LOCAL_DIR/" "$USER@$SERVER:$REMOTE_DIR/"

echo "==> Installing deps + restarting PM2 on remote"
ssh -o StrictHostKeyChecking=no "$USER@$SERVER" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
cd /opt/MailAgent/webhook-server

if [ ! -d venv ]; then
    echo "==> Creating venv..."
    python3 -m venv venv
fi

echo "==> Python: $(./venv/bin/python3 --version)"
echo "==> pip install -r requirements.txt"
./venv/bin/pip install -r requirements.txt -q

echo "==> pm2 restart mailagent-webhook"
pm2 restart mailagent-webhook
pm2 status mailagent-webhook | tail -5

echo "==> Deploy complete!"
REMOTE_SCRIPT

echo "Done."
