# CLAUDE.md

为 Claude Code 提供的项目指南。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步
- 自动识别邮件中的会议邀请（iCalendar）并创建日程
- AI 分类与处理（通过 Notion）
- 双向 Flag 同步（已读/旗标状态 Mail.app ↔ Notion）
- 飞书应用机器人通知（重要邮件推送 + 交互式回复按钮 → Openclaw）
- Notion Webhook → Redis → Mail.app 实时事件驱动
- Office 附件自动转换（docx/pptx→PDF, xlsx→CSV）

**架构版本：v3 SQLite-First**（2026-01 优化）
- 使用 `internal_id`（SQLite ROWID = AppleScript id）作为主键
- AppleScript 查询性能提升 **127 倍**（~1s vs ~100s）
- 支持大邮箱（6-7 万封邮件）

**技术栈：**
- Python >=3.9（本地开发 3.11+，远程 webhook-server 3.9+）
- AppleScript（Mail.app 交互）
- SQLite（状态存储 + 变化检测）
- Notion API（notion-client）
- BeautifulSoup/lxml（HTML 解析）
- Pydantic（配置管理）
- Redis（Notion→Mail 事件队列）
- FastAPI（Webhook Server）
- LibreOffice headless（Office→PDF 转换）
- pandas + python-calamine（xlsx→CSV 转换）

## 命令速查

```bash
# 环境准备
source venv/bin/activate
pip install -r requirements.txt

# 测试
python3 scripts/test_notion_api.py      # Notion 连接
python3 scripts/test_mail_reader.py     # 邮件读取
python3 scripts/debug_mail_structure.py # 查看邮箱名称

# 初始化同步
python3 scripts/initial_sync.py --action fetch-cache --inbox-count 3000 --sent-count 500
python3 scripts/initial_sync.py --action analyze
python3 scripts/initial_sync.py --action all --yes

# 运行服务
python3 main.py                         # 前台运行
pm2 start main.py --name mail-sync --interpreter ./venv/bin/python3  # PM2（必须用 venv python）

# 日志
tail -f logs/sync.log

# 部署 webhook-server 到远程服务器
./scripts/deploy-webhook.sh

# 远程服务器 venv 初始化（首次部署或升级 Python 后）
# ssh 到远程后: cd /home/lighthouse/MailAgent/webhook-server && python3 -m venv venv
```

### 部署环境

| 环境 | Python 版本 | 用途 |
|------|-----------|------|
| 本地 macOS | 3.11+ | main.py 邮件同步主服务 |
| 远程 VPS (170.106.181.89) | 3.9+ | webhook-server FastAPI 服务 |

> `pyproject.toml` 声明 `requires-python = ">=3.9"`，代码已兼容 Python 3.9+。

## 架构

### v3 SQLite-First 架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        v3 架构 (SQLite 优先)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. SQLite Radar 检测 (~5ms)                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 检测 max_row_id 变化 → 直接获取新邮件元数据（含 internal_id）        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  2. 写入 SyncStore (internal_id 主键, message_id=NULL)                     │
│                              │                                              │
│                              ▼                                              │
│  3. AppleScript 获取完整内容 (~1s/封，使用 `whose id is <int>`)            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ fetch_email_content_by_id(internal_id, mailbox)                      │   │
│  │ → 返回 message_id, source, thread_id 等                              │   │
│  │ → 更新 SyncStore (填充 message_id)                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  4. 同步到 Notion                                                          │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - 解析 MIME 源码（HTML、附件、内联图片）                             │   │
│  │ - 检测会议邀请 (.ics) → 创建日程                                     │   │
│  │ - 创建 Notion 邮件页面（含线程关系）                                 │   │
│  │ - 标记 sync_status='synced'                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  5. 失败重试（统一在 email_metadata 表）                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - fetch_failed: AppleScript 失败 → 用 internal_id 重试               │   │
│  │ - failed: Notion 失败 → 用 internal_id 重新获取并同步                │   │
│  │ - 指数退避: 1min, 5min, 15min, 1h, 2h                                │   │
│  │ - 超过最大重试 → dead_letter 状态                                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 性能对比

| 查询方式 | 耗时 | 说明 |
|---------|------|------|
| `whose message id is "<字符串>"` | ~100 秒 | 旧方式，线性搜索 |
| `whose id is <整数>` | ~1 秒 | **v3 方式，提升 127 倍** |

### 模块说明

#### 邮件模块 (`src/mail/`)

| 模块 | 职责 |
|------|------|
| `new_watcher.py` | 主监听器，v3 架构主循环（SQLite 优先） |
| `sqlite_radar.py` | SQLite 雷达：检测变化 + `get_new_emails()` 获取元数据 |
| `applescript_arm.py` | AppleScript 机械臂：`fetch_email_content_by_id()` 核心方法 |
| `applescript.py` | AppleScript 底层执行封装 |
| `sync_store.py` | SQLite 同步状态存储（**internal_id 主键**，v3 架构） |
| `reader.py` | MIME 邮件解析（HTML、附件、thread_id） |
| `meeting_sync.py` | 会议邀请检测与同步 |
| `icalendar_parser.py` | iCalendar 解析器 |
| `health_check.py` | 健康检查（发现遗漏邮件） |
| `reverse_sync.py` | 反向同步（Notion → Mail.app + 飞书通知 + Processing Status 更新） |

#### 通知模块 (`src/notify/`)

| 模块 | 职责 |
|------|------|
| `feishu.py` | 飞书应用机器人通知（App Bot API + Card 2.0 form 交互：可编辑回复、修改意见、附加收件人/抄送，回调 Openclaw） |
| `alert.py` | 飞书告警机器人（群聊 Webhook Bot，可配置级别/冷却/卡片样式） |

#### 监控模块 (`src/`)

| 模块 | 职责 |
|------|------|
| `stats_reporter.py` | 定期上报运行统计到远程看板（sync/reverse/handlers/alerts） |

#### 事件模块 (`src/events/`)

| 模块 | 职责 |
|------|------|
| `redis_consumer.py` | Redis BLPOP 队列消费者（自动重连） |
| `handlers.py` | Webhook 事件处理器（flag_changed / ai_reviewed / completed / create_draft / query_mail / fetch_mail_content / page_updated） |

#### Webhook Server (`webhook-server/`)

| 模块 | 职责 |
|------|------|
| `app.py` | FastAPI 服务，接收 Notion Automation webhook → Redis 队列路由 + 看板 API |
| `dashboard.html` | 监控看板前端（同步概览、服务状态、告警、Redis 队列） |
| `ecosystem.config.js` | PM2 进程配置（端口 8100） |
| `deploy.md` | 服务器部署指南 |
| `../scripts/deploy-webhook.sh` | 一键部署脚本（`sshpass` + SSH） |

**远程服务器**：`ubuntu@170.106.181.89`，路径 `/opt/MailAgent/webhook-server`，PM2 进程名 `mailagent-webhook`。SSH 认证：公钥（`~/.ssh/id_ed25519`）。

#### Notion 模块 (`src/notion/`)

| 模块 | 职责 |
|------|------|
| `client.py` | Notion API 封装（文件上传、页面操作） |
| `sync.py` | 邮件同步逻辑（线程关系、Parent Item） |

#### 日历模块 (`src/calendar_notion/`)

| 模块 | 职责 |
|------|------|
| `sync.py` | 日历事件同步到 Notion |
| `description_parser.py` | Teams 会议信息提取 |

#### 转换模块 (`src/converter/`)

| 模块 | 职责 |
|------|------|
| `html_converter.py` | HTML → Notion Blocks（含内联图片） |
| `eml_generator.py` | 生成 .eml 归档文件 |
| `office_converter.py` | Office 附件转换（docx/pptx→PDF via LibreOffice, xlsx→CSV via pandas） |

### 关键流程

#### 1. 新邮件检测与同步（v3 架构）

```python
# new_watcher.py
async def _poll_cycle():
    # 1. SQLite 雷达检测变化
    has_new, current_max, estimated = radar.check_for_changes(last_max_row_id)

    if has_new:
        # 2. SQLite 直接获取新邮件元数据（含 internal_id）
        new_emails = radar.get_new_emails(since_row_id=last_max_row_id)

        # 3. 立即写入 SyncStore（internal_id 主键，message_id=NULL）
        for email_meta in new_emails:
            sync_store.save_email({
                'internal_id': email_meta['internal_id'],
                'message_id': None,  # AppleScript 成功后填充
                'sync_status': 'pending',
                ...  # SQLite 元数据
            })

        # 4. 更新 last_max_row_id
        sync_store.set_last_max_row_id(current_max)

    # 5. 处理 pending 邮件
    await _process_pending_emails()

    # 6. 处理重试队列
    await _process_retry_queue()

async def _sync_single_email_v3(email_meta):
    internal_id = email_meta['internal_id']
    mailbox = email_meta['mailbox']

    # 1. AppleScript 通过 internal_id 获取（快速 ~1s）
    full_email = arm.fetch_email_content_by_id(internal_id, mailbox)

    # 2. 更新 SyncStore（填充 message_id、thread_id）
    sync_store.update_after_fetch(internal_id, {
        'message_id': full_email['message_id'],
        'thread_id': full_email['thread_id'],
        ...
    })

    # 3. 检测会议邀请
    if meeting_sync.has_meeting_invite(full_email['source']):
        calendar_page_id = await meeting_sync.process_email(...)

    # 4. 日期过滤
    if email_date < sync_start_date:
        sync_store.mark_skipped(internal_id)
        return

    # 5. 同步到 Notion
    email_obj = reader.parse_email_source(full_email['source'], ...)
    page_id = await notion_sync.create_email_page_v2(email_obj)

    # 6. 标记成功
    sync_store.mark_synced_v3(internal_id, page_id)
```

#### 2. 线程关系处理

```python
# notion/sync.py
async def _find_or_create_parent(email, thread_id):
    # 1. 查找现有 Parent（通过 message_id）
    parent = await query_by_message_id(thread_id)
    if parent:
        return parent['page_id']

    # 2. 检查缓存（线程头找不到）
    if sync_store.is_thread_head_not_found(thread_id):
        return await _use_fallback_parent(thread_id)

    # 3. 尝试获取线程头邮件
    thread_head = arm.fetch_email_by_message_id(thread_id)
    if thread_head:
        parent_page_id = await sync_email(thread_head)
        return parent_page_id

    # 4. 标记为找不到，使用 fallback
    sync_store.mark_thread_head_not_found(thread_id)
    return await _use_fallback_parent(thread_id)
```

#### 3. 重试机制（统一处理）

```python
# new_watcher.py
async def _process_retry_queue():
    # 获取可重试邮件（fetch_failed 或 failed）
    ready_emails = sync_store.get_ready_for_retry(limit=3)

    for record in ready_emails:
        internal_id = record['internal_id']
        mailbox = record['mailbox']

        # 统一用 internal_id 获取 MIME（无论哪种失败）
        full_email = arm.fetch_email_content_by_id(internal_id, mailbox)

        # 后续流程与正常同步相同...
```

**状态流转：**
```
pending → fetch_failed → (重试) → fetched → failed → (重试) → synced
                ↓                              ↓
         (超过重试次数)                  (超过重试次数)
                ↓                              ↓
           dead_letter                    dead_letter
```

#### 3. Processing Status 生命周期（双向同步）

```
Processing Status 状态流转:

未处理 ──(AI 审核)──→ AI Reviewed ──(反向同步)──→ 已同步 ──(用户处理)──→ 已完成
```

**各状态说明：**

| 状态 | 含义 | 触发方 | 动作 |
|------|------|--------|------|
| `未处理` | 新邮件等待 AI 审核 | 系统自动 | 无 |
| `AI Reviewed` | AI 已设置 Action Type + Priority | AI Automation | 触发反向同步 |
| `已同步` | 已同步到 Mail.app | 反向同步成功后自动 | 不再处理 |
| `已完成` | 用户已处理（如已回复） | 用户手动 / Mail.app 取消旗标 | 移除旗标 |

**反向同步 Action Type 映射：**

| Action Type | Mail.app 操作 | 飞书通知 |
|------------|--------------|---------|
| 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 | 标记已读 + 设旗标 | 紧急/重要时推送卡片（含「✨ 优化回复」「📝 创建草稿」按钮 → Openclaw） |
| 仅供参考/已完结 | 标记已读 | 否 |

**双向完成闭环：**
- Mail.app 取消旗标 → 正向同步 → Notion `Is Flagged=False` + `Processing Status=已完成`
- Notion 标记 `已完成` → webhook `?event=completed` → 移除 Mail.app 旗标

**Webhook 事件类型：**

| 事件 | 触发条件 | 处理动作 |
|------|---------|---------|
| `flag_changed` | Is Read / Is Flagged 变化 | 同步到 Mail.app |
| `ai_reviewed` | Processing Status → AI Reviewed | Mail.app 标旗 + 飞书通知 + 状态更新为已同步 |
| `completed` | Processing Status → 已完成 | 移除 Mail.app 旗标 |
| `create_draft` | Notion 按钮触发 | 调用脚本创建 Mail.app 回复草稿 + 状态更新为草稿已创建 |
| `query_mail` | 外部系统查询 | 搜索邮件元数据（支持 `source=syncstore` 已同步 或 `source=mail` 全量 ~24k） |
| `fetch_mail_content` | 外部系统查询 | 通过 internal_id 获取邮件完整正文（AppleScript ~1-3s） |
| `page_updated` | 通用事件 | 自动路由到上述处理器 |

#### 4. 内联图片处理

```python
# converter/html_converter.py
def convert(html, image_map=None):
    """
    image_map: {cid: file_upload_id}

    处理流程：
    1. 解析 HTML，找到 <img src="cid:xxx">
    2. 从 image_map 查找对应的 file_upload_id
    3. 创建 Notion image block
    """
```

**关键点**：AppleScript 无法保存内联图片，必须从 MIME 源码提取。

### SyncStore 数据结构（v3 架构）

```sql
-- 邮件元数据（internal_id 为主键）
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY,      -- SQLite ROWID = AppleScript id
    message_id TEXT UNIQUE,               -- AppleScript 成功后填充，用于去重
    thread_id TEXT,
    subject TEXT,
    sender TEXT,
    sender_name TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    date_received TEXT,
    mailbox TEXT,
    is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0,
    sync_status TEXT DEFAULT 'pending',   -- pending/fetch_failed/fetched/synced/failed/skipped/dead_letter
    notion_page_id TEXT,
    notion_thread_id TEXT,
    sync_error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,                   -- 指数退避重试时间
    created_at REAL,
    updated_at REAL
);

-- 索引
CREATE UNIQUE INDEX idx_message_id ON email_metadata(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_sync_status ON email_metadata(sync_status);
CREATE INDEX idx_next_retry ON email_metadata(next_retry_at) WHERE sync_status IN ('fetch_failed', 'failed');

-- 同步状态
CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);  -- last_max_row_id, last_sync_time

-- 线程头缓存
CREATE TABLE thread_head_cache (
    thread_id TEXT PRIMARY KEY,
    status TEXT,  -- not_found
    created_at TEXT
);
```

**v3 架构关键变化：**
| 功能 | 旧架构 (v2) | 新架构 (v3) |
|------|------------|------------|
| 主键 | message_id | **internal_id** |
| 去重 | message_id | message_id (UNIQUE) |
| AppleScript 失败处理 | ❌ 无法追踪 | ✅ 用 internal_id 追踪 |
| 重试队列 | sync_failures 表 | **统一在 email_metadata** |
| 查询方式 | `whose message id is` | **`whose id is`** (127x 快) |

## 配置项

### 必填

| 变量 | 说明 |
|------|------|
| `NOTION_TOKEN` | Notion Integration Token |
| `EMAIL_DATABASE_ID` | 邮件数据库 ID |
| `CALENDAR_DATABASE_ID` | 日历数据库 ID |
| `USER_EMAIL` | 邮箱地址 |
| `MAIL_ACCOUNT_NAME` | Mail.app 账户名 |

### 同步配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SYNC_START_DATE` | `2026-01-01` | 只同步此日期后的邮件 |
| `SYNC_MAILBOXES` | `收件箱,发件箱` | 监听的邮箱 |
| `RADAR_POLL_INTERVAL` | `5` | 雷达轮询间隔（秒） |
| `HEALTH_CHECK_INTERVAL` | `3600` | 健康检查间隔（秒） |

### AppleScript 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `INIT_BATCH_SIZE` | `100` | 初始化每批获取数量 |
| `APPLESCRIPT_TIMEOUT` | `200` | 超时时间（秒） |

### 飞书通知配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_APP_ID` | `""` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | `""` | 飞书应用 App Secret |
| `FEISHU_CHAT_ID` | `""` | 飞书群聊 chat_id |
| `FEISHU_WEBHOOK_URL` | `""` | 飞书自定义机器人 webhook URL（备用） |
| `FEISHU_WEBHOOK_SECRET` | `""` | 签名密钥（可选） |
| `FEISHU_NOTIFY_ENABLED` | `false` | 是否启用飞书通知 |

### Redis 事件消费配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_URL` | `""` | Redis 连接 URL |
| `REDIS_DB` | `2` | Redis DB 号（MailAgent 专用） |
| `REDIS_EVENTS_ENABLED` | `false` | 是否启用 Redis 事件消费 |

### 看板统计上报配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `STATS_REPORT_URL` | `""` | 看板上报 URL（如 `https://mailagent.chenge.ink/api/stats/report`） |
| `STATS_REPORT_INTERVAL` | `60` | 上报间隔（秒） |
| `STATS_REPORT_TOKEN` | `""` | 上报认证 token |

### 飞书告警机器人配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ALERT_FEISHU_WEBHOOK_URL` | `""` | 飞书告警机器人 webhook URL |
| `ALERT_FEISHU_WEBHOOK_SECRET` | `""` | webhook 签名密钥 |
| `ALERT_ENABLED` | `false` | 是否启用飞书告警 |
| `ALERT_LEVELS` | `critical,error,warning` | 启用的告警级别（逗号分隔） |
| `ALERT_COOLDOWN` | `300` | 同类告警冷却时间（秒） |
| `ALERT_DEAD_LETTER_THRESHOLD` | `5` | dead_letter 累积告警阈值 |

**告警级别与卡片样式：**

| 级别 | 颜色 | 触发场景 |
|------|------|---------|
| `critical` | 红色 | 服务崩溃、健康检查失败 |
| `error` | 橙色 | 同步失败、API 错误、连续错误、Redis 断连 |
| `warning` | 黄色 | dead_letter 累积、雷达不可用、服务停止 |
| `info` | 蓝色 | 服务启动、恢复通知 |

### Office 附件转换配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OFFICE_CONVERT_ENABLED` | `true` | 是否启用 Office 附件转换（docx/pptx→PDF, xlsx→CSV） |

**依赖安装：**
```bash
# xlsx→CSV（pip 依赖，随 requirements.txt 安装）
pip install pandas openpyxl python-calamine

# docx/pptx→PDF（系统依赖）
brew install --cask libreoffice
brew install --cask font-noto-sans-cjk   # CJK 字体
```

### 防锁屏保活配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `KEEP_ALIVE_ENABLED` | `false` | 是否启用防锁屏保活（集成在 main.py 中） |
| `KEEP_ALIVE_DIM` | `true` | 保活时是否自动调低屏幕亮度 |

**保活机制：**
- 非工作时段自动模拟鼠标微移，防止 MDM 锁屏
- 工作日 9-12, 13-18 自动暂停（用户在工位）
- 检测到真人操作（鼠标大幅移动 >50px）自动暂停并恢复亮度
- 空闲超过 3 分钟自动恢复保活

**一键激活（离开工位时使用）：**
- SIGUSR1 信号切换强制保活：`kill -USR1 $(pm2 pid mail-sync)` 或 `scripts/toggle_keep_alive.sh`
- 强制模式无视工作时段限制，立即调暗屏幕并保活
- 移动鼠标自动退出强制模式并恢复亮度
- macOS 快捷指令绑定：快捷指令 → 运行 Shell 脚本 → `toggle_keep_alive.sh` → 绑定键盘快捷键

### Webhook Server 看板配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DASHBOARD_PASSWORD` | `""` | 看板登录密码（为空则禁用看板） |

## Notion 数据库结构

### 邮件数据库

必需字段：
- `Subject` (Title)
- `Message ID` (Text) - 去重用
- `Thread ID` (Text) - 线程关联
- `From` (Email), `From Name` (Text)
- `To`, `CC` (Text)
- `Date` (Date)
- `Parent Item` (Relation to self) - 线程头
- `Mailbox` (Select)
- `Is Read`, `Is Flagged`, `Has Attachments` (Checkbox)
- `AI Action` (Select) - AI 处理动作
- `AI Priority` (Select) - AI 优先级（Critical/Urgent/Important/Normal/Low）
- `AI Review Status` (Select) - AI 审核状态（Pending/Reviewed）

### 日历数据库

必需字段：
- `Title` (Title)
- `Event ID` (Text) - 去重用
- `Time` (Date) - 起止时间
- `URL` (URL) - Teams 链接
- `Location` (Text)
- `Organizer` (Text)
- `Status` (Select)

## 常见问题

### 邮箱名称错误

```bash
python3 scripts/debug_mail_structure.py
```

### SQLite 无法访问

需要 Full Disk Access：系统设置 → 隐私与安全 → 完全磁盘访问权限

### AppleScript 超时

增大 `APPLESCRIPT_TIMEOUT`（默认 200 秒）

## 开发指南

### 修改邮件解析

编辑 `src/mail/reader.py`，测试：
```bash
python3 scripts/test_mail_reader.py
```

### 修改会议检测

编辑 `src/mail/icalendar_parser.py` 或 `src/calendar_notion/description_parser.py`

### 添加新配置

1. 在 `src/config.py` 添加 Field
2. 在 `.env.example` 添加示例
3. 更新 CLAUDE.md

## 文件位置

- **日志**: `logs/sync.log`
- **数据库**: `data/sync_store.db`
- **临时附件**: `/tmp/email-notion-sync/{md5}/`
- **配置**: `.env`
- **优化文档**: `docs/applescript_id_optimization.md`
- **Webhook Server**: `webhook-server/`（远程部署，一键更新：`./scripts/deploy-webhook.sh`）

## 关于 calendar_main.py

`calendar_main.py` 是独立的日历同步服务，直接从 Calendar.app 读取事件。

**一般不需要运行**，因为：
- `main.py` 已包含会议邀请识别（从邮件中的 .ics）
- Calendar.app 中的会议可能不完整
- 邮件中的会议信息更全面

**仅在需要同步历史日程时使用**：
```bash
python3 calendar_main.py --once
```

## 迁移与运维

### v3 架构迁移

如需从 v2 迁移到 v3（internal_id 主键）：
```bash
python3 scripts/migrate_sync_store_v3.py
```

### 监控重点

```bash
# 查看 dead_letter 队列（需人工介入）
sqlite3 data/sync_store.db "SELECT COUNT(*) FROM email_metadata WHERE sync_status='dead_letter'"

# 查看重试队列
sqlite3 data/sync_store.db "SELECT internal_id, sync_status, retry_count FROM email_metadata WHERE sync_status IN ('fetch_failed', 'failed')"

# 查看同步统计
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"
```
