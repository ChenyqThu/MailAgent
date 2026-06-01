# V2 远程访问 — Cloudflare Zero Trust Access 配置

> 本文是 **Dashboard 操作 runbook**：Cloudflare Zero Trust 控制台的点选步骤由用户亲自完成，
> 脚本只产脚手架（`scripts/v2-tunnel-setup.sh` / `scripts/v2-pages-deploy.sh`）。
> 设计依据：`frontend/REMOTE-ACCESS.md` §6（Tunnel + Access）/ §7（PWA）。

整个远程链路的两层鉴权：

| 层 | 在哪 | 作用 |
|---|---|---|
| **L1 — Cloudflare Access** | CF 边缘（本文配置） | OAuth 登录墙 + 邮箱白名单，未登录流量到不了 origin |
| **L2 — FastAPI verify_cf_access** | 本机 serve-api（已实现） | 校验 CF 注入的 `Cf-Access-Jwt-Assertion`，防 tunnel 误配 leak |

> L2 兜底要求 `.env` 里 `CF_AUDIENCE` 填对（auth.py fail-fast：非 `AUTH_DISABLED` 且 `CF_AUDIENCE` 空 → 启动 RuntimeError）。
> **拿 Audience Tag 是本文的关键产物**（见 Step 5），拿到后填进 `.env` 并重启 serve-api。

---

## 前置条件

- 已有 Cloudflare 账号，且域名 `chenge.ink` 的 zone 托管在该账号下（DNS 由 CF 管理）。
- 已跑完 `scripts/v2-tunnel-setup.sh`（或手动完成 tunnel create + route dns + pm2 常驻），
  即 `mail.chenge.ink` 已能经 tunnel 到达本机 `127.0.0.1:8200`。
- 本机 serve-api 已起，`curl http://127.0.0.1:8200/api/health` 返回 `{"status":"ok",...}`。

---

## Step 1 — 进入 Zero Trust → Access → Applications

1. 登录 Cloudflare Dashboard（dash.cloudflare.com）。
2. 左侧栏选 **Zero Trust**（旧称 Teams；首次进入会要你给 team 起个名字，
   团队域名形如 `chenyq.cloudflareaccess.com` —— 记住它，对应 `.env` 的 `CF_TEAM_DOMAIN`）。
3. 左侧栏 **Access → Applications**。
4. 点右上 **Add an application**。

> 截图位置：进入 Zero Trust 后，顶部面包屑应为 `Zero Trust / Access / Applications`，
> 右上角有蓝色 `Add an application` 按钮。

---

## Step 2 — 选 Self-hosted 应用类型

1. 应用类型卡片里选 **Self-hosted**（不是 SaaS / Private Network）。
2. 点 **Select**。

> 截图位置：三张大卡片 `SaaS` / `Self-hosted` / `Private Network`，选中间那张。

---

## Step 3 — 配置应用域名

在 **Application Configuration** 表单：

1. **Application name**: 填 `MailAgent`（仅展示用，随意）。
2. **Session Duration**: 选 **30 days**（per device，减少真机反复登录）。
3. **Application domain**：
   - Subdomain = `mail`
   - Domain = `chenge.ink`（下拉选已托管的 zone）
   - Path 留空 = 保护整个 `mail.chenge.ink`（含 `/app/*` 静态与 `/api/*`）。

> 同域路由提醒：web 静态走 Cloudflare Pages（`/app/*`），`/api/*` 走 cloudflared tunnel（→ 8200）。
> 二者都在 `mail.chenge.ink` 域下，**一个 Access application 覆盖整域即可**，无需为 path 分别建应用。
> 若想给 `/api/*` 与 `/app/*` 不同策略才需拆分（本单用户场景无此必要）。

4. 点 **Next**。

> 截图位置：表单含 `Application name` 输入框、`Session Duration` 下拉（选 30 days）、
> `Application domain` 三段式（subdomain / domain / path）。

---

## Step 4 — 配 Identity Provider + Policy（OAuth + 邮箱白名单）

### 4a. Identity provider（Google OAuth）

1. 若尚未配过 Google 登录：左侧 **Settings → Authentication → Login methods → Add new → Google**，
   按向导填 Google OAuth Client ID/Secret（需先在 Google Cloud Console 建 OAuth 凭据，
   回调 URL 用 CF 给的 `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`）。
2. 回到本应用的 **Identity providers** 区，勾选 **Google**（可同时留 One-time PIN 作兜底）。

### 4b. Policy（Allow + 邮箱白名单）

1. **Policy name**: `owner-only`。
2. **Action**: **Allow**。
3. **Configure rules → Include**：
   - Selector = **Emails**
   - Value = `s1021964827@gmail.com`（单用户白名单）。
4. （可选硬化）再加一条 **Require** 规则限定 IdP = Google，杜绝 One-time PIN 旁路。
5. 点 **Next** → **Add application** 保存。

> 截图位置：Policy 编辑区有 `Action` 下拉（选 Allow）、`Include` 规则行（Selector 选 Emails，
> 右侧填邮箱）。保存后回到 Applications 列表能看到 `MailAgent` 一行。

---

## Step 5 — 拿 Audience (AUD) Tag → 填 .env（关键）

L2（FastAPI）靠这个 tag 校验 JWT 的 `aud` claim，**必须拿到并填对**。

1. Applications 列表点 **MailAgent** 这行进详情（或编辑）。
2. 找 **Application Audience (AUD) Tag** —— 一串 hex（约 64 字符），在 **Overview** 或
   应用设置页顶部。点复制。
3. 填进本机 `.env`（远程访问段）：

   ```dotenv
   CF_AUDIENCE=<粘贴刚复制的 AUD Tag>
   # CF_TEAM_DOMAIN 默认 chenyq.cloudflareaccess.com，与你的 team 域一致则不用设
   CF_TEAM_DOMAIN=chenyq.cloudflareaccess.com
   MAILAGENT_API_PORT=8200
   ```

4. **重启 serve-api** 让 `auth.py` 读到新值（打包 app：`env:set` 重启会 reload；
   dev：`pm2 restart mailagent-api`）。

> 截图位置：应用 Overview 页有一行 `Application Audience (AUD) Tag` 加复制图标。
> 别和 `Application ID` 搞混 —— 要的是 **AUD Tag**（喂 `CF_AUDIENCE`）。

> 闭环验证：`CF_AUDIENCE` 留空且未开 `MAILAGENT_API_AUTH_DISABLED` 时，`mailagent serve-api`
> 启动会 RuntimeError 拒起（auth.py:74）。这是故意的 fail-fast，确保生产不裸奔。

---

## Step 6 —（可选）WAF Rate Limiting 硬化

`frontend/REMOTE-ACCESS.md` §6.5 的限流，按需在 **Security → WAF → Rate limiting rules** 加：

| 规则 | 匹配 | 阈值 | 动作 |
|---|---|---|---|
| API per-IP | `/api/*` | > 60 req/min/IP | Managed Challenge |
| API per-email | `/api/*` | > 600 req/min/email | Block |
| 附件下载 per-IP | `/api/attachment/*/download` | > 20 req/min/IP | Block |

单用户场景非必需，但能挡住凭据泄露后的爬取。

---

## 验收 checklist

- [ ] 浏览器开 `https://mail.chenge.ink/api/health` → 被重定向到 CF Access Google 登录页（未登录时）。
- [ ] 用白名单邮箱 OAuth 通过后 → `/api/health` 返回 `{"status":"ok",...}`。
- [ ] 非白名单邮箱登录 → 被 Access 拒绝（403 / "You don't have access"）。
- [ ] 本机 `.env` 的 `CF_AUDIENCE` 已填，serve-api 重启后正常起（无 RuntimeError）。
- [ ] 直 `curl http://127.0.0.1:8200/api/email/list`（无 JWT header）→ 401（L2 兜底在岗）。
- [ ] iOS Safari 开 `https://mail.chenge.ink/app` → Access OAuth → 列表/详情/搜索可用 →
      分享菜单「添加到主屏幕」→ 主屏图标启动无地址栏（PWA standalone）。

---

## 故障速查

| 现象 | 可能原因 | 处置 |
|---|---|---|
| `/api/health` 一直 502 | tunnel 没起 / ingress 端口错 / serve-api 没监听 | `pm2 status mailagent-tunnel`；核对 config.yml 端口 = `MAILAGENT_API_PORT`；`curl 127.0.0.1:8200/api/health` |
| OAuth 通过但 `/api/*` 仍 401 | `CF_AUDIENCE` 没填或填错（拿成 Application ID） | 重新复制 **AUD Tag** 填 `.env`，重启 serve-api |
| serve-api 启动 RuntimeError | `CF_AUDIENCE` 空且未开 dev 旁路 | 填 `CF_AUDIENCE`（生产），或仅 dev 设 `MAILAGENT_API_AUTH_DISABLED=true` + `MAILAGENT_API_DEV=true` |
| 登录页反复跳转 | team 域 / 回调 URL 配错 | 核对 `CF_TEAM_DOMAIN` 与 Google OAuth 回调 `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback` |
| 真机能开网页但加不了主屏 | 不是从 Safari 分享菜单加 / 非 https | 必须 Safari（非 Chrome）+ https + manifest 就位（web build 已含） |
