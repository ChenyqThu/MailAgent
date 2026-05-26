# MailAgent

邮件实时同步到 Notion，支持 AI 自动分类与处理。

> **2026-05-22 起**：默认 backend 已从 macOS Mail.app + AppleScript 切换到 **DavMail IMAP/SMTP/CalDAV**（详见 [`docs/sprint16-cutover-complete.md`](./docs/sprint16-cutover-complete.md)）。AppleScript 路径保留作 emergency fallback。配置项 `MAILAGENT_BACKEND=davmail|applescript` 一行切换。

## 功能概览

| 功能 | 数据源 | 说明 |
|------|--------|------|
| **邮件同步** | DavMail IMAP（主）/ Mail.app（fallback） | 邮件内容、附件、线程关系同步到 Notion |
| **会议邀请识别** | 邮件中的 .ics | 自动解析会议邀请创建日程 |
| **双向 Flag 同步** | Mail.app ↔ Notion | 已读/旗标状态实时双向同步 |
| **AI 分类处理** | Notion Automation 或本地 LLM | Notion Email Agent 或本地 Anthropic 兼容 LLM（见 [docs/LLM_AGENT_SETUP.md](./docs/LLM_AGENT_SETUP.md)） |
| **飞书通知** | 飞书应用机器人 | 重要邮件推送 + 交互式回复按钮 |
| **飞书告警** | 飞书 Webhook Bot | 服务异常实时告警（可配置级别/冷却） |
| **监控看板** | 远程 Dashboard | 同步概览、服务状态、告警、Redis 队列 |
| **日历同步** | Calendar.app | 仅用于同步历史日程（可选） |

### 邮件同步特性
- **v3 SQLite-First 架构**：大邮箱（6-7 万封）支持，单封邮件获取 ~1s（vs 旧架构 ~100s）
- **v4 SQLite SSoT 架构（Phase 1 已上线 2026-05-15）**：邮件正文（HTML + Markdown）+ 附件元数据双写到 SQLite，附件二进制落 `data/attachments/{internal_id}/`，为 RAG / FTS5 / Web 前端打地基。详见 [`docs/architecture_v4_sqlite_ssot.md`](./docs/architecture_v4_sqlite_ssot.md)
- 基于 message_id 的 100% 准确去重
- 自动建立邮件线程 Parent-Child 关系
- **自动识别会议邀请**：检测邮件中的 iCalendar 附件，创建日程页面
- HTML 正文转 Notion Blocks（含内联图片）
- 附件上传到 Notion
- 失败自动重试（指数退避）

### 关于日历同步

日历同步现统一走 `CalendarSyncWorker`（在 `mail-sync` 进程内的 asyncio loop），
拉取 DavMail CalDAV → SQLite `calendar_event` SSoT。详见 CLAUDE.md "Calendar
Module" 段。

---

## 快速开始

### 1. 环境准备

```bash
git clone <your-repo-url>
cd MailAgent
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
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

首次使用需将历史邮件同步到 Notion：

```bash
# 完整初始化流程
python3 scripts/initial_sync.py --action all --yes

# 或分步执行：
python3 scripts/initial_sync.py --action fetch-cache --inbox-count 3000 --sent-count 500
python3 scripts/initial_sync.py --action analyze
python3 scripts/initial_sync.py --action all --yes
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

---

## 架构说明

```
┌─────────────────────────────────────────────────────────────────┐
│                        main.py (邮件同步)                        │
├─────────────────────────────────────────────────────────────────┤
│  SQLite Radar ──检测变化──▶ AppleScript Arm ──获取邮件──▶        │
│                                    ↓                             │
│                             SyncStore (去重)                     │
│                                    ↓                             │
│                  ┌─────────────────┴─────────────────┐           │
│                  ↓                                   ↓           │
│         NotionSync (邮件页面)              MeetingInviteSync     │
│                  ↓                            (解析 .ics)        │
│            Notion Email DB                        ↓              │
│                                          Notion Calendar DB      │
└─────────────────────────────────────────────────────────────────┘
```

**核心流程**：
1. SQLite Radar 每 5 秒检测 Mail.app 数据库变化
2. 发现新邮件后，通过 AppleScript 获取完整内容
3. 解析邮件，**v4 双写邮件正文 + 附件元数据到本地 SQLite**（`email_body` / `email_attachment` 表），附件二进制落 `data/attachments/{internal_id}/`
4. 同步到 Notion Email 数据库（Notion 退化为镜像）
5. 如果邮件包含会议邀请（.ics），自动创建日程到 Calendar 数据库

> **v4 架构演进**：正在分 5 个 Phase 把 Notion 从"唯一持久化处"反转为"本地 SQLite 为 SSoT，Notion 是镜像"。Phase 1（双写 MVP）已上线；Phase 2-5 推进中。详见 [`docs/architecture_v4_sqlite_ssot.md`](./docs/architecture_v4_sqlite_ssot.md)。

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
python3 scripts/debug_mail_structure.py
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
├── main.py                 # 邮件同步入口（主服务，含 CalendarSyncWorker asyncio loop）
├── src/
│   ├── mail/               # 邮件模块
│   │   ├── new_watcher.py      # 监听器（v3 架构主循环）
│   │   ├── sqlite_radar.py     # SQLite 雷达（变化检测）
│   │   ├── applescript_arm.py  # AppleScript 获取器
│   │   ├── sync_store.py       # 同步状态存储
│   │   ├── reverse_sync.py     # 反向同步（Notion → Mail.app）
│   │   ├── meeting_sync.py     # 会议邀请同步
│   │   ├── icalendar_parser.py # iCalendar 解析
│   │   └── reader.py           # 邮件解析
│   ├── notify/             # 通知模块
│   │   ├── feishu.py           # 飞书应用机器人（邮件通知）
│   │   └── alert.py            # 飞书告警机器人（服务告警）
│   ├── events/             # 事件模块
│   │   ├── redis_consumer.py   # Redis 队列消费者
│   │   └── handlers.py         # Webhook 事件处理器
│   ├── notion/             # Notion 邮件同步
│   ├── calendar_notion/    # Notion 日历同步
│   ├── converter/          # HTML 转换
│   ├── stats_reporter.py   # 看板统计上报
│   ├── models.py           # 数据模型
│   └── config.py           # 配置管理
├── scripts/
│   ├── initial_sync.py     # 初始化同步
│   ├── create_reply_draft.sh  # 创建回复草稿
│   ├── html_clipboard.py      # HTML 剪贴板工具
│   ├── deploy-webhook.sh      # 部署 webhook-server
│   └── test_*.py           # 测试脚本
├── webhook-server/         # 远程 Webhook 服务
│   ├── app.py                 # FastAPI 服务
│   └── dashboard.html         # 监控看板
├── data/
│   └── sync_store.db       # 同步状态数据库
└── logs/
```

---

## 开发文档

- [架构设计](./docs/new_architecture_design.md)
- [v4 SQLite SSoT 架构](./docs/architecture_v4_sqlite_ssot.md)
- [Sprint 16 dual-backend cutover](./docs/sprint16-cutover-complete.md) — DavMail 切换全程纪要
- [Dual-backend 设计 + 决策](./docs/dual-backend-architecture-handoff.md)
- [Post-cutover roadmap](./docs/roadmap-post-cutover.md) — 短中长期任务（含 EWS 2026-10 关停应对）
- [初始同步指南](./docs/initial_sync.md)
- [LLM Agent 启用清单](./docs/LLM_AGENT_SETUP.md)
- [开发指南](./CLAUDE.md)

## License

MIT
