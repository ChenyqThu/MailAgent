# MailAgent 架构总览

> **定位**：系统级"大图"——组件、数据流、演进分层、子系统地图。
> 想看**代码级深度**（具体流程/DDL/重试逻辑）去 [`docs/reference/architecture/architecture-internals.md`](docs/reference/architecture/architecture-internals.md)；
> 想看**给 agent 的导航索引**去 [`CLAUDE.md`](CLAUDE.md)；
> 想从**旧版本升级**去 [`MIGRATION.md`](MIGRATION.md)。

---

## 1. 一句话

MailAgent 是一个 macOS 邮件实时同步系统：把企业邮箱（Exchange/Microsoft 365）的邮件、附件、
线程、会议邀请同步进 **Notion**，叠加 **AI 分类**、**双向状态同步**、**飞书通知**，并提供一个
**Electron 桌面前端**和可选的 **KOS 知识图谱**对接。

核心架构思想经历四层演进，**叠加而非替换**：

| 层 | 时间 | 一句话 | 状态 |
|---|---|---|---|
| **v3 SQLite-First** | 2026-01 | `internal_id`（=AppleScript ROWID）做主键，查询快 127×，撑 6–7 万封大邮箱 | 基础 |
| **Sprint 15 SSoT inversion** | 2026-05 | 所有写操作反转：SQLite 是 intent 聚合点，`FanoutWorker` 异步派发到 Mail.app + Notion | 灰度 |
| **Sprint 16 Dual-Backend** | 2026-05-22 | 抽象 `IMailBackend`，DavMail IMAP/SMTP/CalDAV 成主路径，AppleScript 降为 fallback | cutover |
| **v4 SQLite-SSoT** | 2026-05 | 邮件正文 + 附件以本地 SQLite/磁盘为 SSoT，Notion 退化为镜像，FTS5 全文搜索 | Phase 1–4 上线/灰度 |

---

## 2. 顶层拓扑

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  本地 macOS 主机                                                               │
│                                                                                │
│   ┌─────────────────┐        ┌──────────────────────────────────────────┐    │
│   │ MailAgent Web   │ ⇄ CLI  │  main.py  (mail-sync 主进程, PM2)         │    │
│   │ (Electron 前端) │ ⇄ SSE  │  ┌────────────────────────────────────┐   │    │
│   │ 收件箱/详情/chat│ :9200  │  │ NewWatcher 主循环 (v3)             │   │    │
│   │ 撰写/翻译/灵动岛│        │  │  └ IMailBackend ┐                  │   │    │
│   └─────────────────┘        │  │     davmail(主) │ applescript(fb)  │   │    │
│           │                  │  ├────────────────────────────────────┤   │    │
│   ┌───────┴───────┐          │  │ FanoutWorker(outbox 派发)          │   │    │
│   │ ping-island.app│ socket  │  │ CalendarSyncWorker / FolderSyncWorker│ │    │
│   │ (灵动岛, 可选) │ /tmp/.. │  │ Reverse-sync loop / LLM hook / KOS hook│ │   │
│   └────────────────┘         │  └────────────────────────────────────┘   │    │
│                              └──────┬───────────────┬──────────┬─────────┘    │
│   ┌──────────────┐                  │               │          │              │
│   │ DavMail JVM  │◀── IMAP/SMTP ────┘               │          │              │
│   │ (PM2, 桥 EWS)│    /CalDAV                        │          │              │
│   └──────┬───────┘                                  │          │              │
│          │              data/sync_store.db (SQLite SSoT) ◀─────┘          │    │
│          │              data/attachments/{internal_id}/                    │    │
└──────────┼─────────────────────────────────────────────────────────────────┘
           │                          │                    │            │
     ┌─────┴─────┐            ┌───────┴──────┐      ┌───────┴────┐ ┌─────┴─────┐
     │ Exchange/ │            │  Notion API  │      │ 飞书机器人 │ │ KOS/gbrain│
     │ M365 (EWS)│            │ (邮件/日历库) │      │ 通知+告警  │ │(可选,知识图)│
     └───────────┘            └──────────────┘      └────────────┘ └───────────┘

  ┌────────────────────────────────────────────────────────────────────────┐
  │ 远程 VPS 170.106.181.89 :  webhook-server (FastAPI) + Redis + Dashboard │
  │   Notion Automation webhook ──▶ Redis ──▶ 本地 redis_consumer 反向事件   │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 数据流（正向 / 反向）

### 正向：新邮件 → Notion + SSoT

```
1. backend 检测变化         davmail: IMAP STATUS UIDNEXT 轮询(~30s)
                            applescript: SQLite Radar 检测 ROWID(~5s)
2. 取完整 MIME              davmail: UID FETCH BODY[] (~236ms)
                            applescript: whose id is <int> (~1s)
3. 写 SyncStore             internal_id 主键, 填 message_id/thread_id
4. v4 双写                  email_body(HTML+MD) + email_attachment(元数据)
                            附件二进制 → data/attachments/{internal_id}/
5. 解析 + 同步 Notion       HTML→blocks(含内联图) / 线程 Parent-Child / .ics→日程
6. AI hook (可选)           本地 LLM 填 AI 字段  →  ai_priority/ai_action 进主表
7. KOS hook (可选)          异步推 /ingest, fail-soft
8. 通知 (可选)              飞书卡片(紧急/重要) / 灵动岛 envelope
```

### 反向：Notion/前端 改状态 → Mail.app

```
Sprint 15 outbox 路径 (MAILAGENT_OUTBOX_ENABLED=true):
  触发源                        →  写 SQLite intent + email_outbox  →  FanoutWorker 消费
  ├ A: Notion webhook(实时)        source=notion_webhook                ├ Mail.app: IMAP STORE / AppleScript
  ├ B: 反向轮询(30s 兜底)          source=reverse_sync_poll             └ Notion API
  └ C: 前端/CLI 写命令             email flag / batch action
  echo prevention: source=notion_webhook + target=notion → silent skip 防回环

关闭 outbox 时 (默认/灰度前): handler + reverse_sync 退回旧 AppleScript 直调
```

状态机：`未处理 →(AI 审核) AI Reviewed →(反向同步) 已同步 →(用户处理) 已完成`。
完整映射见 [`docs/reference/architecture/architecture-internals.md`](docs/reference/architecture/architecture-internals.md) §Processing Status。

---

## 4. 子系统地图

| 子系统 | 目录 | 职责 | 默认开关 |
|---|---|---|---|
| **邮件同步核心** | `src/mail/` | NewWatcher 主循环 / SyncStore / reader / 反向同步 / 健康检查 | 常驻 |
| **后端抽象** | `src/mail/backend/` | `IMailBackend` Protocol + davmail / applescript / imap_client | `MAILAGENT_BACKEND` |
| **v4 SSoT 仓储** | `src/repository/` | `EmailRepository` / `AttachmentStore` / FTS5 搜索 | `BODY_DUAL_WRITE_ENABLED=true` |
| **Notion 同步** | `src/notion/` | facade `sync.py` + client/pages/threads/queries（外部统一从 `src.notion.sync` import） | 常驻 |
| **日历** | `src/calendar_notion/` `src/calendar_sync/` | 邮件 .ics→日程；CalDAV→SQLite `calendar_event` SSoT | `CALENDAR_CALDAV_SYNC_ENABLED=false` |
| **本地 LLM 分类** | `src/llm_agent/` | 本地 Anthropic 兼容网关填 AI 字段（替代 Notion Email Agent） | `LLM_AGENT_ENABLED=false` |
| **事件 / webhook** | `src/events/` | Redis BLPOP 消费者 + webhook 事件处理器 | `REDIS_EVENTS_ENABLED=false` |
| **通知** | `src/notify/` | 飞书应用机器人 / 告警机器人 / 灵动岛 dispatch | 各自 flag |
| **转换器** | `src/converter/` | HTML→Notion blocks / Office→PDF/CSV / 附件文本化 | 常驻 |
| **KOS 集成** | `src/kos/` | OAuth client + producer（推 /ingest） | `MAILAGENT_KOS_*=false` |
| **归档/草稿** | `src/folder_sync/` | davmail IMAP Archive/Drafts → SQLite `folder_email` | `MAILBOX_FOLDER_SYNC_ENABLED=false`（davmail-only） |
| **项目周报** | `src/project_progress/` | 邮件附件 xlsx → Notion 数据库（外挂） | `PROJECT_PROGRESS_SYNC_ENABLED=false` |
| **CLI** | `src/cli/` | `mailagent` agent-friendly 接口（10 group，读无 auth/写需 token） | 安装即用 |
| **前端** | `frontend/` | Electron 桌面 App（收件箱/chat/撰写/翻译/灵动岛/设置） | 单独安装 |
| **webhook-server** | `webhook-server/` | 远程 FastAPI：Notion webhook→Redis + 看板 API（:8100） | 远程部署 |

---

## 5. 持久化 / SSoT 边界

| 数据 | SSoT | 镜像/派生 |
|---|---|---|
| 邮件元数据 + 同步状态 | **SQLite** `email_metadata`（`internal_id` 主键） | — |
| 邮件正文 + 附件二进制 | **SQLite `email_body` + 本地盘**（v4） | Notion 页面（退化为镜像） |
| flag / processing_status 变更意图 | **SQLite `email_outbox`**（Sprint15） | Mail.app + Notion（FanoutWorker 派发） |
| 日历事件 | **SQLite `calendar_event`**（CalDAV SSoT） | Notion 日历库 |
| 全文搜索 | SQLite **FTS5**（`email_body_fts` / `email_attachment_fts`） | — |
| 前端密钥 | macOS 钥匙串（keytar） | — |
| 前端 chat 历史 / 设置 | `~/.mailagent/frontend/` | — |

DB schema 版本当前 **v17**，迁移幂等自动（`src/mail/sync_store.py:_init_database`）。版本演进见 [`MIGRATION.md`](MIGRATION.md) §3。

---

## 6. 死硬约束（任何改动都要守住）

1. **AppleScript fallback 始终可用** —— 任何重构都必须保证 davmail→applescript emergency 回切不丢数据（回切要 reset radar marker）。
2. **DavMail PoC 不可上生产** —— 当前用 Outlook for Windows 伪装 client_id，需公司 IT 审批（建议直接申请 Graph API）。
3. **EWS 2026-10-01 关停** —— DavMail 6.7 仍走 EWS，Graph 路线图（Issue #404）未 merge，见 [`docs/reference/architecture/roadmap-post-cutover.md`](docs/reference/architecture/roadmap-post-cutover.md) §5.1。
4. **AI 路径防双跑** —— 启用本地 LLM 前必须停掉 Notion Email Agent Automation。
5. **可选功能默认 opt-in** —— KOS / 前端 / davmail / outbox 等不启用就维持旧行为。

---

## 7. 延伸阅读

- 代码级架构内核：[`docs/reference/architecture/architecture-internals.md`](docs/reference/architecture/architecture-internals.md)
- 升级迁移：[`MIGRATION.md`](MIGRATION.md)
- 各子系统下沉文档：[`docs/reference/`](docs/reference/)
- 配置全表：[`.env.example`](.env.example)
- Agent 项目指南：[`CLAUDE.md`](CLAUDE.md)
