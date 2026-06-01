# MailAgent V2 远程访问 — 端到端上线 Runbook

> V2 远程访问最后一块：把本地 FastAPI (`mailagent serve-api`, `127.0.0.1:8200`) 经
> **Cloudflare Tunnel + Cloudflare Access** 暴露给 `https://mail.chenge.ink`，配 Web SPA +
> PWA，让 iPad / iPhone / 借的电脑也能看邮件 + 触发操作。**SQLite 不上云**。
>
> 设计依据：[`frontend/REMOTE-ACCESS.md`](../frontend/REMOTE-ACCESS.md)
> §6（Tunnel + Access）/ §7（PWA）/ §8（SLO）/ §9（安全 checklist）/ §10（工作量）/ §12（风险）。
>
> **本 runbook 的执行边界**：
> - 🤖 **脚本自动 / 命令可复制** —— cloudflared / pm2 / wrangler / curl 等命令本机直接跑。
> - 🙋 **用户亲自** —— Cloudflare Dashboard 操作（Zero Trust Access policy、Audience Tag、WAF）
>   与 iPad/iPhone 真机「添加到主屏幕」，本 runbook 只给逐步指引 + 验收判据，不代操作。

---

## 0. 前置要求（动手前先备齐）

| 项 | 说明 | 怎么确认 |
|---|---|---|
| Cloudflare 账号 | 已开 **Zero Trust**（免费版即可，单用户够） | dashboard 能进 `Zero Trust → Access` |
| 域名托管在 Cloudflare | `chenge.ink` 的 DNS 由 Cloudflare 管（Tunnel 的 `route dns` 要写 CNAME） | `chenge.ink` 在 CF dashboard 的站点列表里 |
| `cloudflared` | tunnel 守护进程（brew 装，**不**进 Electron 打包 venv） | `cloudflared --version` |
| `wrangler` | Cloudflare Pages 部署（web 静态产物上传），随用随 `npx` 即可 | `npx wrangler --version` |
| Node + pnpm | 前端 `frontend/` build:web 用 | `cd frontend && pnpm -v` |
| Python venv + CLI | `mailagent serve-api` 子命令（本机 3.11+） | `source venv/bin/activate && mailagent --help \| grep serve-api` |
| 一个 Google 账号 | CF Access OAuth 白名单身份 = `s1021964827@gmail.com`（iPad/iPhone/借机同账号登） | — |

装依赖（🤖 本机一次性）：

```bash
brew install cloudflared
cd /Users/chenyuanquan/Documents/MailAgent-remote-web/frontend && pnpm install
cd /Users/chenyuanquan/Documents/MailAgent-remote-web && source venv/bin/activate && pip install -e ".[cli]"
```

> **架构边界（关键）**：`cloudflared` **不**纳入 Electron 的 BackendLifecycleManager。
> lifecycle 只托管 `mailagent` CLI 进程（`serve` + `serve-api`）。tunnel 依赖用户环境态
> （`~/.cloudflared/config.yml` + `<uuid>.json` 凭据 + `cloudflared tunnel login` 的 `cert.pem`），
> 且 tunnel 该**独立于 Electron 开关常驻**（MacBook 不开 Electron 时 tunnel 仍要活，见 §12 caffeinate）。
> 因此 tunnel 走 pm2 / 手动管，不绑 app 生命周期。

---

## Step 1 — 起本地 serve-api（🤖 脚本自动）

### 命令

**打包 app 场景**：Electron 启动时 BackendLifecycleManager 自动 spawn `serve-api`（与 `serve` 平行），
无需手动起。直接跳到「验证」。

**dev / 服务器部署场景**（手动起一个长驻进程）：

```bash
cd /Users/chenyuanquan/Documents/MailAgent-remote-web
source venv/bin/activate
pm2 start "mailagent serve-api" --name mailagent-api --interpreter ./venv/bin/python3 \
  --max-memory-restart 500M
pm2 save
```

### 预期输出

```
[PM2] Starting /…/venv/bin/python3 in fork_mode (1 instance)
[PM2] Done.
│ mailagent-api │ … │ online │ …
```

uvicorn 日志出现 `Uvicorn running on http://127.0.0.1:8200`。

### 验证

```bash
# liveness（无鉴权，app.py /api/health）→ 必回 {"status":"ok","schema_version":1}
curl -fsS http://127.0.0.1:8200/api/health | jq .

# 端口只绑 loopback（绝无 0.0.0.0 / *:8200）
lsof -nP -iTCP:8200 -sTCP:LISTEN
```

`/api/health` 回 `{"status":"ok",...}` 且 `lsof` 只见 `127.0.0.1:8200` → 通过。

### 故障排查

| 症状 | 根因 | 处理 |
|---|---|---|
| 启动即 `RuntimeError: CF_AUDIENCE is empty …` | 生产模式（未开 `MAILAGENT_API_AUTH_DISABLED`）漏配 `CF_AUDIENCE`（`auth.py:74` fail-fast） | 先做 Step 3/4 拿到 Audience Tag 填 `.env`，再起；或 dev 临时 `MAILAGENT_API_AUTH_DISABLED=true` + `MAILAGENT_API_DEV=true` |
| 启动即 `RuntimeError: …no dev context declared` | 设了 `MAILAGENT_API_AUTH_DISABLED=true` 但没设 `MAILAGENT_API_DEV=true`（`auth.py:63` 防生产误关鉴权） | 要么撤掉 bypass（生产），要么补 `MAILAGENT_API_DEV=true`（dev） |
| 启动即 `RuntimeError: FastAPI MUST bind 127.0.0.1` | 绕过 `serve-api` 裸跑 uvicorn，未落 `MAILAGENT_API_HOST`（`app.py:_assert_bind_loopback` fail-closed） | 必须经 `mailagent serve-api` 启动（它在 `uvicorn.run` 前硬写 `MAILAGENT_API_HOST=127.0.0.1`） |
| `curl: (7) Failed to connect` | 进程没起 / 端口被占 | `pm2 logs mailagent-api --lines 30 --nostream`；`lsof -nP -iTCP:8200` 看占用 |
| `lsof` 见 `*:8200` 或 `0.0.0.0:8200` | host 未硬绑 loopback（不应发生，serve-api 硬编码 127.0.0.1） | 立即停服，核对是否用了非 `serve-api` 的启动方式 |

---

## Step 2 — cloudflared Tunnel（🤖 命令自动，DNS 路由本机跑）

把本机 `127.0.0.1:8200` 经 Cloudflare 边缘暴露成 `mail.chenge.ink`。

### 命令

```bash
# 1) 浏览器授权（落 ~/.cloudflared/cert.pem）
cloudflared tunnel login

# 2) 建 tunnel（输出 <TUNNEL_UUID> + ~/.cloudflared/<UUID>.json 凭据）
cloudflared tunnel create mailagent-local

# 3) 写 ingress config（把 <TUNNEL_UUID> 替成上一步真实 UUID）
#    ⚠️ ingress service 端口必须 == MAILAGENT_API_PORT（默认 8200），改端口要两处同步。
cat > ~/.cloudflared/config.yml <<'EOF'
tunnel: <TUNNEL_UUID>
credentials-file: /Users/chenyuanquan/.cloudflared/<TUNNEL_UUID>.json
ingress:
  - hostname: mail.chenge.ink
    service: http://127.0.0.1:8200
  - service: http_status:404
EOF

# 4) 路由 DNS（在 chenge.ink 区写 CNAME mail → tunnel）
cloudflared tunnel route dns mailagent-local mail.chenge.ink

# 5) 常驻（独立于 Electron；pm2 托管 + 开机自启）
pm2 start cloudflared --name mailagent-tunnel -- tunnel run mailagent-local
pm2 save
pm2 startup   # 按提示拷一条命令执行（注册 launchd 开机自启）
```

### 预期输出

- `tunnel create` → `Created tunnel mailagent-local with id <UUID>` + `Tunnel credentials written to …/<UUID>.json`
- `route dns` → `Added CNAME mail.chenge.ink which will route to this tunnel …`
- `pm2 start cloudflared` → `mailagent-tunnel … online`；其日志出现 `Registered tunnel connection`（≥1 条，通常 4 条到不同 colo）

### 验证

```bash
pm2 status mailagent-tunnel                       # online
pm2 logs mailagent-tunnel --lines 20 --nostream   # 见 "Registered tunnel connection"
# 边缘可达性（此刻还没配 Access，应被 CF 边缘拦在 OAuth 前 → 302 到 cloudflareaccess，或 403）
curl -sI https://mail.chenge.ink/api/health | head -5
```

> 注意：配完 Step 3 的 Access policy 后，未带 CF cookie 直 `curl` 会被 CF 边缘 302 到登录页 /
> 返回 Access 拦截页 —— 这是**预期**（证明 L1 在岗）。本机带鉴权的端到端验证在 Step 6/7。

### 故障排查

| 症状 | 处理 |
|---|---|
| `route dns` 报 `An A, AAAA, or CNAME record … already exists` | dashboard `DNS` 删掉 `mail` 旧记录，或换子域；再重跑 |
| tunnel `online` 但 `mail.chenge.ink` 解析不出 | DNS 传播未完成（等几分钟）；`dig mail.chenge.ink CNAME` 看是否指向 `<UUID>.cfargotunnel.com` |
| `502 Bad Gateway`（过 CF Access 之后） | origin（serve-api）没起或端口对不上；回 Step 1 验 `curl 127.0.0.1:8200/api/health` + 核对 ingress 端口 == `MAILAGENT_API_PORT` |
| MacBook 休眠后 tunnel 断 | §12 缓解：`python3 scripts/keep_alive.py daemon` 常驻防锁屏 |

---

## Step 3 — Cloudflare Access policy（🙋 用户亲自 · CF Dashboard）

OAuth + 单邮箱白名单 + 拿 **Audience Tag** 喂给 FastAPI L2。

### 逐步（REMOTE-ACCESS §6.2）

1. CF Dashboard → **Zero Trust → Access → Applications → Add an application → Self-hosted**。
2. **Application domain**：`mail.chenge.ink`（可加 path `/api/*` 与 `/app/*`）。
3. **Identity providers**：Google（OAuth）。
4. **Policy**：
   - Action = **Allow**
   - Include → **Emails** → `s1021964827@gmail.com`（单用户白名单；同 Google 账号的 iPad/iPhone/借机都用它）。
5. **Session duration**：**30 天 per device**（单设备登出不影响其他设备）。
6. **获取 Audience (AUD) Tag**（关键，喂 FastAPI L2）：创建后进 Application → **Overview / Settings** →
   复制 **Application Audience (AUD) Tag**（一串 hex）→ 记下，Step 4 填进本机 `.env` 的 `CF_AUDIENCE`。

### （可选）WAF rate limit 硬化（REMOTE-ACCESS §6.5）

CF Dashboard → **Security → WAF → Rate limiting rules**：

| Rule | 触发条件 | 动作 |
|---|---|---|
| Per-IP `/api/*` | 同 IP > 60 req/min | challenge（managed） |
| Per-email `/api/*` | 同 `cf-access-authenticated-user-email` > 600 req/min | block 1h |
| Per-IP `/api/attachment/*/download` | 同 IP > 20 req/min（限大文件刷流量） | block 5min |

### 验收判据

- Application 列表里出现 `mail.chenge.ink`，状态正常。
- 已复制 Audience Tag（hex 串非空）。
- 浏览器隐身窗口开 `https://mail.chenge.ink/api/health` → **被 CF 拦到 Google OAuth 登录页**（证明 L1 OAuth 在岗）；
  用白名单 Google 账号登后能过、非白名单账号被拒。

---

## Step 4 — 配 `.env` 远程访问段 + 重启 serve-api（🤖 本机）

### 命令

把 Step 3 拿到的 Audience Tag 填进 `.env`（项见本仓 [`.env.example`](../.env.example) 的
「V2 远程访问」段）：

```bash
# .env 里至少填这一项（其余有默认）：
# CF_AUDIENCE=<Step3 复制的 Application Audience(AUD) Tag>
#
# 默认即对、通常不用动：
#   CF_TEAM_DOMAIN=chenyq.cloudflareaccess.com   # 默认值
#   MAILAGENT_API_PORT=8200                       # 默认值（须 == cloudflared ingress 端口）
#
# 生产必须保持 false / 未设（dev-only）：
#   MAILAGENT_API_DEV_CORS / MAILAGENT_API_AUTH_DISABLED / MAILAGENT_API_DEV

pm2 restart mailagent-api   # 让 auth.py 在 import 期读到 CF_AUDIENCE
```

> `auth.py` 的 `CF_AUDIENCE` / `CF_TEAM_DOMAIN` 在**模块 import 期**读 env，所以改 `.env` 后
> **必须重启** serve-api 才生效（不是热加载）。

### 验证

```bash
# 生产配置正确：进程 online、无 RuntimeError
pm2 logs mailagent-api --lines 15 --nostream | grep -i "error\|runtime" || echo "no startup error"

# fail-fast 反向断言（可选）：临时清空 CF_AUDIENCE 应拒起
#   CF_AUDIENCE= mailagent serve-api   → 立即 RuntimeError: CF_AUDIENCE is empty …（Ctrl-C 退出）
```

### 故障排查

| 症状 | 根因 | 处理 |
|---|---|---|
| 所有请求静默 403 | `CF_AUDIENCE` 填错（与 dashboard 不符）→ `jwt.decode` audience 不匹配 | 回 Step 3 重新复制 Audience Tag，重填重启 |
| `email not allowed`（403） | 登录的 Google 邮箱 ≠ `USER_EMAIL`（L2 二次比对） | 用白名单邮箱登；或裸 API 部署时显式设 `MAILAGENT_API_ALLOWED_EMAIL` |
| `server email allowlist not configured`（403） | `USER_EMAIL` 与 `MAILAGENT_API_ALLOWED_EMAIL` 都空（fail-closed） | 填 `.env` 的 `USER_EMAIL`（必填项） |

---

## Step 5 — Cloudflare Pages 部署 Web SPA（🤖 命令自动，Pages 域绑定 🙋 dashboard）

web 静态产物在 `frontend/out/web`（`base=/app/`）。`/app/*` 静态走 Pages，`/api/*` 走 Step 2 的 tunnel。

### 命令（路径 1 — wrangler 直传，推荐，无需 CI）

```bash
cd /Users/chenyuanquan/Documents/MailAgent-remote-web/frontend
pnpm build:web                                   # 产 out/web（SPA + sw.js）
npx wrangler pages deploy out/web --project-name mailagent-web
```

或用本仓脚本（封装 build + deploy + gh-pages fallback）：

```bash
./scripts/v2-pages-deploy.sh
```

> `scripts/v2-pages-deploy.sh`：`set -euo pipefail` + `pnpm build:web` + `npx wrangler pages deploy out/web`，
> wrangler 失败时回退推 `gh-pages` 分支。**无需 `wrangler.toml`** —— 脚本用 `npx --yes wrangler` 直传 `out/web`。

### 路径 2 — Pages Git 集成（替代）

CF Pages 连 GitHub `ChenyqThu/MailAgent`（PUBLIC repo，无 token 门槛）：
- Build command：`cd frontend && pnpm build:web`
- Build output directory：`frontend/out/web`

### 同域路由取舍（🙋 dashboard）

自定义域 `mail.chenge.ink` 下需让 **`/app/*` 由 Pages serve、`/api/*` 由 tunnel serve**（同域 = 免跨域 CORS，REMOTE-ACCESS 原设计）：
- Pages 项目 → Custom domains → 绑 `mail.chenge.ink`。
- tunnel ingress 已是 `mail.chenge.ink → 127.0.0.1:8200`（serve `/api/*`）。
- **让 `/api/*` 不被 Pages 截走**（二选一）：
  - **Pages `_routes.json`**：在 `frontend/src/web/public/_routes.json` 放
    `{"version":1,"include":["/*"],"exclude":["/api/*"]}` —— `exclude` 使 `/api/*` 不走 Pages、回落 tunnel origin。
  - **CF Configuration Rule**：dashboard → Rules → Configuration Rules 新建，表达式
    `(http.host eq "mail.chenge.ink" and starts_with(http.request.uri.path, "/api/"))` 路由到 tunnel，优先级高于 Pages。
- **替代（最省心，规避同域优先级）**：拆子域 —— API 留 `mail.chenge.ink`、SPA 用 `app.chenge.ink`；
  需把 `app.chenge.ink` 加进 serve-api CORS 白名单（`app.py` ALLOWED_ORIGINS）+ `build:web` 设
  `VITE_API_BASE_URL=https://mail.chenge.ink/api`（factory.ts 据此构造 HttpApi baseUrl）。

### 预期输出

`wrangler pages deploy` → `✨ Deployment complete! … https://<hash>.mailagent-web.pages.dev`

### 验证

```bash
# 静态资源命中（base=/app/）
curl -sI https://mail.chenge.ink/app/ | head -5     # 200 / text-html（过 Access 后）
# SPA 入口含 manifest + sw 注册（grep 构建产物）
grep -o 'manifest\|/app/sw.js\|registerSW' frontend/out/web/index.html | sort -u
```

### 故障排查

| 症状 | 处理 |
|---|---|
| `/app/` 404 | Pages 自定义域 / path 未绑对；核对 `base=/app/` 与 Pages 域路由 |
| 静态资源 404（assets 路径错） | 确认 `pnpm build:web` 用的是 `base=/app/`（`vite.web.config.ts`）；产物在 `out/web/assets/*` |
| `/api/*` 被 Pages 截走（返回 SPA HTML 而非 JSON） | dashboard 配 `/api/*` 优先走 tunnel（Origin Rules / path 排除） |

---

## Step 6 — PWA 真机「添加到主屏幕」（🙋 用户亲自 · iPad/iPhone）

### 逐步（REMOTE-ACCESS §7）

1. iOS/iPadOS **Safari** 打开 `https://mail.chenge.ink/app`。
2. 走 **CF Access OAuth**（Google 登白名单账号）→ 进入 SPA。
3. 分享菜单 → **「添加到主屏幕」**。

### 验收判据

- 主屏出现 MailAgent 图标，点开**无 Safari 地址栏 / tab bar**（standalone）。
- 邮件列表 / 详情 / 搜索可用；附件可流式下载。
- 30 天后 cookie 过期重登一次即可（§12）。

---

## Step 7 — 验收（🤖 脚本化项 + 🙋 真机体验）

### 7.1 安全 checklist（🤖 脚本）

```bash
cd /Users/chenyuanquan/Documents/MailAgent-remote-web
./scripts/v2-security-check.sh
```

覆盖 REMOTE-ACCESS §9 可脚本化项（逐项 PASS/FAIL，全 PASS 退出 0）：
bind 127.0.0.1 / CORS 严格 / 生产 dev-flag 全关 / `CF_AUDIENCE` fail-fast / auth-bypass 防误配 /
CLI api_key 不入 web bundle（值不泄漏） / 附件 path-traversal 防护 / 无鉴权面仅 `/api/health`。
脚本细节见 [`scripts/v2-security-check.sh`](../scripts/v2-security-check.sh) 头部注释。

### 7.2 SLO（🤖 + 🙋，REMOTE-ACCESS §8）

真机（或带 CF cookie 的 curl）量 P95：

| 操作 | 目标 P95 |
|---|---|
| 邮件列表（50 封） | < 500ms |
| 邮件详情打开（markdown） | < 800ms |
| 全文搜索 | < 1.2s |
| 附件下载（5MB PDF） | 流式 ~3–5s |

### 7.3 写命令端到端（🙋 真机）

远端标记 / 标旗 / 触发重传 → 回本机 Electron 或 Notion 确认状态已变（API → CLI subprocess 链路）。

### 7.4 防锁屏常驻（🤖，§12 风险缓解）

```bash
# 防 MacBook 休眠断 tunnel（工作时段自动暂停，--force 忽略）
python3 scripts/keep_alive.py daemon --dim
# 或系统级（按需）：
# caffeinate -d -i -m -s
```

---

## 附：§12 风险 / 缓解速查

| 风险 | 缓解 | 落地命令 |
|---|---|---|
| MacBook 休眠 → tunnel 断 | 防锁屏常驻 | `python3 scripts/keep_alive.py daemon --dim` / `caffeinate -d -i -m -s` |
| MacBook 重启 → 进程没起 | pm2 开机自启 | `pm2 save && pm2 startup`（serve-api + tunnel 都 `pm2 save`） |
| CF Access 30 天 cookie 过期 | 重登一次 | 真机 Safari 重走 OAuth |
| 公网爆破 `mail.chenge.ink` | Access OAuth 拦在最外层 + WAF rate limit | Step 3 policy + 可选 WAF |
| FastAPI 内存泄漏 / 卡死 | pm2 内存上限重启 + 健康探针 | `--max-memory-restart 500M` + 轮询 `/api/health` |
| 旧 SPA 缓存 | service worker `skipWaiting` + 版本注入 | 重新 `build:web` 部署 |
| Cloudflare 全球抽风 | 本机 Electron 直读不受影响 | —（架构兜底） |

---

## 上线顺序速记

```
Step1 起 serve-api (curl /api/health 验活, lsof 验 loopback)
  → Step2 cloudflared login/create/config.yml/route dns/pm2 常驻
  → Step3 🙋 CF Access self-hosted + Google OAuth + 邮箱白名单 + 复制 Audience Tag (+可选 WAF)
  → Step4 .env 填 CF_AUDIENCE → pm2 restart serve-api
  → Step5 pnpm build:web → wrangler pages deploy (+🙋 同域 /app static + /api tunnel 路由)
  → Step6 🙋 真机 Safari 开 /app → OAuth → 添加到主屏幕
  → Step7 ./scripts/v2-security-check.sh 全 PASS + SLO + 写命令端到端 + keep_alive 常驻
```
