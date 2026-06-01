#!/bin/bash
# MailAgent V2 远程访问 — Cloudflare Pages 部署脚本 (web 静态产物)
# ---------------------------------------------------------------------------
# 构建 frontend web 产物 (pnpm build:web → frontend/out/web) 并推到
# Cloudflare Pages，对外经自定义域 mail.chenge.ink 的 /app/* 提供静态资源
# (与 cloudflared tunnel 的 /api/* → 8200 路由互补)。
#
# 两条上传路径，按可用性自动选择:
#   1. wrangler pages deploy (推荐，无需 CI，直传产物目录)。
#   2. gh-pages 分支 (fallback，把 out/web 推到 gh-pages 供 CF Pages Git 集成)。
#
# Usage:
#   bash scripts/v2-pages-deploy.sh                # 自动选路径 (优先 wrangler)
#   bash scripts/v2-pages-deploy.sh --wrangler     # 强制 wrangler 直传
#   bash scripts/v2-pages-deploy.sh --gh-pages     # 强制 gh-pages 分支
#   bash scripts/v2-pages-deploy.sh --build-only   # 只构建，不部署
#
# 详见 frontend/REMOTE-ACCESS.md §7 与 docs/v2-cloudflare-access-setup.md。
# ---------------------------------------------------------------------------

set -euo pipefail

# --- 可调参数 ---
PROJECT_NAME="mailagent-web"
GH_PAGES_BRANCH="gh-pages"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
FRONTEND_DIR="${REPO_ROOT}/frontend"
OUT_DIR="${FRONTEND_DIR}/out/web"

MODE="auto"
case "${1:-}" in
    --wrangler)   MODE="wrangler" ;;
    --gh-pages)   MODE="gh-pages" ;;
    --build-only) MODE="build-only" ;;
    "")           MODE="auto" ;;
    *)            echo "ERROR: 未知参数 '$1' (支持 --wrangler/--gh-pages/--build-only)" >&2; exit 1 ;;
esac

# --- 小工具 ---
say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '    [OK] %s\n' "$*"; }
warn() { printf '    [!!] %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ===========================================================================
# 前置检查
# ===========================================================================
say "前置检查"

[ -d "${FRONTEND_DIR}" ] || die "未找到 frontend 目录: ${FRONTEND_DIR}"
ok "frontend: ${FRONTEND_DIR}"

command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm。先装: npm install -g pnpm"
ok "pnpm: $(pnpm --version 2>/dev/null)"

# build:web 脚本是否存在 (防呆，避免构建报错才发现没这个 script)。
if ! grep -q '"build:web"' "${FRONTEND_DIR}/package.json" 2>/dev/null; then
    die "frontend/package.json 缺少 build:web 脚本，无法构建 web 产物"
fi
ok "package.json 含 build:web 脚本"

# ===========================================================================
# Step 1: 构建 web 产物
# ===========================================================================
say "Step 1: 构建 web 产物 (pnpm build:web → out/web)"

# 在 frontend 目录里跑 pnpm，不 cd 主进程 (用 --dir 显式指定工作目录)。
pnpm --dir "${FRONTEND_DIR}" build:web

[ -d "${OUT_DIR}" ] || die "构建后未生成产物目录: ${OUT_DIR}"
[ -f "${OUT_DIR}/index.html" ] || warn "产物目录无 index.html (检查 outDir / base 配置)"
ok "产物就位: ${OUT_DIR}"

if [ "${MODE}" = "build-only" ]; then
    say "--build-only 模式: 已构建产物，未部署。"
    echo "Done."
    exit 0
fi

# ===========================================================================
# Step 2: 部署 (wrangler 优先，gh-pages fallback)
# ===========================================================================
deploy_wrangler() {
    say "Step 2: wrangler pages deploy → 项目 '${PROJECT_NAME}'"
    # 用 npx 调 wrangler，无需全局装；首次会提示登录 (cloudflared login 不通用，
    # wrangler 用自己的 OAuth: npx wrangler login)。
    if ! npx --yes wrangler pages deploy "${OUT_DIR}" --project-name "${PROJECT_NAME}"; then
        die "wrangler 部署失败。若是未登录: npx wrangler login；或改用 --gh-pages"
    fi
    ok "wrangler 部署完成"
}

deploy_gh_pages() {
    say "Step 2: gh-pages 分支部署 (推 out/web → ${GH_PAGES_BRANCH})"
    command -v git >/dev/null 2>&1 || die "未找到 git"

    # 用 git subtree split + force push 把 out/web 当作 gh-pages 分支根。
    # 注意: out/web 通常被 gitignore，subtree 要求内容已提交，故这里走临时
    # worktree 方案，避免污染当前工作区。
    local tmp_branch="__pages_deploy_tmp_$$"
    local tmp_worktree
    tmp_worktree="$(mktemp -d)"

    say "  准备临时 worktree: ${tmp_worktree}"
    git -C "${REPO_ROOT}" worktree add --detach "${tmp_worktree}" >/dev/null 2>&1 \
        || die "git worktree add 失败"

    # 清空临时 worktree 内容，铺入构建产物。
    find "${tmp_worktree}" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} + 2>/dev/null || true
    cp -R "${OUT_DIR}/." "${tmp_worktree}/"

    # SPA fallback: Pages 需要 404 回 index.html (无 _redirects 时拷一份)。
    [ -f "${tmp_worktree}/index.html" ] && cp "${tmp_worktree}/index.html" "${tmp_worktree}/404.html"

    (
        cd "${tmp_worktree}"
        git checkout --orphan "${tmp_branch}" >/dev/null 2>&1
        git add -A
        git commit -m "deploy: web build $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
        git push -f origin "HEAD:${GH_PAGES_BRANCH}"
    ) || { git -C "${REPO_ROOT}" worktree remove --force "${tmp_worktree}" 2>/dev/null || true; die "gh-pages 推送失败"; }

    git -C "${REPO_ROOT}" worktree remove --force "${tmp_worktree}" 2>/dev/null || true
    ok "已推送到 ${GH_PAGES_BRANCH} 分支 (CF Pages Git 集成会自动构建发布)"
}

case "${MODE}" in
    wrangler)
        command -v npx >/dev/null 2>&1 || die "未找到 npx (随 Node.js 安装)"
        deploy_wrangler
        ;;
    gh-pages)
        deploy_gh_pages
        ;;
    auto)
        if command -v npx >/dev/null 2>&1; then
            ok "自动选路: 检测到 npx → 用 wrangler 直传"
            deploy_wrangler
        else
            warn "未检测到 npx，回退 gh-pages 分支方案"
            deploy_gh_pages
        fi
        ;;
esac

# ===========================================================================
# 收尾提示
# ===========================================================================
cat <<EOF

下一步 (见 docs/v2-cloudflare-access-setup.md):
  - 在 CF Pages 项目设置里绑定自定义域 mail.chenge.ink，并配 path 路由:
    静态资源 (/app/*) 走 Pages，/api/* 走 cloudflared tunnel (→ 127.0.0.1:8200)。
    web 产物 base=/app/，与 ingress 互补。
  - 确认 Access policy 覆盖 mail.chenge.ink (含 /app/* 与 /api/*)。
  - 真机验收: iOS Safari 开 https://mail.chenge.ink/app → CF Access OAuth →
    添加到主屏幕 → 验图标启动无地址栏。

EOF

echo "Done."
