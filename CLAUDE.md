# CLAUDE.md

为 Claude Code 提供的项目指南。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步
- 自动识别邮件中的会议邀请（iCalendar）并创建日程
- AI 分类与处理（通过 Notion）

**架构版本：v3 SQLite-First**（2026-01 优化）
- 使用 `internal_id`（SQLite ROWID = AppleScript id）作为主键
- AppleScript 查询性能提升 **127 倍**（~1s vs ~100s）
- 支持大邮箱（6-7 万封邮件）

**技术栈：**
- Python 3.11+ / asyncio
- AppleScript（Mail.app 交互）
- SQLite（状态存储 + 变化检测）
- Notion API（notion-client）
- BeautifulSoup/lxml（HTML 解析）
- Pydantic（配置管理）

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
pm2 start main.py --name mail-sync --interpreter python3  # PM2

# 日志
tail -f logs/sync.log
```

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
| `reverse_sync.py` | 反向同步（Notion → Mail.app） |

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

#### 3. 内联图片处理

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
