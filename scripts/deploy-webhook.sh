#!/bin/bash
# 一键部署 webhook-server 到远程服务器
# Usage: ./scripts/deploy-webhook.sh

set -e

SERVER="170.106.181.89"
USER="ubuntu"
REMOTE_DIR="/opt/MailAgent"

echo "Deploying webhook-server to $SERVER..."
ssh -o StrictHostKeyChecking=no "$USER@$SERVER" << 'REMOTE_SCRIPT'
set -e
cd /opt/MailAgent

echo "==> git pull"
git pull

cd webhook-server

# 确保 venv 存在，兼容不同 Python 版本
if [ ! -d "venv" ]; then
    echo "==> Creating venv..."
    python3 -m venv venv
fi

echo "==> Python version: $(./venv/bin/python3 --version)"

echo "==> Installing dependencies..."
./venv/bin/pip install -r requirements.txt -q

echo "==> Restarting PM2..."
pm2 restart mailagent-webhook
pm2 status mailagent-webhook

echo "==> Deploy complete!"
REMOTE_SCRIPT

echo "Done."
