# MailAgent V2 — 远程访问架构

> V1 Electron ship 之后启动 V2 远程访问：不在 MacBook Pro Office 时通过 iPad / iPhone /
> 借的电脑也能看邮件 + 触发操作。**SQLite 不上云**，本地 FastAPI 暴露 + Cloudflare Tunnel +
> Web SPA + PWA。
>
> **状态**: 用户已拍板 2026-05-16 走此方案。等 V1 Sprint 5+ 启动。
>
> **关联**:
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) §2.5 鉴权分层 / §3.3 V2 数据流
> - [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §4 V2 Sprint 拆分
> - [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) §2 本地 vs 远程 FastAPI
> - [`DESIGN.md`](./DESIGN.md) §16 i18n + §17 三态主题

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| 远程架构 | Electron（本机顶配）+ 共享 React + Cloudflare Tunnel + Web SPA（远端） |
| 鉴权 | Cloudflare Access (Zero Trust, Google OAuth + 邮箱白名单) |
| 移动端 | Web SPA + PWA manifest（"添加到主屏幕"伪原生） |
| 数据存储 | **SQLite 不动**，❌ Postgres / S3 / 云数据库 |
| 工作量 | V1 之上 +4-6 天 |

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

---

## 1. 为什么不上 Postgres

| 维度 | Postgres 路径 | Cloudflare Tunnel 路径（推荐） |
|---|---|---|
| Mail.app + AppleScript 必须 macOS | ❌ MacBook 还是得开机 | ✅ 同要开机，本来就是这样 |
| 附件二进制（GB 级只增）| ❌ S3 / 公网下载 = 钱 + 延迟 | ✅ lazy stream |
| 改动量 | ❌ EmailRepository 重写 / FTS5 → pg_tsearch / schema migration / WAL 双写 | ✅ 0 改动核心，新加 FastAPI 暴露层 |
| 离线 / 断网 | ❌ 本地变 online-only | ✅ Electron 直读不受影响 |
| 同步一致性 | ❌ 多套同步 | ✅ 单源 |
| 远程访问需求 | 看 + 标完成 + 偶尔搜 | ✅ 完美对齐 |

**核心洞察**: 远程访问瓶颈是 **传输**，不是 **存储**。SQLite 完全够用。

---

## 2. 接口分工 — 本地 vs 远程 FastAPI

两个独立 FastAPI 服务，**职责完全不同，不合并**。详见 [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) §2。

| 维度 | 本地 mailagent-api（V2 新增）| 远程 webhook-server（现有） |
|---|---|---|
| 位置 | MacBook Pro 本机 | 腾讯云 (170.106.181.89) |
| 端口 / 域名 | `127.0.0.1:8200` → tunnel → `mail.chenge.ink` | `170.106.181.89:8100` → `mailagent.chenge.ink` |
| 主要消费方 | 前端 React | Notion Automation / 外部 agent |
| 鉴权 | Cloudflare Access OAuth | Notion HMAC / X-API-Key |

---

## 3. 本地 FastAPI 设计

### 3.1 启动

```bash
pm2 start "uvicorn src.api.app:app --host 127.0.0.1 --port 8200" \
  --name mailagent-api --interpreter ./venv/bin/python3

# 关键：bind 127.0.0.1，不监听 0.0.0.0
# 唯一对外通道是 cloudflared tunnel，公网无法直连端口
```

### 3.2 模块布局

```
src/api/
  app.py                    FastAPI 实例 + middleware (auth / CORS / logging / i18n)
  deps.py                   依赖注入 (EmailRepository / settings)
  routers/
    email.py                /api/email/{list,get,body,search,resync,update-flag}
    attachment.py           /api/attachment/{list,download}  ← stream
    llm.py                  /api/llm/{stats,run,retry-failed}
    admin.py                /api/admin/{stats,health,dead-letter,backfill-status}
    events.py               /api/events (SSE) — 可选 V2.1
  schemas/                  pydantic 模型（复用 docs/cli-schema/ 形状）
  auth.py                   Cloudflare Access JWT 校验
  cli_runner.py             subprocess 调 mailagent CLI（写操作）
```

### 3.3 端点契约（与 CLI 对齐）

读端点直接 import `EmailRepository`，写端点 subprocess 调 `mailagent` CLI。
**绝大多数端点是现有 CLI schema 的 HTTP wrap**，不重新设计契约。详 [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) §2.4。

### 3.4 统一响应（与 CLI 一致）

```jsonc
{
  "status": "success" | "error",
  "schema_version": 1,
  "data": <route-specific>,
  "error": null | {"code": "E_NOT_FOUND", "message": "...", "hint": "..."},
  "meta": {"duration_ms": 12, "source": "sqlite" | "cli"}
}
```

HTTP 状态码 → CLI 退出码映射 详 [`BACKEND-INTERFACES.md`](./BACKEND-INTERFACES.md) §1.3。

### 3.5 i18n 在 API 层的位置

- **错误 message**: 后端**不做** i18n — 返回 `error.code` (英文 enum) + `error.message` (描述性英文)
- 前端拿到 `error.code` → 走 react-i18next 翻译成用户语言
- 这跟 CLI 行为一致（CLI 输出也是英文 code + 描述）
- 为什么不在后端 i18n：后端不知道用户语言 / 维护两套字符串 / locale 不该跨进程传递

---

## 4. Data Layer Abstraction — 前端 90% 代码共享

### 4.1 MailApi interface（shared）

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
```

### 4.2 两个实现

```typescript
// shared/api/factory.ts
export function makeMailApi(): MailApi {
  if (import.meta.env.VITE_BUILD_TARGET === 'electron') {
    return new ElectronApi();   // IPC + better-sqlite3 (本机 ~4ms)
  }
  return new HttpApi(baseUrl);  // fetch + Cf-Access cookie (远端 ~200-400ms)
}

// shared/components/EmailList.tsx
const api = useMailApi();
const { data } = useQuery(['email/list', opts], () => api.email.list(opts));
// 这个组件不知道也不关心数据是 IPC 来的还是 HTTP 来的
```

### 4.3 V1 Sprint 0 起的硬约束

- ✅ 所有 React 组件**必须**通过 `useMailApi()` 调数据
- ❌ 不能直接 `window.electron.email.list(...)` —— 否则 V2 Web 重写
- ✅ Zod schema 在两端 runtime validate，错就 throw
- 详 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) Sprint 0 完工 checklist

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
  - 入口 src/web/main.tsx (含 service worker + PWA manifest 注入)
  - 不打 Electron-only deps (better-sqlite3 / execa / keytar)
  - VITE_BUILD_TARGET=web 决定 api factory 走 HttpApi
  - 静态产物上传到 Cloudflare Pages
```

**部署 Web SPA**:
- **Cloudflare Pages（推荐）**: `out/web/` 推 `gh-pages` branch → Pages 自动部署 → `mail.chenge.ink`
- CDN 全球节点，SPA 静态资源命中 < 50ms；API 走 tunnel，分离最干净

---

## 6. Cloudflare Tunnel + Access 配置

### 6.1 Tunnel（本机起 cloudflared）

```bash
brew install cloudflared
cloudflared tunnel login

cloudflared tunnel create mailagent-local
# 输出 tunnel UUID + credentials JSON 到 ~/.cloudflared/<uuid>.json

cat > ~/.cloudflared/config.yml <<EOF
tunnel: <uuid>
credentials-file: /Users/chenyuanquan/.cloudflared/<uuid>.json
ingress:
  - hostname: mail.chenge.ink
    service: http://127.0.0.1:8200
  - service: http_status:404
EOF

cloudflared tunnel route dns mailagent-local mail.chenge.ink

pm2 start cloudflared --name mailagent-tunnel -- tunnel run mailagent-local
pm2 save
```

### 6.2 Access (Zero Trust OAuth 白名单)

Cloudflare Dashboard → Zero Trust → Access → Applications:

1. **Add an application** → Self-hosted
2. Application domain: `mail.chenge.ink`
3. Identity providers: Google（或 GitHub）
4. **Policy**:
   - Action: Allow
   - Include: Emails → `s1021964827@gmail.com`（同账号 iPad / iPhone / 借的电脑都用同一 Google identity）
5. **Session duration**: 30 天 **per device**（iPad / iPhone / Mac borrowed 各自独立 session，单设备登出不影响其他）

**前端不写鉴权代码**：
- 浏览器访问 `mail.chenge.ink` → Cloudflare 拦截 → OAuth → 塞 cookie `CF_Authorization`
- 后续请求 cloudflared 转发到本机 FastAPI 时已带 JWT header `Cf-Access-Jwt-Assertion`
- FastAPI middleware 校验 JWT，不通过返 401

### 6.3 FastAPI 二次校验（REVIEW-LOG.md C-01 重写 — 原版本 PyJWT API 误用 + 无 key rotation）

```python
# src/api/auth.py
from fastapi import Request, HTTPException
import jwt
from jwt import PyJWKClient

CF_TEAM_DOMAIN = "chenyq.cloudflareaccess.com"
CF_AUDIENCE = "<application-audience-tag>"   # 从 CF Zero Trust dashboard 拿
CF_ISSUER = f"https://{CF_TEAM_DOMAIN}"

# 1) lazy + cache by kid + 自动 refresh on unknown key（CF key rotation 友好）
# 2) 进程启动不阻塞 — 第一次 verify 时才拉 JWKS
_jwk_client = PyJWKClient(
    f"{CF_ISSUER}/cdn-cgi/access/certs",
    cache_keys=True,
    lifespan=3600,            # JWKS in-memory cache 1h
    max_cached_keys=8,
)

async def verify_cf_access(request: Request):
    token = request.headers.get("Cf-Access-Jwt-Assertion")
    if not token:
        raise HTTPException(401, "no access JWT")
    try:
        signing_key = _jwk_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key=signing_key.key,
            algorithms=["RS256"],
            audience=CF_AUDIENCE,
            issuer=CF_ISSUER,
            options={"require": ["exp", "iat", "iss", "aud"]},
        )
        # identity 只从 verified claims 取，绝不信任 CF-Access-Authenticated-User-Email header alone
        request.state.user_email = claims.get("email")
    except jwt.PyJWTError as e:
        raise HTTPException(403, f"access JWT invalid: {e}")
```

**为什么这版正确**:
- `PyJWKClient` 按 `kid` 自动缓存 + unknown kid 时 refresh —— CF 月度 key rotation 不停机。
- 校验 iss / aud / exp / iat 必须存在；alg 白名单只 RS256（防 `alg=none` 攻击）。
- identity 从 verified JWT claims 的 `email` 取，不读 `CF-Access-Authenticated-User-Email` header（CF 边缘 header 不能信任，tunnel 误配时可被伪造）。
- 进程启动不拉 JWKS（lazy），uvicorn 启动快。

### 6.4 安全分层（修订 — REVIEW-LOG H-04：原 "4 层" 误称）

```
公网                     mail.chenge.ink
  ↓ HTTPS (cloudflare 边缘 TLS 终止)
Cloudflare Access       [鉴权 L1] OAuth + 邮箱白名单
  ↓ JWT 注入
cloudflared (本机)      Tunnel 出口
  ↓
FastAPI 127.0.0.1:8200  [鉴权 L2] middleware 二次校验 JWT (防 tunnel 误配 leak)
  ↓
EmailRepository / CLI   本机 SQLite + 文件
```

**纵深 2 层独立鉴权 + 3 层外围加固**：

| 层 | 类型 | 说明 |
|---|---|---|
| **鉴权 L1**: Cloudflare Access OAuth | 独立 SoT | 邮箱白名单；30 天 session per device；用户感知（OAuth 跳转） |
| **鉴权 L2**: FastAPI JWT 二次校验 | 共享 SoT (同 JWKS) | 防 tunnel 误配或 CF 边缘 bypass — JWT 仍是 CF 签发，但任何绕过 CF 边缘的请求（直连 cloudflared）这层会挡掉 |
| **加固 G1**: HTTPS + CF WAF | 边缘 | TLS 终止 + WAF rate limit / IP reputation |
| **加固 G2**: bind 127.0.0.1 | 网络 | uvicorn 仅监听 loopback，外部网卡不可达 |
| **加固 G3**: API key 不入前端 bundle | 应用 | CLI 写命令的 `MAILAGENT_CLI_API_KEY` 仅在 FastAPI 后端 subprocess 注入 |

**注意**：L1 与 L2 都依赖同一 CF Access JWKS — bypass/misconfig CF Access 等于同时 bypass 两层。L2 不是"独立第二把锁"，而是"防 tunnel 误配把 8200 端口直接暴露公网时的兜底"。

### 6.5 CF WAF rate limit policy（REVIEW-LOG H-04 新增）

Cloudflare Dashboard → Security → WAF → Rate limiting rules:

| Rule | 触发条件 | 动作 |
|---|---|---|
| Per-IP `/api/*` | 同 IP > 60 req/min | challenge（managed） |
| Per-email `/api/*` | 同 `cf-access-authenticated-user-email` > 600 req/min | block 1h |
| Per-IP `/api/attachment/*/download` | 同 IP > 20 req/min（限大文件刷流量）| block 5min |

启动时在 uvicorn `app.on_event("startup")` 加 assertion 失败立即退出：
```python
@app.on_event("startup")
async def assert_bind_loopback():
    server_host = os.environ.get("UVICORN_HOST", "127.0.0.1")
    assert server_host == "127.0.0.1", f"FastAPI MUST bind 127.0.0.1, got {server_host}"
```

---

## 7. PWA 设计

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

### 7.2 Service Worker (Workbox)

```typescript
// shared/web/sw.ts
import { precacheAndRoute } from 'workbox-precaching';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { registerRoute } from 'workbox-routing';

precacheAndRoute(self.__WB_MANIFEST);   // app shell

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

**不缓存邮件数据** — 邮件状态变化太快，缓存反而误导用户。

### 7.3 iOS / iPadOS "添加到主屏幕"

- iOS Safari 在 `mail.chenge.ink/app` 打开 → 分享菜单 → "添加到主屏幕"
- 配 `apple-touch-icon` + `apple-mobile-web-app-capable` meta
- 启动后看起来像原生 app（无 Safari 地址栏 / tab bar）

### 7.4 三态主题在 PWA 里

PWA 默认 `theme_color` 是固定的，但应用内 `data-theme` 动态切换（详 DESIGN.md §17）。
iOS 状态栏颜色跟随系统（PWA `apple-mobile-web-app-status-bar-style` 设 `black-translucent`
让内容延伸到状态栏背后，由 `data-theme` 颜色填充）。

---

## 8. 远端体验目标 / SLO

| 操作 | 本地 Electron | 远端 Web (目标) | 远端可接受? |
|---|---|---|---|
| 邮件列表 (50 封) | ~10ms | P95 < 500ms | ✅ |
| 邮件详情打开 (markdown) | ~20ms | P95 < 800ms | ✅ |
| 全文搜索 | ~50ms | P95 < 1.2s | ✅ |
| 附件下载 (5MB PDF) | file:// 秒开 | 流式 ~3-5s | ✅ |
| 附件下载 (50MB) | file:// | 流式 ~30s | ⚠️ 用户教育"远端慢" |
| 邮件 HTML 沙箱 | iframe srcdoc | 同 | ✅ |
| 内联图片 (cid:) | `file://` 路径 | `/api/attachment/{id}/inline` | ✅ |
| 标完成 / 标旗 | CLI ~200ms | API → CLI ~400ms | ✅ |
| 邮件重传 Notion | CLI ~2-5s | API → CLI ~2-5s | ✅ |
| 长任务 (backfill) | 进度条 + 取消 | SSE 推进度 + 取消 | ⚠️ 远端做减法 |

**远端做减法**:
- 不做附件批量下载（远端→本机操作）
- 不做长任务发起（仅 Electron 端）
- 不做命令面板（本机生产力工具）
- 不做实时新邮件推送 V2.0；V2.1 SSE 再加

---

## 9. 安全 Checklist

| 项 | 实施 |
|---|---|
| HTTPS only | ✅ Cloudflare 自动 |
| Cloudflare Access 邮箱白名单 | ✅ Zero Trust policy |
| FastAPI bind 127.0.0.1 | ✅ uvicorn `--host 127.0.0.1` |
| FastAPI 二次校验 Cf-Access-Jwt-Assertion | ✅ middleware |
| CORS 严格 (仅 `mail.chenge.ink`) | ✅ `allow_origins=["https://mail.chenge.ink"]` |
| API key (CLI 写命令) 不入前端 bundle | ✅ FastAPI 后端 subprocess 注入 `--api-key` |
| 附件路径 traversal 防护 | ✅ `local_path` 必须是 `data/attachments/` 子路径，pathlib resolve 校验 |
| 邮件 HTML 沙箱 | ✅ iframe srcdoc + DOMPurify 二次清洗 |
| 邮件外链点击 | ✅ 拦截 + 确认 dialog |
| Service worker 不缓存 API 数据 | ✅ NetworkFirst 仅 timeout 兜底 |
| FastAPI 速率限制 | ⚠️ Cloudflare 边缘已有；V2.1 加 redis token bucket |
| 审计日志 | ⚠️ FastAPI middleware 记 `who / what / when` 到 `data/api_audit.log` |
| 备份 | ✅ SQLite 每天 `cp` 到 iCloud Drive |

**密钥管理**:
- Cloudflare API token (部署用) → 1Password
- `MAILAGENT_CLI_API_KEY` → `.env` 本机
- Cloudflare Access JWT audience tag → `.env` 本机 + FastAPI 校验

---

## 10. 工作量分解（V1 之上 +4-6 天）

V1 ship 后启动：

| Sprint | 内容 | 工作量 |
|---|---|---|
| V2-1 | 本地 FastAPI 骨架 (`src/api/app.py` + email router + cli_runner + PM2) | 1.5 天 |
| V2-2 | 端点全集 + 附件 stream (attachment / llm / admin 路由) | 1 天 |
| V2-3 | data layer abstraction + Vite web target | 1.5 天 |
| V2-4 | Cloudflare Tunnel + Access + PWA + iOS 实测 | 1 天 |
| V2-5 | Cloudflare Pages 部署 + SLO 测试 + 安全 review | 1 天 |
| **合计** | | **~6 天** |

---

## 11. 不在 V2 范围（V2.1 / V3 议题）

- ⚠️ **真实时推送 V2.0 用 light polling 替代**（react-query `refetchInterval: 8s` for `/api/email/list` + `/api/admin/stats`）；V2.1 引 SSE 实时推。light polling 在 V2.0 范围内，避免 V2.0 远端用户改完 Notion 后 30s 才看到 update。
- ❌ 多用户 — 单用户白名单已够
- ❌ 远端发起长任务 — 必须 Electron 端

**V2.1 SSE 鉴权设计**（REVIEW-LOG H-05 已记录）:
- EventSource 不能塞 header → 必须靠 cookie `CF_Authorization`；CF Access 默认 cookie SameSite=Lax + Secure；same-origin SSE 跟随 OK。
- JWT 即将过期前 5 min，server 主动 `event: rotate` + close connection；client 走 OAuth 重新 issue cookie → 新 EventSource 重连。
- **绝不**让 server 自己续期 JWT —— 否则等价于绕过 CF Access 长 session 控制。
- ❌ 远端编辑回复草稿 in-app — 走 Mail.app，远端只触发"创建草稿"
- ❌ iOS / Android 原生 app — PWA 够，原生是 V3+
- ❌ 离线邮件查看 (远端缓存最近 N 封) — 远端默认 online
- ❌ Postgres / 云数据库 — §1 已论证

---

## 12. 风险 / 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| MacBook 休眠 → tunnel 断 | 高 | 中 | `caffeinate -d -i -m -s` 常驻 / 外接显示器 |
| MacBook 重启 → 进程没起 | 中 | 中 | `pm2 save` + `pm2 startup` 开机自启 |
| Cloudflare Access 30 天 cookie 过期 | 高 | 低 | 重登一次即可 |
| 公网爆破 mail.chenge.ink | 高 | 低 | Access OAuth 拦在最外层 |
| FastAPI 内存泄漏 / 卡死 | 低 | 中 | PM2 `--max-memory-restart 500M` + 监控 `/api/admin/health` |
| 长尾远端用户拿到旧 SPA 缓存 | 中 | 低 | service worker `skipWaiting` + 版本号注入 |
| Cloudflare 全球抽风 | 低 | 高 | 本机 Electron 直读不受影响 |

---

> V1 Electron ship 后启动 V2 实施。详细 Sprint 步骤见 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §4。
