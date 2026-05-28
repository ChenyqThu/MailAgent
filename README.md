# MailAgent

邮件实时同步到 Notion，支持 AI 自动分类与处理、Electron 桌面前端、可选知识图谱对接。

> 📐 **架构总览** → [`ARCHITECTURE.md`](./ARCHITECTURE.md) ｜ 🧭 **从旧版本升级** → [`MIGRATION.md`](./MIGRATION.md) ｜ 🤖 **Agent 项目指南** → [`CLAUDE.md`](./CLAUDE.md)

> **正在用两周前的版本？** 这两周做了几个大改动（DavMail 双后端、Electron 前端、KOS 知识库对接、数据库 v3→v17）。
> 直接把 [`MIGRATION.md`](./MIGRATION.md) 交给你的 Claude Code agent，它会带你逐步迁移并标出需要你拍板的决策点。

> **Backend 切换**：`MAILAGENT_BACKEND=davmail|applescript` 一行切换。代码默认 `applescript`（Mail.app + AppleScript），
> davmail（IMAP/SMTP/CalDAV 桥 EWS）为可选主路径，AppleScript 始终保留作 emergency fallback。详见 [`docs/sprint16-cutover-complete.md`](./docs/sprint16-cutover-complete.md)。

## 功能概览

| 功能 | 数据源 / 载体 | 说明 | 默认 |
|------|--------|------|------|
| **邮件同步** | DavMail IMAP（可选主）/ Mail.app（fallback） | 邮件内容、附件、线程关系同步到 Notion | 常驻 |
| **会议邀请识别** | 邮件中的 .ics | 自动解析会议邀请创建日程 | 常驻 |
| **双向状态同步** | Mail.app ↔ SQLite ↔ Notion | 已读/旗标/处理状态双向同步（Sprint15 起走 outbox） | 常驻 |
| **AI 分类处理** | Notion Automation 或本地 LLM | Notion Email Agent 或本地 Anthropic 兼容 LLM（见 [docs/LLM_AGENT_SETUP.md](./docs/LLM_AGENT_SETUP.md)） | 可选 |
| **全文搜索** | SQLite FTS5 | 邮件正文 + 附件文本化（PDF/docx/pptx/xlsx）全文检索，中文 smart wrapper | 随 v4 |
| **MailAgent Web（前端）** | Electron 桌面 App | 收件箱 / 详情 / AI 多轮 chat / 回复转发撰写 / 一键翻译 / 灵动岛 / 设置 | 单独安装 |
| **KOS 知识库对接** | Jarvis KOS v2 (gbrain) | 邮件推 `/ingest` 入知识图谱 + chat 跨域检索 | 关 |
| **灵动岛通知** | ping-island.app | AI 智能通知 + ack 中心（推送 + 一键操作） | 需装 app |
| **飞书通知 / 告警** | 飞书机器人 | 重要邮件推送 + 交互按钮 / 服务异常告警 | 可选 |
| **监控看板** | 远程 Dashboard | 同步概览、服务状态、告警、Redis 队列 | 远程 |
| **日历同步** | DavMail CalDAV → SQLite | `CalendarSyncWorker` 增量同步到 `calendar_event` SSoT | 关 |

### 邮件同步特性
- **v3 SQLite-First 架构**：大邮箱（6-7 万封）支持，单封邮件获取 ~1s（applescript）/ ~236ms（davmail）
- **v4 SQLite SSoT 架构（Phase 1–4 上线/灰度）**：邮件正文（HTML + Markdown）+ 附件双写到 SQLite，
  附件二进制落 `data/attachments/{internal_id}/`，FTS5 全文搜索就位，Notion 退化为镜像。
  详见 [`docs/architecture_v4_sqlite_ssot.md`](./docs/architecture_v4_sqlite_ssot.md)
- 基于 message_id 的 100% 准确去重 + 自动建立邮件线程 Parent-Child 关系
- **自动识别会议邀请**：检测邮件中的 iCalendar 附件，创建日程页面
- HTML 正文转 Notion Blocks（含内联图片）+ 附件上传 + 失败自动重试（指数退避）

> 架构演进经历四层叠加（v3 SQLite-First → Sprint15 SSoT inversion → Sprint16 Dual-Backend → v4 SQLite-SSoT），
> 完整说明见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

---

## 快速开始

### 1. 环境准备

```bash
git clone https://github.com/chenyqthu/MailAgent.git
cd MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -e ".[cli,dev]"     # 装 mailagent CLI + 开发依赖
cp .env.example .env
mailagent --version             # 期望 3.0.0
```

### 2. 配置 `.env`

必填项：
```bash
NOTION_TOKEN=ntn_xxx...           # Notion Integration Token
EMAIL_DATABASE_ID=xxx...          # 邮件数据库 ID
CALENDAR_DATABASE_ID=xxx...       # 日历数据库 ID
USER_EMAIL=your@email.com
MAIL_ACCOUNT_NAME=Exchange        # Mail.app 账户名 (applescript backend 用)

# Dual-backend (Sprint 16 起)：
MAILAGENT_BACKEND=davmail         # davmail | applescript
DAVMAIL_USER=your@email.com
DAVMAIL_CIPHER_KEY=xxx            # 跟本机 davmail.properties 一致 (生产必填)
# DAVMAIL_POC_MODE=1              # PoC 模式默认共享 key (非生产)
```

DavMail 自动启动 (PM2 进程 `davmail-poc`)：参见 [`davmail-poc/POC-RESULTS.md`](./davmail-poc/POC-RESULTS.md) (本地 gitignored)。完整配置参见 `.env.example`

### 3. 系统权限

运行 MailAgent 的终端应用（Terminal / iTerm2）需要以下权限：

| 权限 | 位置 | 用途 |
|------|------|------|
| **完全磁盘访问权限** | 隐私与安全 | SQLite 雷达读取 Mail.app 数据库 |
| **自动化 → Mail** | 隐私与安全 → 自动化 | AppleScript 操作 Mail.app |
| **自动化 → System Events** | 隐私与安全 → 自动化 | 创建草稿时模拟按键粘贴内容 |
| **辅助功能** | 隐私与安全 | System Events 发送按键 |
| **屏幕录制** | 隐私与安全 | 草稿截图（仅 `--screenshot` 时需要） |

> PM2 启动的进程继承启动时所在终端的权限。如果之前在 Cursor 中运行，切换到 iTerm2 需要重新授权。

### 4. 测试连接

```bash
source venv/bin/activate
python3 scripts/test_notion_api.py   # Notion API
python3 scripts/test_mail_reader.py  # Mail.app（获取最新 5 封邮件）
```

### 5. 初始化同步

首次使用需将历史邮件同步到 Notion（推荐用 `mailagent init` CLI）：

```bash
# 完整初始化流程
mailagent init all --yes

# 或分步执行：
mailagent init fetch-cache --inbox-count 3000 --sent-count 500
mailagent init all --yes
```

### 6. 启动服务

**开发/测试：**
```bash
python3 main.py
```

**生产环境（PM2）：**
```bash
npm install -g pm2
# 必须指定 venv 中的 python 解释器
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3
pm2 save && pm2 startup
```

**PM2 常用命令：**
```bash
pm2 logs mail-sync        # 查看日志
pm2 restart mail-sync     # 重启服务
pm2 status                # 查看状态
```

### 7. （可选）安装 MailAgent Web 桌面前端

前端是后端的 GUI，先确保后端跑通再装。普通用户下 [Releases](https://github.com/chenyqthu/MailAgent/releases)
的 `.dmg`；开发者源码跑：

```bash
cd frontend
pnpm install      # postinstall 会编译 better-sqlite3 原生模块
pnpm dev          # 开发模式；打包出 .dmg 用 pnpm build:mac
```

完整安装 / 应用内配置 / 故障排查见 [`frontend/INSTALL.md`](./frontend/INSTALL.md)。

---

## 架构说明

```
backend(davmail/applescript) ─检测/取信─▶ SyncStore(internal_id 主键)
        │                                      │
        │                          v4 双写 ─▶ email_body + 附件落盘 + FTS5
        ▼                                      │
  正向 sync ─▶ NotionSync(邮件页面/线程/内联图) + MeetingInviteSync(.ics→日程)
        ▲                                      │
  反向 sync(Sprint15 outbox) ◀── FanoutWorker ◀┴─ AI hook / KOS hook / 通知
```

**核心流程**：
1. backend 检测变化（davmail: IMAP UIDNEXT 轮询 / applescript: SQLite Radar 检测 ROWID）
2. 取完整 MIME（davmail UID FETCH ~236ms / applescript `whose id is` ~1s）→ 写 SyncStore
3. **v4 双写邮件正文 + 附件到本地 SQLite**（`email_body` / `email_attachment`），附件二进制落 `data/attachments/{internal_id}/`
4. 同步到 Notion Email 数据库（Notion 退化为镜像）+ 检测 .ics 创建日程
5. 反向（flag/状态变更）Sprint15 起走 `email_outbox` + `FanoutWorker` 异步派发到 Mail.app + Notion

> **完整架构**（四层演进 / 顶层拓扑 / 数据流 / 子系统地图 / SSoT 边界）见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；
> 代码级深度见 [`docs/claude/architecture-internals.md`](./docs/claude/architecture-internals.md)。

---

## Notion 数据库结构

### 邮件数据库

| 字段 | 类型 | 说明 |
|------|------|------|
| Subject | Title | 邮件主题 |
| Message ID | Text | 唯一标识（去重用） |
| Thread ID | Text | 线程标识 |
| From / To / CC | Text/Email | 收发件人 |
| Date | Date | 日期 |
| Parent Item | Relation (self) | 线程头关联 |
| Mailbox | Select | 收件箱/发件箱 |
| Is Read / Is Flagged | Checkbox | 状态 |
| Has Attachments | Checkbox | 是否有附件 |
| AI Action | Select | AI 建议动作（需要回复/仅供参考/…） |
| AI Priority | Select | Critical / Urgent / Important / Normal / Low |
| AI Review Status | Select | Pending / Reviewed |

> 改 email DB 的 Select 选项时，要同步改 `src/llm_agent/schema.py` 并跑 `pytest tests/llm_agent/test_schema.py`
> （有 `schema-consistency-reviewer` subagent 校验四处一致性）。

### 日历数据库

| 字段 | 类型 | 说明 |
|------|------|------|
| Title | Title | 事件标题 |
| Event ID | Text | 唯一标识 |
| Time | Date | 起止时间 |
| URL | URL | Teams 会议链接 |
| Location | Text | 地点 |
| Organizer | Text | 组织者 |

---

## 常见问题

**邮箱名称错误**
```bash
mailagent debug mail-structure
```

**SQLite 权限问题**
- 系统设置 → 隐私与安全 → 完全磁盘访问权限 → 添加 Terminal

**AppleScript 超时**
- 增大 `.env` 中的 `APPLESCRIPT_TIMEOUT`（默认 200 秒）

**查看日志**
```bash
tail -f logs/sync.log
pm2 logs
```

---

## 项目结构

```
MailAgent/
├── main.py                 # 邮件同步主进程（NewWatcher + FanoutWorker + Calendar/Folder worker）
├── src/
│   ├── mail/               # 邮件核心
│   │   ├── new_watcher.py      # 监听器（v3 主循环 + LLM/KOS hook 派发点）
│   │   ├── sqlite_radar.py     # SQLite 雷达（applescript 变化检测）
│   │   ├── applescript_arm.py  # AppleScript 机械臂（fallback 路径）
│   │   ├── sync_store.py       # SQLite 同步状态存储（DB schema 演进点, v17）
│   │   ├── reverse_sync.py     # 反向同步（Notion → SQLite intent + outbox）
│   │   ├── meeting_sync.py / icalendar_parser.py  # 会议邀请检测 + 解析
│   │   ├── reader.py           # MIME 解析
│   │   └── backend/            # Sprint16 双 backend 抽象（IMailBackend / davmail / applescript / imap_client）
│   ├── repository/         # v4 EmailRepository / AttachmentStore / FTS5 搜索
│   ├── notion/             # Notion 同步 facade（sync/client/pages/threads/queries）
│   ├── calendar_notion/    # 邮件 .ics→日程 + Notion 日历同步
│   ├── calendar_sync/      # CalDAV → SQLite calendar_event SSoT（repository/expander/reconciler/worker）
│   ├── llm_agent/          # 本地 LLM 分类（接管 Notion Email Agent 的 AI 字段）
│   ├── kos/                # KOS（gbrain）OAuth client + producer
│   ├── folder_sync/        # 存档/草稿箱（davmail IMAP → folder_email）
│   ├── project_progress/   # 邮件附件 xlsx → Notion（外挂周报）
│   ├── events/             # Redis 消费者 + webhook 事件处理器
│   ├── notify/             # 飞书通知 / 告警 / 灵动岛 dispatch
│   ├── converter/          # HTML→Notion blocks / Office 转换 / 附件文本化
│   ├── cli/                # mailagent CLI（10 个 group）
│   ├── sse_server.py       # 进程内 SSE server（前端直连 :9200）
│   └── config.py / models.py
├── frontend/               # MailAgent Web（Electron 桌面 App，见 frontend/INSTALL.md）
├── webhook-server/         # 远程 FastAPI（Notion webhook→Redis + 看板）
├── prompts/                # LLM 分类 prompt（email_inbox.md / email_sent.md）
├── scripts/                # 运维 / 部署 / dev 脚本
├── data/                   # sync_store.db + attachments/{internal_id}/
└── logs/
```

---

## 开发文档

**入门 / 升级：**
- [架构总览](./ARCHITECTURE.md) — 四层演进 / 顶层拓扑 / 数据流 / 子系统地图 / SSoT 边界
- [升级迁移指南](./MIGRATION.md) — 旧版本（DB v3）→ 最新（v17），含决策点 + 隐藏风险
- [前端安装与使用](./frontend/INSTALL.md) — MailAgent Web 桌面 App
- [Agent 项目指南](./CLAUDE.md) — 给 Claude Code 的导航索引

**深度文档（按需读）：**
- [架构内核](./docs/claude/architecture-internals.md) — 代码级流程 / Sprint15 / Sprint16 / DDL
- [v4 SQLite SSoT 架构](./docs/architecture_v4_sqlite_ssot.md) · [运维](./docs/claude/v4-ssot-ops.md)
- [Sprint 16 dual-backend cutover](./docs/sprint16-cutover-complete.md) — DavMail 切换全程纪要
- [Post-cutover roadmap](./docs/roadmap-post-cutover.md) — 含 EWS 2026-10 关停应对
- [LLM Agent 启用清单](./docs/LLM_AGENT_SETUP.md) · [日历模块](./docs/claude/calendar-ops.md)
- [KOS 集成设计](./docs/kos-integration-design.md) · [CLI 命令全表](./docs/claude/cli-reference.md)

## License

MIT
