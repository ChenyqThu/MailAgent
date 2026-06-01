#!/bin/bash
# MailAgent V2 远程访问 — cloudflared tunnel 引导脚本
# ---------------------------------------------------------------------------
# 把本机 FastAPI (mailagent serve-api, 127.0.0.1:8200) 经 Cloudflare Tunnel
# 暴露到公网域名 mail.chenge.ink，并用 pm2 常驻 tunnel 进程。
#
# 设计原则 (见 frontend/REMOTE-ACCESS.md §6.1 / §12):
#   - tunnel 独立于 Electron 主进程常驻 (MacBook 不开 app 时 tunnel 仍要活)，
#     所以用 pm2 托管，而不是塞进 BackendLifecycleManager。
#   - 需要浏览器交互的步骤 (cloudflared tunnel login) 本脚本不硬跑，而是检测
#     凭据是否就位 + 打印指引，让用户手动完成后重跑。
#
# Usage:
#   bash scripts/v2-tunnel-setup.sh           # 引导式逐步执行 (推荐首次)
#   bash scripts/v2-tunnel-setup.sh --check   # 仅做前置检查，不改任何状态
#
# 幂等: tunnel / DNS 已存在时跳过创建，不会重复建。
# ---------------------------------------------------------------------------

set -euo pipefail

# --- 可调参数 (改这里即可) ---
TUNNEL_NAME="mailagent-local"
HOSTNAME="mail.chenge.ink"
API_PORT="${MAILAGENT_API_PORT:-8200}"
PM2_NAME="mailagent-tunnel"
CF_DIR="${HOME}/.cloudflared"
CONFIG_PATH="${CF_DIR}/config.yml"

CHECK_ONLY=0
if [ "${1:-}" = "--check" ]; then
    CHECK_ONLY=1
fi

# --- 小工具 ---
say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [OK] %s\n' "$*"; }
warn() { printf '    [!!] %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ===========================================================================
# 前置检查
# ===========================================================================
say "前置检查"

command -v cloudflared >/dev/null 2>&1 || die "未找到 cloudflared。先装: brew install cloudflared"
ok "cloudflared: $(cloudflared --version 2>/dev/null | head -1)"

command -v pm2 >/dev/null 2>&1 || die "未找到 pm2。先装: npm install -g pm2"
ok "pm2: $(pm2 --version 2>/dev/null)"

# serve-api 是否在本地 8200 监听 (tunnel 起来前最好先有源)。
if curl -fsS -m 3 "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
    ok "serve-api 已在 127.0.0.1:${API_PORT} 响应 /api/health"
else
    warn "serve-api 未在 127.0.0.1:${API_PORT} 响应。tunnel 可以先建，但真机访问前"
    warn "需先起 serve-api (打包 app 自动经 BackendLifecycle 拉起，或 dev 用:"
    warn "  pm2 start 'mailagent serve-api' --name mailagent-api --interpreter ./venv/bin/python3)"
fi

# 登录凭据 (cert.pem 来自 cloudflared tunnel login)。
if [ ! -f "${CF_DIR}/cert.pem" ]; then
    say "需要先登录 Cloudflare (本脚本不代跑，因为要浏览器授权)"
    cat <<EOF
    请手动执行下面这条命令，按提示在浏览器里授权你的 Cloudflare 账号:

        cloudflared tunnel login

    它会把 cert.pem 落到 ${CF_DIR}/cert.pem。
    完成后重跑本脚本。
EOF
    die "缺少 ${CF_DIR}/cert.pem (cloudflared tunnel login 未完成)"
fi
ok "登录凭据就位: ${CF_DIR}/cert.pem"

if [ "$CHECK_ONLY" -eq 1 ]; then
    say "--check 模式: 前置检查通过，未改动任何状态。"
    exit 0
fi

# ===========================================================================
# Step 1: 创建 tunnel (幂等)
# ===========================================================================
say "Step 1: 创建 tunnel '${TUNNEL_NAME}' (已存在则跳过)"

if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "${TUNNEL_NAME}"; then
    ok "tunnel '${TUNNEL_NAME}' 已存在，跳过创建"
else
    cloudflared tunnel create "${TUNNEL_NAME}"
    ok "已创建 tunnel '${TUNNEL_NAME}'"
fi

# 取 UUID (供 config.yml 填充提示)。
TUNNEL_UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="${TUNNEL_NAME}" '$2==n {print $1}' | head -1)"
[ -n "${TUNNEL_UUID}" ] || die "无法解析 tunnel UUID，检查 cloudflared tunnel list 输出"
ok "tunnel UUID: ${TUNNEL_UUID}"

# ===========================================================================
# Step 2: 确认 config.yml (ingress → 127.0.0.1:API_PORT)
# ===========================================================================
say "Step 2: 确认 ${CONFIG_PATH}"

if [ ! -f "${CONFIG_PATH}" ]; then
    warn "未找到 ${CONFIG_PATH}。请从模板复制并填好 UUID:"
    warn "  cp deploy/cloudflared/config.yml.example ${CONFIG_PATH}"
    warn "  # 把 <TUNNEL_UUID> 替换为: ${TUNNEL_UUID}"
    warn "  # 确认 ingress service 端口 = ${API_PORT}"
    die "config.yml 缺失，填好后重跑"
fi

if grep -q "<TUNNEL_UUID>" "${CONFIG_PATH}"; then
    die "${CONFIG_PATH} 仍含占位符 <TUNNEL_UUID>，请替换为 ${TUNNEL_UUID} 后重跑"
fi

if ! grep -q "127.0.0.1:${API_PORT}" "${CONFIG_PATH}"; then
    warn "${CONFIG_PATH} 的 ingress 未指向 127.0.0.1:${API_PORT}"
    warn "确认 service 端口与 MAILAGENT_API_PORT (${API_PORT}) 一致后重跑"
    die "config.yml ingress 端口不匹配"
fi
ok "config.yml 就位，ingress → http://127.0.0.1:${API_PORT}"

# ===========================================================================
# Step 3: 配 DNS (route dns，幂等)
# ===========================================================================
say "Step 3: 路由 DNS ${HOSTNAME} → tunnel"

# route dns 对已存在的记录会报错；用 || 吞掉并提示，不让脚本中断。
if cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME}" 2>/tmp/cf_route_dns.log; then
    ok "已创建 DNS 路由 ${HOSTNAME} → ${TUNNEL_NAME}"
else
    if grep -qi "already exists\|record with that host" /tmp/cf_route_dns.log; then
        ok "DNS 路由 ${HOSTNAME} 已存在，跳过"
    else
        warn "route dns 失败，详情:"
        cat /tmp/cf_route_dns.log >&2
        die "DNS 路由失败 (可能 ${HOSTNAME} 的 zone 不在该 CF 账号下)"
    fi
fi

# ===========================================================================
# Step 4: pm2 常驻 tunnel
# ===========================================================================
say "Step 4: pm2 启动/重启 '${PM2_NAME}'"

if pm2 describe "${PM2_NAME}" >/dev/null 2>&1; then
    pm2 restart "${PM2_NAME}"
    ok "已 pm2 restart ${PM2_NAME}"
else
    pm2 start cloudflared --name "${PM2_NAME}" -- tunnel run "${TUNNEL_NAME}"
    ok "已 pm2 start ${PM2_NAME}"
fi

pm2 save
ok "已 pm2 save (持久化进程列表)"

say "建议: 配置开机自启 (减少 MacBook 重启后 tunnel 没起的概率)"
cat <<EOF
    pm2 startup        # 按输出提示执行它打印的那条命令 (可能需 sudo，但本机无 sudo
                       #  时改用 launchd / 登录项手动拉起 pm2 resurrect)
    # 防锁屏导致进程被挂起，配合常驻保活脚本:
    python3 scripts/keep_alive.py daemon
EOF

# ===========================================================================
# 收尾验证
# ===========================================================================
say "收尾验证"

pm2 status "${PM2_NAME}" | tail -5 || true

cat <<EOF

下一步 (本脚本不覆盖，见 runbook / docs/v2-cloudflare-access-setup.md):
  - 在 Cloudflare Zero Trust dashboard 配 Access policy (Self-hosted app +
    Google OAuth + 邮箱白名单 + 复制 Audience Tag → 填 .env CF_AUDIENCE)。
  - 配好 .env 远程访问段后重启 serve-api，让 auth.py 读到 CF_AUDIENCE。
  - 验证公网可达: curl -I https://${HOSTNAME}/api/health
    (会经 CF Access 重定向到登录页，属预期；OAuth 后才放行 JSON)。

EOF

echo "Done."
