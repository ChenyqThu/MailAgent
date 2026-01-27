# CLAUDE.md

为 Claude Code 提供的项目指南。

## 项目概述

**MailAgent** 是一个 macOS 邮件实时同步系统，将 Mail.app 邮件同步到 Notion，支持：
- 邮件内容、附件、线程关系同步
- 自动识别邮件中的会议邀请（iCalendar）并创建日程
- AI 分类与处理（通过 Notion）

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

### 核心数据流

```
Mail.app SQLite ──雷达检测──▶ AppleScript ──获取邮件──▶ SyncStore
        │                                                   │
        │ (~5ms/次)                                         ▼
        │                                           ┌───────────────┐
        └───────────────────────────────────────────│ NotionSync    │
                                                    │   - 邮件页面  │
                                                    │   - 附件上传  │
                                                    └───────┬───────┘
                                                            │
                                                            ▼
                                          ┌─────────────────────────────────┐
                                          │ MeetingInviteSync (检测 .ics)   │
                                          │   - 解析 iCalendar              │
                                          │   - 创建日程页面                │
                                          └─────────────────────────────────┘
```

### 模块说明

#### 邮件模块 (`src/mail/`)

| 模块 | 职责 |
|------|------|
| `new_watcher.py` | 主监听器，协调雷达、机械臂、同步器 |
| `sqlite_radar.py` | 检测 Mail.app SQLite 数据库变化（max_row_id） |
| `applescript_arm.py` | 通过 AppleScript 获取邮件详情 |
| `sync_store.py` | SQLite 同步状态存储（message_id 去重） |
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

#### 1. 新邮件检测与同步

```python
# new_watcher.py
async def _poll_loop():
    while True:
        # 1. 雷达检测变化
        has_new, estimated = radar.check_for_changes()

        if has_new:
            # 2. AppleScript 获取最新邮件
            emails = arm.fetch_latest_emails(count=estimated + 5)

            for email in emails:
                # 3. 检查是否已同步
                if sync_store.is_synced(email.message_id):
                    continue

                # 4. 获取完整内容并同步
                content = arm.fetch_email_content(email.message_id)
                page_id = await notion_sync.sync_email(email)

                # 5. 检测会议邀请
                if meeting_sync.has_meeting_invite(content):
                    calendar_page_id = await meeting_sync.process_email(content)

                # 6. 更新同步状态
                sync_store.mark_synced(email.message_id, page_id)

        await asyncio.sleep(poll_interval)
```

#### 2. 线程关系处理

```python
# notion/sync.py
async def _find_or_create_parent(email, thread_id):
    # 1. 查找现有 Parent
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

### SyncStore 数据结构

```sql
-- 邮件元数据
CREATE TABLE email_metadata (
    message_id TEXT PRIMARY KEY,
    thread_id TEXT,
    subject TEXT,
    sender TEXT,
    date_received TEXT,
    mailbox TEXT,
    sync_status TEXT,  -- pending / synced / failed
    notion_page_id TEXT,
    created_at TEXT,
    updated_at TEXT
);

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
