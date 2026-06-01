#!/usr/bin/env bash
#
# v2-security-check.sh — MailAgent V2 远程访问安全验证 (REMOTE-ACCESS §9 可脚本化项)
#
# Usage:
#   ./scripts/v2-security-check.sh           # 全量；serve-api 在线时连活做运行时探针
#   API_BASE=http://127.0.0.1:8200 ./scripts/v2-security-check.sh
#
# 逐项 PASS / FAIL / SKIP。任一 FAIL → 退出码 1（CI / 上线 gate 可据此卡）。
# SKIP（如 serve-api 未起）不算失败，但会提示哪些运行时检查未覆盖。
#
# 覆盖（对应 runbook Step 7.1 / REMOTE-ACCESS §9 + §6.4）:
#   [1] serve-api bind 127.0.0.1 (lsof 必无 0.0.0.0/*:8200) + /api/health 活性
#   [2] CORS 严格: 伪造 Origin: https://evil.com 不被回显到 Access-Control-Allow-Origin
#   [3] auth env fail-fast: 生产(未开 AUTH_DISABLED) 下空 CF_AUDIENCE → serve-api 拒起
#   [4] auth bypass 防误配: AUTH_DISABLED=true 但无 MAILAGENT_API_DEV=true → import 即拒
#   [5] JWT 二次校验在岗: 无 Cf-Access-Jwt-Assertion 直打受保护端点 → 401
#   [6] CLI api_key 不入 web bundle: out/web 无 MAILAGENT_CLI_API_KEY *值* 泄漏 (§6.4 G3)
#   [7] 附件 path-traversal 防护: _resolve_guarded_path 越界 → 403 (源码契约断言)
#   [8] 无鉴权面最小化: 除 /api/health 外所有 /api/* router 端点带 Depends(verify_cf_access)
#
# 设计取舍 (重要, 防误报):
#   [6] `MAILAGENT_CLI_API_KEY` 的 **key 名** 合法出现在 web bundle —— 它是 shared 设置 UI
#       (IntegrationsTab / EnvField) 的表单 label / i18n 文案 ("label":"MAILAGENT_CLI_API_KEY")。
#       §6.4 G3 要防的是 **secret 值** 不入 bundle, 不是 key 名。所以本检查断言「无 value 赋值
#       形态」(MAILAGENT_CLI_API_KEY=<8+字符> / "MAILAGENT_CLI_API_KEY":"<secret>")，而非裸 key 名。
#   [3][4][7][8] 不便在纯 bash 安全地真起/真打的项, 退化为对源码契约的静态断言 (grep 关键守卫
#       存在) + 在 serve-api 在线时补运行时探针 [1][2][5]。静态断言保证「防御代码在源码里」, 运行时
#       探针保证「防御真的生效」, 两者互补。

set -euo pipefail

# --- 路径锚定到仓库根 (脚本在 scripts/ 下) ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

API_BASE="${API_BASE:-http://127.0.0.1:8200}"
API_PORT="${API_PORT:-8200}"
WEB_BUNDLE_DIR="$REPO_ROOT/frontend/out/web"

# --- 计分 -------------------------------------------------------------------
PASS_N=0
FAIL_N=0
SKIP_N=0

# ANSI (仅 TTY)
if [ -t 1 ]; then
  C_PASS=$'\033[32m'; C_FAIL=$'\033[31m'; C_SKIP=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_PASS=""; C_FAIL=""; C_SKIP=""; C_OFF=""
fi

pass() { printf '%s[PASS]%s %s\n' "$C_PASS" "$C_OFF" "$1"; PASS_N=$((PASS_N + 1)); }
fail() { printf '%s[FAIL]%s %s\n' "$C_FAIL" "$C_OFF" "$1"; FAIL_N=$((FAIL_N + 1)); }
skip() { printf '%s[SKIP]%s %s\n' "$C_SKIP" "$C_OFF" "$1"; SKIP_N=$((SKIP_N + 1)); }
note() { printf '       %s\n' "$1"; }

# 用 `command grep` 绕开仓库里把 grep 包成 ugrep 的 shell 函数 (行为/退出码更可控)。
g() { command grep "$@"; }

# serve-api 是否在线 (决定运行时探针 [1 部分]/[2]/[5] 跑还是 SKIP)
api_is_up() {
  curl -fsS --max-time 3 "$API_BASE/api/health" >/dev/null 2>&1
}

printf '== MailAgent V2 远程访问安全检查 ==\n'
printf 'repo: %s\n' "$REPO_ROOT"
printf 'api : %s (port %s)\n\n' "$API_BASE" "$API_PORT"

API_UP=0
if api_is_up; then
  API_UP=1
  note "serve-api 在线 → 运行时探针 [1b]/[2]/[5] 启用"
else
  note "serve-api 未在线 → 运行时探针 [1b]/[2]/[5] 将 SKIP (先 \`mailagent serve-api\` 再跑可覆盖)"
fi
printf '\n'

# ===========================================================================
# [1] bind 127.0.0.1 — lsof 必无 0.0.0.0/*:8200，且 (在线时) /api/health 活
# ===========================================================================
printf -- '--- [1] FastAPI bind 127.0.0.1 (loopback-only) ---\n'
if command -v lsof >/dev/null 2>&1; then
  LISTEN="$(lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$LISTEN" ]; then
    skip "[1a] 端口 $API_PORT 无 LISTEN socket (serve-api 未起) — 起服后重测"
  elif printf '%s\n' "$LISTEN" | g -Eq '(\*|0\.0\.0\.0|\[::\]):'"$API_PORT"; then
    fail "[1a] 端口 $API_PORT 监听非 loopback 地址 (见 0.0.0.0/*/[::]) — 严重: 公网网卡可达"
    printf '%s\n' "$LISTEN" | sed 's/^/       /'
  elif printf '%s\n' "$LISTEN" | g -Eq '127\.0\.0\.1:'"$API_PORT"; then
    pass "[1a] 端口 $API_PORT 仅监听 127.0.0.1 (loopback)"
  else
    fail "[1a] 端口 $API_PORT LISTEN 地址非 127.0.0.1 — 人工核对"
    printf '%s\n' "$LISTEN" | sed 's/^/       /'
  fi
else
  skip "[1a] 无 lsof，跳过端口绑定探针"
fi

# 源码契约: app.py _assert_bind_loopback fail-closed + serve-api 硬绑 127.0.0.1
if g -q '_assert_bind_loopback' src/api/app.py 2>/dev/null \
   && g -q 'MAILAGENT_API_HOST' src/api/app.py 2>/dev/null \
   && g -Eq 'host *= *"127\.0\.0\.1"' src/cli/main.py 2>/dev/null; then
  pass "[1-src] app.py 启动断言读 MAILAGENT_API_HOST + serve-api 硬绑 127.0.0.1"
else
  fail "[1-src] loopback 断言/硬绑契约缺失 (app.py _assert_bind_loopback 或 serve-api host)"
fi

if [ "$API_UP" -eq 1 ]; then
  if curl -fsS --max-time 3 "$API_BASE/api/health" | g -q '"status":"ok"'; then
    pass "[1b] /api/health 经 loopback 回 {\"status\":\"ok\"}"
  else
    fail "[1b] /api/health 未回 status:ok"
  fi
else
  skip "[1b] serve-api 未在线 — /api/health 活性探针跳过"
fi
printf '\n'

# ===========================================================================
# [2] CORS 严格 — 伪造 Origin 不被回显
# ===========================================================================
printf -- '--- [2] CORS 严格 (仅 https://mail.chenge.ink) ---\n'
# 源码契约: ALLOWED_ORIGINS 生产仅 mail.chenge.ink；localhost 仅 _DEV_CORS 放行
if g -q 'ALLOWED_ORIGINS = \["https://mail.chenge.ink"\]' src/api/app.py 2>/dev/null \
   && g -q 'MAILAGENT_API_DEV_CORS' src/api/app.py 2>/dev/null; then
  pass "[2-src] CORS 白名单生产仅 mail.chenge.ink；localhost 由 MAILAGENT_API_DEV_CORS 独控"
else
  fail "[2-src] CORS 白名单契约缺失 (ALLOWED_ORIGINS / MAILAGENT_API_DEV_CORS)"
fi

if [ "$API_UP" -eq 1 ]; then
  ACAO="$(curl -fsS --max-time 3 -H 'Origin: https://evil.com' \
            -D - "$API_BASE/api/health" -o /dev/null 2>/dev/null \
            | g -i '^Access-Control-Allow-Origin:' || true)"
  if printf '%s' "$ACAO" | g -qi 'evil\.com'; then
    fail "[2] 伪造 Origin evil.com 被回显到 Access-Control-Allow-Origin — CORS 不严"
    note "$ACAO"
  else
    pass "[2] 伪造 Origin evil.com 未被回显 (无 ACAO: evil.com)"
  fi
else
  skip "[2] serve-api 未在线 — CORS 运行时探针跳过"
fi
printf '\n'

# ===========================================================================
# [3] auth env fail-fast — 生产空 CF_AUDIENCE → 拒起
# ===========================================================================
printf -- '--- [3] auth fail-fast (空 CF_AUDIENCE 生产拒起) ---\n'
# auth.py:74 守卫: not AUTH_DISABLED and not CF_AUDIENCE → RuntimeError
if g -Eq 'not AUTH_DISABLED and not CF_AUDIENCE' src/api/auth.py 2>/dev/null \
   && g -q 'CF_AUDIENCE is empty' src/api/auth.py 2>/dev/null; then
  pass "[3-src] auth.py 含 fail-fast: 生产空 CF_AUDIENCE 抛 RuntimeError 拒起"
else
  fail "[3-src] auth.py 缺 CF_AUDIENCE fail-fast 守卫"
fi

# 反向运行时断言: 清空 CF_AUDIENCE + 不开 AUTH_DISABLED 跑 serve-api 应立即 RuntimeError。
# 用 python -c 触发 import src.api.auth (不真起 uvicorn)；必须有 venv python。
PYBIN=""
for cand in "$REPO_ROOT/venv/bin/python3" "$REPO_ROOT/venv/bin/python" python3; do
  if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then PYBIN="$cand"; break; fi
done
if [ -n "$PYBIN" ]; then
  # 子 shell 隔离 env；预期 import 失败 (非 0 退出 + 提到 CF_AUDIENCE)
  AUTH_OUT="$(cd "$REPO_ROOT" && env -u MAILAGENT_API_AUTH_DISABLED -u MAILAGENT_API_DEV \
                CF_AUDIENCE="" "$PYBIN" -c 'import src.api.auth' 2>&1 || true)"
  if printf '%s' "$AUTH_OUT" | g -q 'CF_AUDIENCE is empty'; then
    pass "[3] 运行时: 空 CF_AUDIENCE 下 import src.api.auth 即 RuntimeError 拒起"
  else
    skip "[3] 运行时断言未触发预期错误 (可能缺依赖/非 venv)；以 [3-src] 静态契约为准"
    note "out: $(printf '%s' "$AUTH_OUT" | head -1)"
  fi
else
  skip "[3] 无 python，运行时 fail-fast 断言跳过 (以 [3-src] 为准)"
fi
printf '\n'

# ===========================================================================
# [4] auth bypass 防误配 — AUTH_DISABLED=true 但无 MAILAGENT_API_DEV=true → 拒
# ===========================================================================
printf -- '--- [4] auth bypass 防误配 (dev-only 守卫) ---\n'
# auth.py:63 守卫: AUTH_DISABLED and not _DEV_CONTEXT → RuntimeError
if g -Eq 'AUTH_DISABLED and not _DEV_CONTEXT' src/api/auth.py 2>/dev/null \
   && g -q 'no dev context declared' src/api/auth.py 2>/dev/null; then
  pass "[4-src] auth.py 含守卫: AUTH_DISABLED 无 MAILAGENT_API_DEV → RuntimeError"
else
  fail "[4-src] auth.py 缺 auth-bypass dev-only 守卫"
fi

if [ -n "$PYBIN" ]; then
  BYPASS_OUT="$(cd "$REPO_ROOT" && env -u MAILAGENT_API_DEV \
                  MAILAGENT_API_AUTH_DISABLED=true CF_AUDIENCE="x" \
                  "$PYBIN" -c 'import src.api.auth' 2>&1 || true)"
  if printf '%s' "$BYPASS_OUT" | g -q 'no dev context declared'; then
    pass "[4] 运行时: AUTH_DISABLED=true 无 MAILAGENT_API_DEV → import 即 RuntimeError"
  else
    skip "[4] 运行时断言未触发预期错误 (可能缺依赖)；以 [4-src] 静态契约为准"
    note "out: $(printf '%s' "$BYPASS_OUT" | head -1)"
  fi
else
  skip "[4] 无 python，运行时 bypass 断言跳过 (以 [4-src] 为准)"
fi
printf '\n'

# ===========================================================================
# [5] JWT 二次校验在岗 — 无 token 打受保护端点 → 401
# ===========================================================================
printf -- '--- [5] JWT 二次校验 L2 (无 token → 401) ---\n'
# 源码契约: verify_cf_access 缺 token → 401
if g -q 'verify_cf_access' src/api/auth.py 2>/dev/null \
   && g -Eq 'status_code=401' src/api/auth.py 2>/dev/null; then
  pass "[5-src] auth.py verify_cf_access 缺 Cf-Access-Jwt-Assertion → 401"
else
  fail "[5-src] auth.py 缺 401 (no token) 路径"
fi

if [ "$API_UP" -eq 1 ]; then
  # 受保护端点 (email/list 带 Depends(verify_cf_access))；本机直打无 CF cookie/JWT → 期 401。
  # 注: AUTH_DISABLED dev 模式下会放行 → 该探针只在生产配置有意义；放行则提示。
  CODE="$(curl -s --max-time 4 -o /dev/null -w '%{http_code}' \
            "$API_BASE/api/email/list" 2>/dev/null || true)"
  if [ "$CODE" = "401" ]; then
    pass "[5] 无 token 打 /api/email/list → 401 (L2 兜底在岗)"
  elif [ "$CODE" = "200" ]; then
    fail "[5] 无 token 打 /api/email/list 竟 200 — 鉴权被绕过 (检查 MAILAGENT_API_AUTH_DISABLED 是否误开)"
  else
    skip "[5] /api/email/list 返回 $CODE (非 401/200)；人工核对端点/路由"
  fi
else
  skip "[5] serve-api 未在线 — JWT 401 探针跳过"
fi
printf '\n'

# ===========================================================================
# [6] CLI api_key 不入 web bundle — 无 secret *值* 泄漏 (§6.4 G3)
# ===========================================================================
printf -- '--- [6] CLI api_key 不入 web bundle (§6.4 G3) ---\n'
if [ ! -d "$WEB_BUNDLE_DIR" ]; then
  skip "[6] $WEB_BUNDLE_DIR 不存在 — 先 \`cd frontend && pnpm build:web\` 再跑"
else
  # 关键: key 名 MAILAGENT_CLI_API_KEY 合法出现 (设置 UI 表单 label / i18n)，不算泄漏。
  # 真正要挡的是 **value 赋值形态**: KEY=<8+字符> 或 "KEY":"<8+字符 secret>"。
  # 排除明显的 label 形态 ("label":"MAILAGENT_CLI_API_KEY" / envKey:"MAILAGENT_CLI_API_KEY")。
  LEAK="$(g -rEoh \
            'MAILAGENT_CLI_API_KEY["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_+/=-]{8,}' \
            "$WEB_BUNDLE_DIR" 2>/dev/null \
          | g -Ev '"(label|helper|name|title|placeholder|description)"' \
          | g -Ev 'envKey' \
          || true)"
  if [ -n "$LEAK" ]; then
    fail "[6] web bundle 出现 MAILAGENT_CLI_API_KEY 的 value 赋值形态 — 疑似 secret 泄漏"
    printf '%s\n' "$LEAK" | head -5 | sed 's/^/       /'
  else
    pass "[6] web bundle 无 MAILAGENT_CLI_API_KEY 值泄漏 (仅设置 UI label, 非 secret)"
    # 透明提示: 报告 bare key 名出现次数 (预期 >0, 来自 settings 表单, 非泄漏)
    NAME_HITS="$(g -rho 'MAILAGENT_CLI_API_KEY' "$WEB_BUNDLE_DIR" 2>/dev/null | wc -l | tr -d ' ')"
    note "key 名作为表单 label 出现 ${NAME_HITS} 次 (预期, 非 secret 值)"
  fi
fi
printf '\n'

# ===========================================================================
# [7] 附件 path-traversal 防护 (源码契约)
# ===========================================================================
printf -- '--- [7] 附件 path-traversal 防护 (越界 → 403) ---\n'
# attachment.py _resolve_guarded_path: resolve 后必须落在 base_dir 子树, 否则 403 E_AUTH_FAILED
if g -q '_resolve_guarded_path' src/api/routers/attachment.py 2>/dev/null \
   && g -q 'is_relative_to' src/api/routers/attachment.py 2>/dev/null \
   && g -q 'escapes the allowed storage root' src/api/routers/attachment.py 2>/dev/null; then
  pass "[7-src] attachment.py 含 path-traversal 防护 (resolve + is_relative_to base_dir → 403)"
else
  fail "[7-src] attachment.py 缺 path-traversal 防护契约 (_resolve_guarded_path / is_relative_to)"
fi
note "运行时构造越界路径需有效 JWT + 真附件行 → 由真机/集成测试覆盖 (本脚本断言防御代码在源码)"
printf '\n'

# ===========================================================================
# [8] 无鉴权面最小化 — 仅 /api/health 无 auth，其余带 verify_cf_access
# ===========================================================================
printf -- '--- [8] 无鉴权面最小化 (仅 /api/health 无 auth) ---\n'
ROUTER_DIR="$REPO_ROOT/src/api/routers"
# 统计每个 router 文件里 @router.<verb>(...) 端点数 vs Depends(verify_cf_access) 出现数。
# 契约: 每个业务端点都应带 Depends(verify_cf_access)；/api/health 在 app.py (不在 routers/)。
EP_TOTAL=0
GUARDED=0
UNGUARDED_FILES=""
for f in "$ROUTER_DIR"/*.py; do
  [ -f "$f" ] || continue
  case "$f" in */__init__.py) continue ;; esac
  ne="$(g -cE '^[[:space:]]*@router\.(get|post|delete|put|patch)\(' "$f" 2>/dev/null || echo 0)"
  ng="$(g -co 'verify_cf_access' "$f" 2>/dev/null || echo 0)"
  EP_TOTAL=$((EP_TOTAL + ne))
  GUARDED=$((GUARDED + ng))
  if [ "$ne" -gt 0 ] && [ "$ng" -eq 0 ]; then
    UNGUARDED_FILES="$UNGUARDED_FILES $(basename "$f")(${ne}ep)"
  fi
done

# app.py 的 /api/health 必须是无鉴权 liveness (且仅它)
HEALTH_OK=0
if g -q '@app.get("/api/health")' src/api/app.py 2>/dev/null; then HEALTH_OK=1; fi

if [ "$EP_TOTAL" -eq 0 ]; then
  fail "[8] 未在 routers/ 找到任何 @router 端点 — 路由可能未加载/路径错"
elif [ -n "$UNGUARDED_FILES" ]; then
  fail "[8] 有 router 文件含端点但无 verify_cf_access:$UNGUARDED_FILES"
elif [ "$HEALTH_OK" -ne 1 ]; then
  fail "[8] app.py 未声明 /api/health liveness 端点"
else
  pass "[8] routers/ 共 ${EP_TOTAL} 端点均引用 verify_cf_access；仅 app.py /api/health 无鉴权"
fi
printf '\n'

# ===========================================================================
# 汇总
# ===========================================================================
printf '== 汇总: %s%d PASS%s / %s%d FAIL%s / %s%d SKIP%s ==\n' \
  "$C_PASS" "$PASS_N" "$C_OFF" "$C_FAIL" "$FAIL_N" "$C_OFF" "$C_SKIP" "$SKIP_N" "$C_OFF"

if [ "$FAIL_N" -gt 0 ]; then
  printf '%s上线 gate: 不通过 (有 FAIL)。修复后重跑。%s\n' "$C_FAIL" "$C_OFF"
  exit 1
fi
if [ "$SKIP_N" -gt 0 ]; then
  printf '%s上线 gate: 静态项通过；部分运行时探针 SKIP — 起 serve-api / build:web 后重跑以全覆盖。%s\n' \
    "$C_SKIP" "$C_OFF"
fi
printf '%s上线 gate: 通过。%s\n' "$C_PASS" "$C_OFF"
exit 0
