# Frontend V2 — 远程访问架构（本地 FastAPI + Cloudflare Tunnel + Web SPA + PWA）

> **目的**: V1 Electron ship 之后，加远程访问能力 —— 不在 MacBook Pro Office 的电脑 / iPad /
> iPhone 也能看邮件 + 触发操作（标完成 / 重传 / AI 重跑），可接受体验"稍差"。
>
> **状态**: 设计稿（2026-05-16）— 用户已拍板 3 个核心决策（详见 §0）。Pending：等 V1 Electron app
> ship 之后启动 V2 实施。
>
> **关联**:
> - [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md) — V1 Electron app（先 ship）
> - [`frontend-v1-feature-spec.md`](./frontend-v1-feature-spec.md) §3.8 — V2 远程入口
> - [`frontend-integration-spec.md`](./frontend-integration-spec.md) §2 §4 — 现有 webhook-server / SQLite SSoT 接口面
> - [`frontend-ping-island-integration.md`](./frontend-ping-island-integration.md) — 灵动岛 macOS 本机增强（与远程平行，互不冲突）

---

## 0. TL;DR — 用户已决策

| 决策 | 选择 |
|---|---|
| **远程架构** | ✅ Electron（本机顶配）+ 共享 React + Cloudflare Tunnel + Web SPA（远端） |
| **鉴权** | ✅ Cloudflare Access (Zero Trust, OAuth 邮箱白名单) |
| **移动端** | ✅ Web SPA + PWA manifest（"添加到主屏幕"伪原生） |
| **数据存储** | ❌ 不动 SQLite，**不上 Postgres** |

```
本地 MacBook Pro Office (永远开机 + mail-sync 跑着)
├── data/sync_store.db (SSoT，不动)
├── data/attachments/        (不动)
├── PM2: mail-sync           (现有)
└── PM2: mailagent-api       ← 新增本地 FastAPI 127.0.0.1:8200

   ↓ Electron IPC              ↓ HTTPS via cloudflared
┌──────────────────┐   ┌───────────────────────────────────────┐
│ Electron App     │   │  Web SPA / PWA (mail.chenge.ink/app)  │
│ macOS 本机       │   │  iPad / iPhone / 借的电脑              │
│ ~4ms 命中体验    │   │  ~200-400ms 体验，Cloudflare Access 守 │
│ 同一份 React     │   │  同一份 React (build:web)             │
└──────────────────┘   └───────────────────────────────────────┘
```

工作量：V1 Electron plan 之上 **+4-6 天**。

---

## 1. 为什么不上 Postgres

| 问题 | Postgres 路径 | Cloudflare Tunnel 路径（推荐） |
|---|---|---|
| Mail.app + AppleScript 必须在 macOS | ❌ MacBook 还是得开机 sync 新邮件 | ✅ 同样要开机，但本来就是这样 |
| 附件二进制（~GB 且只增不减） | ❌ S3 类对象存储 + 公网下载 = 钱 + 延迟 | ✅ 远端 lazy stream，不预同步 |
| 改动量 | ❌ EmailRepository 重写 / FTS5 → pg_tsearch（中文搜索能力降级，要装额外 ext）/ schema migration / WAL 双写 / 失败回滚 | ✅ 0 改动到核心，新加 FastAPI 暴露层即可 |
| 离线 / 断网体验 | ❌ 本地工具变 online-only | ✅ 断网时 Electron 本机直读不受影响 |
| 同步一致性 | ❌ 多一套同步：SQLite ↔ Postgres + S3 ↔ 远端 | ✅ 单源 |
| 远程访问需求实质 | 看 + 标完成 + 偶尔搜，**不是高并发写** | ✅ 完美对齐 |

**核心洞察**：远程访问的瓶颈是 **传输**，不是 **存储**。SQLite 完全够用，只需要把访问层暴露出去。

---

## 2. 接口分工 — 本地 FastAPI vs 远程 webhook-server

**两个 FastAPI 服务，职责完全不同，不要合并。**

| 维度 | 本地 mailagent-api（新增 V2）| 远程 webhook-server（现有） |
|---|---|---|
| 运行位置 | MacBook Pro Office 本机 | 腾讯云 Ubuntu (170.106.181.89) |
| 端口 / 域名 | `127.0.0.1:8200` → Cloudflare Tunnel → `mail.chenge.ink` | `170.106.181.89:8100` → `mailagent.chenge.ink` |
| 主要消费方 | 前端 React（Electron renderer / Web SPA / PWA） | Notion Automation / 外部 agent (Openclaw / 飞书 callback) |
| 端点形态 | `/api/email/*` `/api/attachment/*` `/api/llm/*` `/api/admin/*` | `/webhook/notion` `/command` `/dashboard/*` `/stats/report` |
| 数据来源 | 直接 `from src.repository import EmailRepository` + subprocess 调 `mailagent` CLI | Redis 入队 → 本地服务消费 |
| 鉴权 | Cloudflare Access (Zero Trust OAuth) | Notion HMAC / X-API-Key / DASHBOARD_PASSWORD（分端点） |
| 启动 | PM2 `mailagent-api` 进程，与 `mail-sync` 同机器但独立进程 | PM2 `mailagent-webhook` 进程 |
| 关停影响 | 远程前端不可用，本机 Electron 直读 SQLite 不受影响 | Notion → Mail 实时同步停（重要邮件标旗、AI Reviewed 联动失效） |

**为什么不合并到远程 webhook-server**:
- webhook-server 不能直读 SQLite（在云上，本机数据库）
- 要走 SSH 中转或 Redis 中转，每个请求 +100-300ms 延迟
- 走 cloudflare tunnel 直接暴露本机 FastAPI 反而更快

**为什么不直接复用 V1 Electron main 进程的 IPC handler**:
- Electron main 进程 IPC handler 是 in-process call（不走网络），无法暴露
- FastAPI 是独立 Python 进程，能跟 mail-sync 共享 SQLite，跟 cloudflared 配对
- 本机 Electron 仍走 IPC 走 better-sqlite3 直读（~4ms）；FastAPI 路径仅给远端

---

## 3. 本地 FastAPI（mailagent-api）设计

### 3.1 端口与启动

```bash
# 启动（PM2 管理，与 mail-sync 并存）
pm2 start "uvicorn src.api.app:app --host 127.0.0.1 --port 8200" \
  --name mailagent-api --interpreter ./venv/bin/python3

# 关键：bind 127.0.0.1，不监听 0.0.0.0
# 唯一对外通道是 cloudflared 这条 tunnel，公网无法直连端口
```

### 3.2 模块布局

```
src/api/
  app.py                    FastAPI 实例 + middleware (auth / logging / CORS)
  deps.py                   依赖注入 (EmailRepository / settings)
  routers/
    email.py                /api/email/{list,get,body,search,resync,update-flag}
    attachment.py           /api/attachment/{list,download}  ← stream
    llm.py                  /api/llm/{stats,run,retry-failed}
    admin.py                /api/admin/{stats,health,dead-letter,backfill-status}
    events.py               /api/events (SSE) — 可选 V2.1
  schemas/                  pydantic 模型（复用 docs/cli-schema/ 的形状）
  auth.py                   Cloudflare Access JWT 校验 + API key fallback
  cli_runner.py             subprocess 调 mailagent CLI（写操作）+ 退出码 → HTTP code 映射
```

### 3.3 端点契约（与 CLI 对齐）

读端点直接 import `EmailRepository`，写端点 subprocess 调 `mailagent` CLI（已有 typer + JSON 契约）。
**绝大多数端点是现有 CLI schema 的 HTTP wrap**，不重新设计契约。

| 端点 | 实现 | 复用 |
|---|---|---|
| `GET /api/email/list` | `EmailRepository` 直查 + `email_metadata` filter | `docs/cli-schema/email-list.schema.json` |
| `GET /api/email/{id}` | `EmailRepository.get` | `email-get.schema.json` |
| `GET /api/email/{id}/body?format={markdown\|html\|raw}` | `EmailRepository.get_body_*` | `email-body.schema.json` |
| `GET /api/email/search?q=...&limit=...` | `EmailRepository.search_email_bodies`（FTS5 bm25 + snippet） | `email-search.schema.json` |
| `POST /api/email/{id}/resync` | `subprocess: mailagent email resync {id} --dry-run --api-key ${LOCAL_KEY}` | RFC §5 长任务契约 |
| `POST /api/email/{id}/update-flag` | `subprocess: mailagent notion update-flag {id} ...` | |
| `GET /api/attachment/list/{internal_id}` | `EmailRepository.get_attachments` | `attachment-list.schema.json` |
| `GET /api/attachment/{att_id}/download` | `StreamingResponse(open(local_path, 'rb'))` Content-Disposition | binary stream |
| `POST /api/llm/run/{id}` | `subprocess: mailagent llm run {id}` | |
| `GET /api/llm/stats?days=7` | `EmailRepository`-style 查 `llm_processing` | `llm-stats.schema.json` |
| `GET /api/admin/stats` | 复用现有 webhook-server `/admin/stats` 形状 | （无 schema） |
| `GET /api/admin/health` | 同 `mailagent admin health` | `admin-health.schema.json` |

**统一响应包装**（与 CLI JSON 一致）:

```jsonc
{
  "status": "success" | "error",
  "schema_version": 1,
  "data": <route-specific>,
  "error": {"code": "E_NOT_FOUND", "message": "...", "hint": "..."} | null,
  "meta": {"duration_ms": 12, "source": "sqlite" | "cli"}
}
```

HTTP 状态码与 CLI 退出码映射：

| HTTP | CLI exit | 含义 |
|---|---|---|
| 200 | 0 | OK |
| 400 | 2 | 参数错误 |
| 401 / 403 | 4 | 鉴权失败 |
| 404 | 1 | 资源未找到 |
| 409 | 9 | PM2 冲突（写命令被拒绝） |
| 422 | 2 | pydantic 校验错 |
| 500 | 1 | 通用错误 |
| 502 / 503 | 5 | 上游错误 |
| 207 | 6 | partial_failure (batch) |

---

## 4. Data Layer Abstraction — 前端 90% 代码共享

```typescript
// shared/api/types.ts
export interface MailApi {
  email: {
    list(opts: ListOpts): Promise<EmailMeta[]>;
    get(id: number): Promise<EmailFull>;
    body(id: number, format: BodyFormat): Promise<string>;
    search(opts: SearchOpts): Promise<SearchHit[]>;
    resync(id: number, opts: ResyncOpts): Promise<ResyncResult>;
    updateFlag(id: number, opts: FlagOpts): Promise<void>;
  };
  attachment: {
    list(internalId: number): Promise<AttachmentMeta[]>;
    downloadUrl(attId: number): string;  // Electron: file://; Web: /api/attachment/{id}/download
  };
  llm: { run(id: number): Promise<LlmResult>; stats(days: number): Promise<LlmStats> };
  admin: { health(): Promise<HealthSnapshot>; stats(): Promise<AdminStats> };
}

// shared/api/factory.ts
export function makeMailApi(): MailApi {
  if (import.meta.env.VITE_BUILD_TARGET === 'electron') {
    return new ElectronApi();   // 走 window.api IPC，main 进程 better-sqlite3 直读
  }
  return new HttpApi(baseUrl);   // 走 fetch + cookie / Access JWT
}

// shared/components/EmailList.tsx
const api = useMailApi();
const { data } = useQuery(['email/list', opts], () => api.email.list(opts));
// 这个组件不知道也不关心数据是 IPC 来的还是 HTTP 来的
```

**两个实现的契约必须完全相同** — 同一份 zod schema 在两边都做 runtime validate，错就 throw。

---

## 5. Vite 多 target build

```
package.json scripts:
  "dev:electron"        electron-vite dev (electron main + renderer)
  "dev:web"             vite dev --config vite.web.config.ts → :5173
  "build:electron"      electron-vite build → out/electron/{main,preload,renderer}
  "build:web"           vite build --config vite.web.config.ts → out/web/ (static SPA)
  "preview:web"         vite preview

vite.web.config.ts:
  - 入口 src/web/main.tsx（包 service worker + PWA manifest 注入）
  - 不打 Electron 专用 deps（better-sqlite3 / execa / keytar）
  - 用 VITE_BUILD_TARGET=web 决定 api factory 走 HttpApi
  - 静态产物上传到 Cloudflare Pages / 或本地服务一并 serve（FastAPI mount static）
```

**部署 Web SPA 的两个选择**:

| 选择 | 描述 | 利 | 弊 |
|---|---|---|---|
| **A. Cloudflare Pages（推荐）** | `out/web/` 推 GitHub → Pages 自动部署 → 走 `mail.chenge.ink` | CDN 全球节点，SPA 静态资源命中 < 50ms | 多一个部署 pipeline |
| B. FastAPI mount static | `app.mount("/app", StaticFiles(...))` → 同 tunnel | 一条 tunnel 全包 | SPA 资源也走 macOS 上行带宽 |

推荐 **A** —— SPA 资源走 CDN，API 走 tunnel，分离最干净。

---

## 6. Cloudflare Tunnel + Access 配置

### 6.1 Tunnel（本机起 cloudflared）

```bash
# 一次性安装
brew install cloudflared
cloudflared tunnel login        # 浏览器 OAuth 到 Cloudflare 账号

# 创建 tunnel（一次性）
cloudflared tunnel create mailagent-local
# 输出 tunnel UUID + credentials JSON 到 ~/.cloudflared/<uuid>.json

# 配置 ~/.cloudflared/config.yml
cat > ~/.cloudflared/config.yml <<EOF
tunnel: <uuid>
credentials-file: /Users/chenyuanquan/.cloudflared/<uuid>.json
ingress:
  - hostname: mail.chenge.ink
    service: http://127.0.0.1:8200
  - service: http_status:404
EOF

# DNS（一次性）
cloudflared tunnel route dns mailagent-local mail.chenge.ink

# 启动（PM2 长驻）
pm2 start cloudflared --name mailagent-tunnel -- tunnel run mailagent-local
pm2 save
```

### 6.2 Access (Zero Trust OAuth 白名单)

Cloudflare Dashboard → Zero Trust → Access → Applications：

1. **Add an application** → Self-hosted
2. Application domain: `mail.chenge.ink`
3. Identity providers: Google（或 GitHub）
4. **Policy**:
   - Name: `mailagent-owner`
   - Action: Allow
   - Include: Emails → `s1021964827@gmail.com`（用户邮箱）
   - Optional: Require → Country = CN/US（按需）
5. **Session duration**: 24h（远端登一次 cookie 塞 24h）

**前端不需要写鉴权代码**：
- 浏览器访问 `mail.chenge.ink` → Cloudflare 拦截 → OAuth → 通过后塞 cookie `CF_Authorization`
- 后续请求 cloudflared 转发到本机 FastAPI 时已带 JWT header `Cf-Access-Jwt-Assertion`
- FastAPI middleware 校验 JWT（拿 Cloudflare team 的 public key），不通过返 401

```python
# src/api/auth.py（伪代码）
from fastapi import Request, HTTPException
import jwt, httpx

CF_TEAM_DOMAIN = "chenyq.cloudflareaccess.com"
CF_AUDIENCE = "<application-audience-tag>"
_jwks = httpx.get(f"https://{CF_TEAM_DOMAIN}/cdn-cgi/access/certs").json()

async def verify_cf_access(request: Request):
    token = request.headers.get("Cf-Access-Jwt-Assertion")
    if not token:
        raise HTTPException(401, "no access JWT")
    try:
        # PyJWT，audience 必须匹配
        jwt.decode(token, key=_jwks, algorithms=["RS256"], audience=CF_AUDIENCE)
    except jwt.PyJWTError as e:
        raise HTTPException(403, f"access JWT invalid: {e}")
```

### 6.3 安全分层

```
公网                     mail.chenge.ink
  ↓ HTTPS (cloudflare 边缘)
Cloudflare Access       OAuth + 邮箱白名单（你的 google 账号 only）
  ↓ JWT 注入
cloudflared (本机)      Tunnel 出口
  ↓
FastAPI 127.0.0.1:8200  middleware 二次校验 JWT (防 tunnel 误配)
  ↓
EmailRepository / CLI   本机 SQLite + 文件
```

**4 层防御**：Cloudflare 边缘 + Access OAuth + JWT 二次校验 + bind 127.0.0.1（公网无法直连端口）。

---

## 7. PWA 设计（iOS / iPad "添加到主屏幕"）

### 7.1 manifest.json

```json
{
  "name": "MailAgent",
  "short_name": "MailAgent",
  "description": "macOS 邮件 → Notion 实时同步系统",
  "start_url": "/app/",
  "scope": "/app/",
  "display": "standalone",
  "background_color": "#0F0F10",
  "theme_color": "#0F0F10",
  "icons": [
    { "src": "/app/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/app/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/app/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

### 7.2 Service Worker（Workbox）

```typescript
// shared/web/sw.ts
import { precacheAndRoute } from 'workbox-precaching';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { registerRoute } from 'workbox-routing';

precacheAndRoute(self.__WB_MANIFEST);  // app shell

// API 数据不缓存（永远 fresh）
registerRoute(
  ({ url }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({ cacheName: 'api', networkTimeoutSeconds: 8 })
);

// 静态资源
registerRoute(
  ({ request }) => ['script', 'style', 'image'].includes(request.destination),
  new CacheFirst({ cacheName: 'static-v1' })
);
```

**不缓存邮件数据** —— 邮件状态变化太快，缓存反而误导用户（已读 → 还显示未读）。

### 7.3 iOS "添加到主屏幕"

- iOS Safari 在 `mail.chenge.ink/app` 打开 → 分享菜单 → "添加到主屏幕"
- 配 `apple-touch-icon` + `apple-mobile-web-app-capable` meta
- 启动后看起来像原生 app（无 Safari 地址栏 / tab bar）

---

## 8. 远端体验目标 / SLO

| 操作 | 本地 Electron | 远端 Web（目标） | 远端可接受？ |
|---|---|---|---|
| 邮件列表（50 封） | ~10ms | P95 < 500ms | ✅ |
| 邮件详情打开（markdown） | ~20ms | P95 < 800ms | ✅ |
| 全文搜索 | ~50ms | P95 < 1.2s | ✅ |
| 附件下载（5MB PDF） | 文件 file:// 秒开 | 流式 ~3-5s | ✅ |
| 附件下载（50MB） | file:// | 流式 ~30s + 等下载条 | ⚠️ 用户教育"远端慢" |
| 邮件 HTML 沙箱渲染 | iframe srcdoc | 同 iframe srcdoc | ✅ |
| 内联图片 (cid:) | `file://` 路径替换 | API endpoint `/api/attachment/{id}/inline` | ✅ |
| 标完成 / 标旗 | CLI ~200ms | API → CLI ~400ms | ✅ |
| 邮件重传 Notion (resync) | CLI ~2-5s | API → CLI ~2-5s | ✅ |
| 长任务（backfill） | 进度条 + 取消 | SSE 推进度 + 取消 | ⚠️ 远端做减法 |

**远端做减法**：
- 不做附件批量下载（用户应该回本机用 Electron）
- 不做长任务（backfill / resync --range 1000-5000） — 长任务只允许 Electron 端发起
- 不做命令面板（cmd+k 是本机生产力工具，远端用搜索）
- 不做实时新邮件推送 V2.0；V2.1 SSE 再加

---

## 9. 安全 Checklist

| 项 | 实施 |
|---|---|
| HTTPS only | ✅ Cloudflare 自动 |
| Cloudflare Access 邮箱白名单 | ✅ Zero Trust policy |
| FastAPI bind 127.0.0.1 | ✅ uvicorn `--host 127.0.0.1` |
| FastAPI 二次校验 Cf-Access-Jwt-Assertion | ✅ middleware |
| CORS 严格（仅 `mail.chenge.ink` 域） | ✅ `allow_origins=["https://mail.chenge.ink"]` |
| API key（CLI 写命令）不入前端 bundle | ✅ 写命令在 FastAPI 后端 subprocess 注入 `--api-key` |
| 附件路径 traversal 防护 | ✅ `local_path` 必须是 `data/attachments/` 子路径，pathlib resolve 校验 |
| 邮件 HTML 沙箱 | ✅ iframe srcdoc + DOMPurify 二次清洗 |
| 邮件外链点击 | ✅ 拦截 + 显示确认 dialog（防 phishing） |
| Service worker 不缓存 API 数据 | ✅ NetworkFirst 仅 timeout 兜底 |
| FastAPI 速率限制 | ⚠️ Cloudflare 边缘已有；V2.1 再加 redis token bucket |
| 审计日志 | ⚠️ FastAPI middleware 记 `who / what / when` 到 `data/api_audit.log` |
| 备份 | ✅ SQLite 每天 `cp` 一份到 iCloud Drive（macOS 现有方案） |

**密钥管理**：
- Cloudflare API token（部署用） → 1Password
- `MAILAGENT_CLI_API_KEY`（写命令鉴权） → `.env` 本机
- Cloudflare Access JWT audience tag → `.env` 本机 + FastAPI 校验

---

## 10. 工作量分解（V1 之上 +4-6 天）

V1 Electron app 完工后启动：

### Sprint V2-1: 本地 FastAPI 骨架（1.5 天）

- [ ] `src/api/app.py` + middleware + auth
- [ ] `src/api/routers/email.py` — list / get / body / search 4 个端点
- [ ] `src/api/cli_runner.py` — subprocess wrapper + 退出码 → HTTP 映射
- [ ] PM2 ecosystem 配置（与 mail-sync 同机器并存）
- [ ] curl 自测 `127.0.0.1:8200/api/health`

### Sprint V2-2: 端点全集 + 附件 stream（1 天）

- [ ] `attachment` / `llm` / `admin` 路由
- [ ] StreamingResponse 附件下载（Range 头支持便于断点续传）
- [ ] internal_id / attachment_id 校验 + 404 路径
- [ ] pytest fixture 跑一遍

### Sprint V2-3: Data layer abstraction + Vite web target（1.5 天）

- [ ] `shared/api/` 抽 MailApi interface + ElectronApi / HttpApi 两个实现
- [ ] Vite web config + entry `src/web/main.tsx`
- [ ] 全 React 组件 review 一遍，确认无 Electron-only 引用泄漏（better-sqlite3 / execa / keytar 必须只在 Electron 入口）
- [ ] `npm run dev:web` 起来跑通 list + detail + search 三个核心页

### Sprint V2-4: Cloudflare Tunnel + Access + PWA（1 天）

- [ ] `cloudflared` 装 + tunnel 创 + DNS 配
- [ ] Cloudflare Access 配 OAuth + email 白名单
- [ ] FastAPI middleware 校验 Cf-Access-Jwt-Assertion
- [ ] PWA manifest + workbox service worker
- [ ] iOS Safari "添加到主屏幕"实测

### Sprint V2-5: 部署 + Polish（1 天）

- [ ] Cloudflare Pages 接 GitHub repo（web build 推到 `gh-pages` 或单独 branch）
- [ ] 远端 SLO 测试（iPad / iPhone 实跑一遍）
- [ ] CSP / CORS / 安全 checklist 逐条验
- [ ] 文档 / README / .env.example 更新

**合计 6 天**（含 polish），最快 4 天（不含 polish）。

---

## 11. V2 暂不做（V2.1 / V3 议题）

- ❌ 真实时推送（SSE / WS 邮件新到达）— V2.1，先用 30s 轮询
- ❌ 多用户 — 单用户白名单已够
- ❌ 远端发起长任务（backfill body / derivatives）— 长任务必须 Electron 端
- ❌ 远端编辑回复草稿 in-app — 草稿走 Mail.app，远端只能触发"创建草稿"，写还是回本机
- ❌ iOS / Android 原生 app — PWA 够用，原生是 V3+
- ❌ 离线邮件查看（本地缓存最近 N 封） — 远端默认 online，离线场景用 Electron
- ❌ Postgres / 云数据库 — §1 已论证

---

## 12. 风险 / 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| MacBook 休眠 → tunnel 断 → 远端不可用 | 高 | 中 | `caffeinate -d -i -m -s` 常驻 / 外接显示器 / 关闭"睡眠时关闭显示器"以外其他自动休眠 |
| MacBook 重启 → cloudflared / mailagent-api 没起 | 中 | 中 | `pm2 save` + `pm2 startup` 配开机自启 |
| Cloudflare Access cookie 24h 过期需要重登 | 高 | 低 | 把 session duration 调到 30 天 |
| 公网攻击者尝试爆破 mail.chenge.ink | 高 | 低 | Access OAuth 拦在最外层，未通过 OAuth 根本到不了 FastAPI |
| FastAPI 内存泄漏 / 卡死 | 低 | 中 | PM2 `--max-memory-restart 500M` 自动重启；监控 `/api/admin/health` |
| 长尾远端用户拿到旧 SPA 缓存 | 中 | 低 | service worker `skipWaiting` + 版本号注入；用户首次打开自动升级 |
| Cloudflare 全球抽风（罕见但发生过） | 低 | 高 | 本机 Electron 直读完全不受影响，远端临时不可用 |

---

## 13. 下一步

1. ✅ 决策已定（用户 2026-05-16 拍板）
2. ⏳ V1 Electron app ship —— [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md) 7 个 Sprint
3. 🚧 V1 ship 后进入本文档 V2-1 ~ V2-5
4. 与 [`frontend-ping-island-integration.md`](./frontend-ping-island-integration.md) Stage B（fork ping-island）并行 —— ping-island 是 macOS 本机增强，与远程访问不冲突

---

> 本文档与 V1 plan 独立演进。V1 Electron 实现的 React 组件 / store / 路由必须从 Sprint 0
> 起就用 data layer abstraction 写（即 `useMailApi()` 而不是直调 `window.api.email.list`），
> V2 才能零改动复用。这是 V1 实施时**必须遵守的硬约束**。
