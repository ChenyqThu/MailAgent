# Frontend Integration Spec

> **目的**: 把 MailAgent 后端可被前端消费的 4 个接口面（CLI / Webhook Server FastAPI /
> Redis 事件 / SQLite 直读）总成一张表，供 Electron / Web / Mobile 前端方案设计参考。
>
> **状态**: 设计稿（2026-05-16）— 不规定前端实现，仅梳理接口面。
>
> **作者**: 与 [`agent-cli-rfc.md`](./agent-cli-rfc.md) §4-§7 + `webhook-server/`
> + `src/events/handlers.py` + `src/repository/` 对齐。

---

## 0. TL;DR

MailAgent 本地服务（macOS / 邮件实时同步 + LLM 分类 + 飞书）和 webhook-server（远程
FastAPI / Notion ↔ Mail 桥）之间已有完整接口面，可直接给前端用：

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          前端（待规划）                                  │
│  Electron desktop / Web SPA / Mobile（任选）                              │
└──────────────────────────────────────────────────────────────────────────┘
       ↓ CLI 调用              ↓ HTTP                ↓ Redis              ↓ 直读 SQLite
┌─────────────────┐      ┌────────────────┐    ┌──────────────┐    ┌──────────────┐
│ mailagent CLI   │      │ webhook-server │    │   Redis      │    │  data/       │
│ (10 group       │      │  FastAPI       │    │  events 队列  │    │  sync_store  │
│  + 45+ schema)  │      │ (8100 / nginx) │    │  (DB 2)      │    │  .db (SSoT)  │
│                 │      │                │    │              │    │              │
│ 本地 typer app  │      │ 远程            │    │ 远 ↔ 本      │    │ 本地         │
│ 走 SQLite SSoT  │      │ Notion webhook │    │ 双向         │    │ FTS5 / body │
│                 │      │ → Redis 入队    │    │ event bus    │    │ / attach    │
└─────────────────┘      └────────────────┘    └──────────────┘    └──────────────┘
       ↓                       ↓                      ↓                   ↓
       └──────────────────── data/sync_store.db ──────┴───────────────────┘
                              (SQLite SSoT, v4 Phase 4+)
```

**4 个核心决策**（前端方案要先回答）:

1. **SSR / SPA / Electron / Mobile?** 影响 SSoT 路径（直读 vs 走中转）
2. **数据 SSoT 路径**: 直读 SQLite（最快 ~4ms）vs 走 FastAPI/CLI 中转（鉴权 + 跨机器）
3. **鉴权方案**: 单密码（当前 `DASHBOARD_PASSWORD`）vs 多用户 vs API key
4. **实时性**: 轮询 / SSE / WS — Notion ↔ Mail 状态变更，前端要不要实时反映

---

## 1. 接口面 1: `mailagent` CLI（本地 typer app）

**定位**: agent-friendly 本机调用接口，已是 v4 SSoT 主路径。

### 1.1 命令组（10 个 group）

详见 [`agent-cli-rfc.md`](./agent-cli-rfc.md) §4。

| Group | 主要命令 | 前端典型用途 |
|---|---|---|
| `email` | get / list / body / search / resync | 邮件详情页 / 列表 / 全文搜索 / 手动重传 |
| `attachment` | list / download / derive | 附件下载 / Office 衍生预览 |
| `llm` | run / selftest / retry-failed / stats / compare-paths | AI 字段补跑 / 健康检查 / 成本面板 |
| `notion` | resync / update-flag / archive / page-orphans / file-link-audit | 反向写 Notion / 修复孤儿页 |
| `calendar` | expand / recurring discover / recurring replay | 周期会议管理 |
| `debug` | email-source / mail-structure / inline-images / applescript-fetch / notion-page | 调试工具（前端不太用） |
| `backfill` | body / derivatives | 历史回填（前端可能做 admin 面板） |
| `project-progress` | sync | 项目周报同步（专项功能） |
| `init` | fetch-cache / analyze / fix-properties / fix-critical / update-parents / sync-new / all | 初始化（前端基本不调） |
| `admin` | stats / health / db-version / dead-letter / cleanup-syncstore / cleanup-duplicates / repair-parents | 运维面板 |

### 1.2 输出格式（统一契约）

```jsonc
// 全局 -o json 之后, 所有命令返回:
{
  "status": "success" | "error",
  "schema_version": 1,
  "data": <command-specific>,  // success 时
  "error": {                    // error 时
    "code": "E_NOT_FOUND" | "E_INVALID_ARG" | ...,
    "message": "human-readable",
    "hint": "actionable suggestion"
  },
  "meta": {
    "duration_ms": 123,
    ...
  }
}
```

JSON Schema: [`docs/cli-schema/`](./cli-schema/) 45+ schema 文件（每命令 1 个），
通用 wrapper 在 `_common.schema.json`。

### 1.3 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 通用错误 / 资源未找到 |
| 2 | 参数错误 |
| 4 | 鉴权失败 |
| 5 | 网络 / 上游错误 |
| 6 | partial_failure（batch 命令部分成功） |
| 7 | aborted（SIGINT 首次） |
| 8 | max-failures 熔断 |
| 9 | PM2 冲突（写命令拒绝） |
| 130 | SIGINT 二次强退 |

详见 [`docs/cli-schema/error-codes.md`](./cli-schema/error-codes.md)。

### 1.4 鉴权

- **读命令**: 无 auth
- **写命令**: 默认要 `MAILAGENT_CLI_API_KEY` env + `--api-key` flag 同值
- **dev 模式**: `MAILAGENT_CLI_ALLOW_UNAUTH_WRITES=true` 显式放行
- **dry-run**: 跳过鉴权

### 1.5 长任务契约（batch / backfill / init）

- 自动写 `cli_checkpoints` 表（每 50 unit）→ 中断后同 `<command, target_key>` 续跑
- SIGINT 首次 → 退 7，二次 → 退 130
- 连续失败超 `--max-failures` → 退 8 熔断
- PM2 mail-sync online 时写命令默认拒绝（exit 9，可 `--allow-concurrent` 绕）

### 1.6 前端集成方式

- **方式 A（推荐）**: 前端 fork shell `mailagent -o json <cmd> | parse`。最简单，零额外服务
- **方式 B**: 前端走 webhook-server 中转（远程访问 / 多用户）— webhook-server 暂未提供 CLI 透传，需补
- **方式 C**: 前端直跑 Python 调 typer app — 仅 Electron 场景考虑

---

## 2. 接口面 2: webhook-server FastAPI（远程）

**定位**: Notion Automation webhook 入口 + 看板 + 外部 agent 调命令接口。
**部署**: 腾讯云 Ubuntu (170.106.181.89), Nginx + Cloudflare, 域名 `mailagent.chenge.ink`。
**端口**: 8100（PM2 进程 `mailagent-webhook`）。

### 2.1 公开端点

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/health` | 无 | liveness 探针 |
| `POST` | `/webhook/notion` | Notion HMAC 签名 | Notion Automation 触发（page_updated / flag_changed / ai_reviewed / completed / create_draft） |
| `POST` | `/command` | `X-API-Key` header | 外部 agent 调命令（query_mail / fetch_mail_content / search_email_bodies / create_draft） |
| `GET` | `/command/{id}` | `X-API-Key` | 异步命令结果查询 |
| `POST` | `/stats/report` | `Bearer <STATS_REPORT_TOKEN>` | 本地服务上报统计 |
| `GET` | `/admin/stats` | `Bearer <DASHBOARD_PASSWORD>` | 看板 stats 总览（JSON） |

### 2.2 看板端点

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| `GET` | `/dashboard` | Cookie session | 看板 SPA（dashboard.html，1100+ 行原生 JS） |
| `GET` | `/dashboard/login` | 无 | 登录页 |
| `POST` | `/dashboard/login` | `DASHBOARD_PASSWORD` | 设置 session cookie |
| `GET` | `/dashboard/logout` | Cookie | 注销 |
| `GET` | `/dashboard/api/stats` | Cookie | 看板 SPA 唯一 API（轮询） |
| `GET` | `/copy?d=<base64>` | 无 | 内嵌信息复制页（飞书卡片用） |

### 2.3 外部 agent `/command` 入口（核心）

`POST /command` body:
```jsonc
{
  "event": "query_mail" | "fetch_mail_content" | "search_email_bodies" | "create_draft",
  "data": { /* event-specific */ },
  "source": "openclaw" | "feishu" | ...,
  "user_id": "..."
}
```

返回 `{"event_id": "uuid", "queued": true}`。结果走 `GET /command/{event_id}` 取，
由 Redis BLPOP 在本地服务消费 → 写回 Redis result key → FastAPI 返回。

### 2.4 前端集成考虑

- **看板替换**: 现有 dashboard.html 是原生 JS + 单端点轮询，可被 React/Vue SPA 替换；新 SPA 用同 `/dashboard/api/stats` 即可
- **API 扩展**: 前端如需新 endpoint（如 `/api/email/list`）要在 `webhook-server/app.py` 加路由 + 转发到本地 CLI（CLI runner 走 SSH 或本地直跑）
- **跨机器问题**: webhook-server 在远程，SQLite 在本地（Mac），中转必须经 CLI / Redis / SSH 而非直读 DB

---

## 3. 接口面 3: Redis 事件队列（本地 ↔ 远程双向）

**定位**: Notion → Mail 实时事件入口，远程 webhook-server 入队，本地服务消费。
**Redis**: 远程腾讯云（同台 webhook-server），MailAgent 用 DB 2（Notion2JIRA 占 DB 0-1）。

### 3.1 事件类型（8 个 handler）

定义在 `src/events/handlers.py:EventHandlers`：

| 事件 | 触发 | 处理（本地服务）| 前端可观察? |
|---|---|---|---|
| `flag_changed` | Notion Is Read/Is Flagged 变化 | 同步到 Mail.app | 看板可显示 last sync time |
| `ai_reviewed` | Notion Processing Status → AI Reviewed | Mail.app 标旗 + 飞书通知 + Processing Status→已同步 | 看板可显示 ai_reviewed count |
| `completed` | Notion Processing Status → 已完成 | 移除 Mail.app 旗标 | 同上 |
| `create_draft` | Notion 按钮 / 飞书按钮 | 调 AppleScript 创建 Mail.app 回复草稿 | 同上 |
| `query_mail` | 外部 agent | 搜邮件 metadata（FTS5 / SQLite filter） | 前端可直接调（query 接口） |
| `fetch_mail_content` | 外部 agent | 通过 internal_id 拉 body（SQLite 直读 ~4ms） | 前端可直接调（详情接口） |
| `search_email_bodies` | 外部 agent | FTS5 全文搜索 + bm25 + snippet | 前端可直接调（全文搜接口） |
| `page_updated` | Notion 通用 | 自动路由到上面 4 个 handler | 内部分发 |

### 3.2 队列形态

- Key: `mailagent:events`（FIFO list, BLPOP 消费）
- Payload: JSON `{event, data, source, user_id, event_id, timestamp}`
- 结果回写: `mailagent:result:<event_id>`（TTL 5min, FastAPI GET 后立刻取走）

### 3.3 前端集成方式

前端不直接连 Redis（敏感）。走 FastAPI `/command` 走相同事件总线，复用现有 8 个 handler 即可。

---

## 4. 接口面 4: SQLite 直读（本地 SSoT）

**定位**: v4 Phase 4 起 SQLite 是邮件正文 + 附件元数据 SSoT；Notion 退化为镜像。

### 4.1 库结构

| 表 | 主键 | 内容 |
|---|---|---|
| `email_metadata` | `internal_id` (INTEGER) | sender / subject / dates / sync_status / notion_page_id / 11 个 AI 字段 |
| `email_body` | `internal_id` FK CASCADE | `body_html` + `body_markdown` + `raw_mime_sha256` |
| `email_attachment` | `id` AUTOINCREMENT | filename / size / content_type / local_path / notion_file_id / `derived_from` 自指 FK |
| `email_body_fts` | virtual (rowid=internal_id) | FTS5 全文索引 |
| `cli_checkpoints` | (command, target_key) | 长任务 resume |
| `llm_processing` | internal_id | LLM cost / latency / retry queue |
| `v4_rollout_stats` | id | hit rate / latency / body_miss audit |

详见 [`agent-cli-rfc.md`](./agent-cli-rfc.md) §3 / CLAUDE.md v4 SSoT 段落。

### 4.2 接口层 `EmailRepository`

```python
from src.repository import EmailRepository, AttachmentStore

repo = EmailRepository(db_path="data/sync_store.db", attachment_store=AttachmentStore("data/attachments"))

# 读
html = repo.get_body_html(internal_id)
md = repo.get_body_markdown(internal_id, max_chars=12000)
atts = repo.get_attachments(internal_id)         # list of AttachmentMeta
bytes_ = repo.get_attachment_bytes(att.id)        # 二进制
hits = repo.search_email_bodies(query, limit=20)  # FTS5 + bm25 + snippet
```

### 4.3 附件文件系统

- 根目录: `data/attachments/{internal_id}/`
- `local_path` 是绝对路径，Electron / 本地 web 可直接 `file://` 访问
- 远程 web 必须经 CLI `attachment download` 中转

### 4.4 前端集成方式

- **方式 A（最快 ~4ms 命中）**: Electron 直读 SQLite + 附件目录
- **方式 B**: Web 走 CLI `email get/body/list/search` + `attachment download`（统一序列化）
- **方式 C**: Web 走 FastAPI（需补 endpoint，转 CLI 或转 EmailRepository）

---

## 5. 鉴权矩阵

| 接口面 | 鉴权机制 | env 配置 | 适用前端 |
|---|---|---|---|
| CLI 读命令 | 无 | - | Electron / 本机 web |
| CLI 写命令 | `MAILAGENT_CLI_API_KEY` + `--api-key` | `.env` 本机 | 任意（接 token store） |
| FastAPI `/command` | `X-API-Key` header | env on remote | 多用户 / 外部 agent |
| FastAPI `/admin/stats` | `Bearer <DASHBOARD_PASSWORD>` | `.env` on remote | 看板 admin |
| FastAPI `/dashboard/*` | Cookie session | `DASHBOARD_PASSWORD` | 看板 web |
| FastAPI `/webhook/notion` | Notion HMAC 签名 | Notion automation 自动生成 | 不给前端 |
| FastAPI `/stats/report` | `Bearer <STATS_REPORT_TOKEN>` | 本地 → 远程上报 | 不给前端 |
| Redis | 不开放 | - | 不给前端 |
| SQLite 直读 | 文件权限（macOS Full Disk Access）| - | 仅本机 |

**前端方案**:
- 单用户 / 本机: SQLite 直读 + CLI 写（带 API key）
- 单用户 / 远程: FastAPI `/command`（X-API-Key）
- 多用户: 需新加 FastAPI 用户系统（当前无）

---

## 6. 实时性方案

| 需求 | 当前方案 | 前端可走 |
|---|---|---|
| Mail.app 新邮件到 Notion | 5s 雷达轮询 | 看 `email list --since <now>` 轮询 |
| Notion 字段变更 → Mail.app | Notion webhook → Redis → handler（亚秒级）| `/dashboard/api/stats` 轮询 / 加 SSE endpoint |
| LLM 处理完 | fire-and-forget asyncio task | DB `llm_processing.updated_at` 轮询 |
| 看板统计 | 60s `stats_reporter` 上报 → `/dashboard/api/stats` | 当前 30s 轮询，可改 SSE |

**建议**: 第一版前端用轮询（简单稳定），看板已经这样做。SSE / WS 在用户增长 / 真实时需求出现后再补。

---

## 7. 数据契约总览

| 数据 | 来源 | 形状 | 文档 |
|---|---|---|---|
| 邮件 metadata | SQLite `email_metadata` / CLI `email get` | dict（44 字段：sender / subject / dates / sync_status / 11 AI 字段 / ...） | `docs/cli-schema/email-get.schema.json` |
| 邮件 body | SQLite `email_body` / CLI `email body --format markdown\|html\|raw` | str | `docs/cli-schema/email-body.schema.json` |
| 邮件搜索 | CLI `email search` (FTS5) / Redis `search_email_bodies` | list of {internal_id, snippet, rank, ...} | `docs/cli-schema/email-search.schema.json` |
| 附件 | SQLite `email_attachment` / CLI `attachment list` | list of {id, filename, size, sha256, derived_from, ...} | `docs/cli-schema/attachment-list.schema.json` |
| LLM stats | SQLite `llm_processing` / CLI `llm stats` | {input_tokens, cache hit rate, cost, latency} | `docs/cli-schema/llm-stats.schema.json` |
| v4 rollout | SQLite `v4_rollout_stats` / `/dashboard/api/stats` | {hit_rate, fallback_count, p99_latency, body_miss_ids} | (无独立 schema) |
| Event payload | Redis queue | {event, data, source, user_id, event_id} | (无独立 schema, 见 handlers.py 反推) |

---

## 8. 4 个核心架构问题（前端方案设计要先回答）

### Q1: 前端形态 — Electron / Web SPA / Mobile?

|  | Electron | Web SPA | Mobile |
|---|---|---|---|
| SSoT 路径 | 直读 SQLite + attachment file:// | 走 FastAPI 中转 / CLI | 走 FastAPI |
| 鉴权 | 本机文件权限 | DASHBOARD_PASSWORD / API key | API key |
| 实时性 | 容易（启动监听 SQLite） | 轮询 / SSE | 轮询 / push |
| 部署 | 用户 macOS（与本机 mail 服务同机）| 远程 webhook-server 上 | 任意 |
| 复杂度 | 低（一台机器内完成） | 中（跨机器 + 多人扩展性）| 高（需 push 基建）|

**默认推荐**: Electron + SQLite 直读（与现有架构最对齐）。

### Q2: SSoT 路径 — 直读 vs 中转?

| | 直读 SQLite | CLI 中转 | FastAPI 中转 |
|---|---|---|---|
| 延迟 | ~4ms 命中 | ~20-100ms（typer 启动）| ~50-200ms（HTTP + CLI）|
| 鉴权 | 文件权限 | API key | API key + session |
| 跨机器 | 不行 | 仅本机 | 行 |
| 数据形状 | EmailRepository Python 接口 | JSON schema 化 | JSON schema 化 |
| 写操作 | 谨慎（race condition）| 安全（CLI 走事务）| 安全 |

**默认推荐**: 读直读，写走 CLI（结合 Electron）/ FastAPI（Web/Mobile）。

### Q3: 鉴权 — 单密码 / 多用户 / API key?

当前: 看板 `DASHBOARD_PASSWORD` 单密码 + CLI 写命令 `MAILAGENT_CLI_API_KEY`。

| 方案 | 前端复杂度 | 后端工作量 | 何时升级 |
|---|---|---|---|
| 单密码 + API key（现状）| 低 | 0 | 仅本人 / 1-2 人 |
| OAuth 2 (Google / GitHub) | 中 | 中（加 IdP 接入）| 5+ 人协作 |
| 自建用户系统 | 高 | 高（DB schema + 管理后台）| 服务化 |

**默认推荐**: V1 用现状（单密码），V2 看需求。

### Q4: 实时性 — 轮询 / SSE / WS?

| | 轮询 | SSE | WebSocket |
|---|---|---|---|
| 看板（当前）| 30s 用现状 | 改 SSE 服务端 0.5 天 | 加 ws 服务 1 天 |
| 详情页 | 5s 用 | 单向 push 合适 | 双向不需要 |
| 通知 | 不合适 | 合适 | 合适 |

**默认推荐**: V1 轮询 + Notion webhook 已有，V2 SSE 推通知。

---

## 9. 不在本 spec 范围

- 前端框架选型（React / Vue / Svelte / Solid）— 由前端工程师定
- UI 设计 — 看板 dashboard.html 是 V0 参考，前端可重设计
- Mobile push 基建（FCM / APNs）— 真有 mobile 需求再起
- 多租户 / SaaS 化 — 当前是单用户工具
- i18n — 当前界面 zh-CN（飞书卡片 / 看板 / 邮件分类 prompt 都是中文）

---

## 10. 下一步

1. 用户决定 Q1-Q4 4 个核心架构问题
2. 起 `docs/frontend-v1-implementation-plan.md`（具体技术选型 + 任务拆分）
3. 视前端方案补：
   - `webhook-server/api-reference.md`（端点全集 + curl 例）
   - `docs/cli-schema/`（如新增前端用的 schema）
   - 新 FastAPI endpoint（如前端需要 `/api/email/list` 之类直读 wrapper）
4. 前端开工

---

> 本 spec 与 PR-6 / PR-7 ship 同 batch 起草（commit 945877c 之后）。前端方案具体设计另起
> implementation plan 文档。
