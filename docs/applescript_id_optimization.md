# AppleScript 内部 ID 优化方案

生成时间: 2026-01-28
最后更新: 2026-01-28
状态: 📋 **待实现**

## 1. 需求背景

### 1.1 问题现象

在大邮箱环境（6-7 万封邮件）下运行 `test_mail_reader.py`：
- ✅ 获取最新 5 封邮件元数据：正常（~2 秒）
- ❌ 获取第一封邮件正文内容：**卡死超时**（>100 秒）
- ❌ Mail.app 同时卡死，需要强制退出

小邮箱环境（1 万封邮件）下运行正常。

### 1.2 问题根因分析

当前架构使用 AppleScript `whose message id is "<字符串>"` 查询邮件：

```applescript
-- 当前方式（慢）
set theMessage to first message whose message id is "MWHPR05MB3390E13395C116EF4B825C38C091A@..."
```

**AppleScript 的 `whose` 子句问题：**
- `whose` 是 **线性搜索** (O(n))，需遍历所有邮件
- 字符串比较（`message id`）比整数比较更耗时
- 邮箱有子文件夹时，可能触发更大范围的扫描
- 大数据量下导致 Mail.app 主线程阻塞

### 1.3 性能测试数据

| 查询方式 | 耗时 | 说明 |
|---------|------|------|
| `whose message id is "<字符串>"` | **101.16 秒** | 当前方式，不可接受 |
| `whose id is <整数>` | **0.80 秒** | 新方式，提升 **127 倍** |

测试环境：1 万封邮件的收件箱。在 6-7 万封邮件环境下差异更大。

---

## 2. 关键发现

### 2.1 SQLite ROWID = AppleScript id

通过测试验证：

```
Mail.app SQLite 数据库 (Envelope Index)
├── messages 表
│   └── ROWID: 41457  ←─────┐
│                           │ 完全相同！
AppleScript                 │
└── message                 │
    └── id: 41457  ─────────┘
```

**验证结果：100 封随机邮件对比，匹配率 100%**

```
总样本: 100
SQLite+AppleScript 都找到: 100
  - 完全匹配: 100
  - 不匹配: 0
匹配率: 100.0%
```

### 2.2 历史 85% 匹配率问题的原因

之前尝试过 SQLite + AppleScript 映射，但只有 85% 匹配率。原因是：

| 旧方案 | 新方案 |
|--------|--------|
| 用主题+日期+发件人启发式匹配 | 用 ROWID = id 直接映射 |
| 字段可能有差异（Re: 前缀等） | 整数 ID 完全一致 |
| ~85% 匹配率 | **100% 匹配率** |

### 2.3 SQLite 可提供的数据

Mail.app SQLite 数据库可查询：

| 字段 | 说明 | 可用于 |
|------|------|--------|
| `ROWID` | 内部 ID（= AppleScript id） | 快速定位邮件 |
| `subject` | 主题（含前缀） | 显示 |
| `sender` | 发件人邮箱和名称 | 显示 |
| `date_received` | 接收时间（Unix timestamp） | 排序、过滤 |
| `read` | 是否已读 | 状态 |
| `flagged` | 是否标记 | 状态 |
| `mailbox` | 邮箱（可区分收件箱/发件箱） | 精准查询 |

**SQLite 无法提供**：
- RFC 2822 `Message-ID` 字符串（用于去重和线程）
- 邮件正文 / 源码
- `References` / `In-Reply-To` 头部

### 2.4 SQLite 邮箱区分

SQLite 可通过 `mailboxes.url` 区分邮箱：

| URL 编码 | 解码 |
|----------|------|
| `%E6%94%B6%E4%BB%B6%E7%AE%B1` | 收件箱 |
| `%E5%B7%B2%E5%8F%91%E9%80%81%E9%82%AE%E4%BB%B6` | 已发送邮件 |
| `%E5%8F%91%E4%BB%B6%E7%AE%B1` | 发件箱 |

---

## 3. 优化方案

### 3.1 架构变更概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        优化架构 v3 (SQLite 优先)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. 检测阶段 (SQLite Radar, ~5ms)                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 检测 max_row_id 变化                                                 │   │
│  │ 当前: 41460, 上次: 41455 → 新增约 5 封邮件                           │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  2. 快速查询新邮件元数据 (SQLite, ~10ms)                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ SELECT ROWID, subject, sender, date, mailbox, is_read, is_flagged   │   │
│  │ FROM messages WHERE ROWID > 41455 AND deleted = 0                   │   │
│  │                                                                      │   │
│  │ 返回: [{internal_id: 41456, subject: "...", mailbox: "收件箱", ...}]│   │
│  │                                                                      │   │
│  │ ✅ 毫秒级查询                                                        │   │
│  │ ✅ 精确获取新邮件，无需估算 buffer                                   │   │
│  │ ✅ 包含邮箱信息，可精准定位                                          │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  3. 获取 message_id + 完整内容 (AppleScript, ~1s/封)                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 对每个 {internal_id, mailbox}:                                       │   │
│  │                                                                      │   │
│  │   tell mailbox "收件箱"                                              │   │
│  │       whose id is 41456 → 获取 message_id, source, content          │   │
│  │   end tell                                                           │   │
│  │                                                                      │   │
│  │ ✅ 用整数 id 查询，快速（~1s vs ~100s）                              │   │
│  │ ✅ 指定邮箱，更精准                                                  │   │
│  │ ✅ 获取 message_id 用于去重和线程关系                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  4. 去重检查 (SyncStore)                                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ 检查 message_id 是否已存在于 SyncStore                               │   │
│  │ - 存在 → 跳过（已同步）                                              │   │
│  │ - 不存在 → 继续同步                                                  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  5. 同步到 Notion + 更新状态                                               │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - 解析 MIME 源码，提取 HTML、附件、thread_id                         │   │
│  │ - 创建 Notion 页面                                                   │   │
│  │ - 保存到 SyncStore：                                                 │   │
│  │     {message_id, internal_id, subject, ..., sync_status: 'synced'}  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  6. 失败重试机制（统一在 email_metadata）                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - 失败时：更新 sync_status='failed', 计算 next_retry_at             │   │
│  │ - 无单独的 sync_failures 表                                         │   │
│  │ - 每次轮询查询 next_retry_at <= now 的记录                          │   │
│  │ - 使用 internal_id 重试（快速，~1s）                                │   │
│  │ - 超过最大重试次数 → dead_letter 状态                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 与当前架构的对比

| 步骤 | 当前架构 (v2) | 优化架构 (v3) |
|------|---------------|---------------|
| 检测新邮件 | SQLite max_row_id | SQLite max_row_id |
| 获取新邮件列表 | AppleScript 批量 (N+buffer) | **SQLite 查询 + 写入 SyncStore** |
| SyncStore 主键 | message_id | **internal_id** |
| AppleScript 失败处理 | ❌ 无法追踪 | ✅ **用 internal_id 追踪** |
| 获取完整内容 | `whose message id is` (慢) | **`whose id is`** (快) |
| 重试队列 | sync_failures 表 | **统一在 email_metadata** |
| 单封邮件获取 | ~100 秒 | **~1 秒** |

### 3.3 SyncStore 的角色

**新架构下 SyncStore 的核心变化**：

| 功能 | 旧架构 | 新架构 v3 |
|------|--------|-----------|
| **主键** | message_id | **internal_id** |
| **去重** | message_id | message_id（UNIQUE 约束）|
| **重试追踪** | sync_failures 表 | **统一在 email_metadata** |
| **AppleScript 失败处理** | ❌ 无法追踪 | ✅ 用 internal_id 追踪 |

**为什么改用 internal_id 作为主键？**

```
问题场景：
1. SQLite 检测到新邮件（只有 internal_id，没有 message_id）
2. AppleScript 获取失败 ❌
3. 旧架构：无法写入 SyncStore（主键是 message_id）→ 邮件丢失！
4. 新架构：直接写入 SyncStore（主键是 internal_id）→ 等待重试 ✅
```

**SyncStore 的作用**：

1. **追踪所有邮件状态**：从 SQLite 检测到开始，全程追踪
2. **去重**：用 message_id（AppleScript 成功后填充）
3. **重试队列**：统一管理 fetch_failed 和 failed 状态
4. **线程关系**：message_id → notion_page_id 映射（Parent Item）
5. **位置记录**：last_max_row_id 持久化

### 3.4 需要修改的模块

| 模块 | 文件 | 修改内容 |
|------|------|----------|
| **SQLite Radar** | `src/mail/sqlite_radar.py` | 新增 `get_new_emails()` 方法，返回新邮件元数据（含 ROWID 和 mailbox） |
| **AppleScript Arm** | `src/mail/applescript_arm.py` | 1. `fetch_emails_by_position()` 额外返回 `id`<br>2. 新增 `fetch_email_content_by_id(id, mailbox)` 方法 |
| **MailAppScripts** | `src/mail/applescript.py` | 1. `get_email_details()` 支持 `internal_id` 参数<br>2. `get_email_source()` 支持 `internal_id` 参数<br>3. `save_attachments()` 支持 `internal_id` 参数 |
| **SyncStore** | `src/mail/sync_store.py` | 1. 合并 `sync_failures` 到 `email_metadata`<br>2. 新增 `internal_id`, `next_retry_at` 字段<br>3. 改进去重逻辑 |
| **EmailReader** | `src/mail/reader.py` | 修改 `get_email_details()` 优先使用 `internal_id` |
| **NewWatcher** | `src/mail/new_watcher.py` | 重构主循环，使用 SQLite 优先架构 |

---

## 4. 实现细节

### 4.1 SQLite Radar 新增方法

```python
# src/mail/sqlite_radar.py

def get_new_emails(self, since_row_id: int) -> List[Dict[str, Any]]:
    """
    获取指定 ROWID 之后的所有新邮件元数据

    Args:
        since_row_id: 起始 ROWID（不包含）

    Returns:
        List[Dict] 包含:
            - internal_id: int (ROWID)
            - subject: str
            - sender_email: str
            - sender_name: str
            - date_received: str (ISO format)
            - is_read: bool
            - is_flagged: bool
            - mailbox: str (收件箱/发件箱/...)
    """
    query = """
        SELECT
            m.ROWID as internal_id,
            COALESCE(m.subject_prefix, '') || s.subject as subject,
            a.address as sender_email,
            a.comment as sender_name,
            datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
            m.read as is_read,
            m.flagged as is_flagged,
            mb.url as mailbox_url
        FROM messages m
        JOIN subjects s ON m.subject = s.ROWID
        LEFT JOIN addresses a ON m.sender = a.ROWID
        LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
        WHERE m.deleted = 0 AND m.ROWID > ?
        ORDER BY m.ROWID ASC
    """
    # 解析 mailbox_url 提取邮箱名称
    # ...
```

### 4.2 AppleScript Arm 新增方法

```python
# src/mail/applescript_arm.py

def fetch_email_content_by_id(
    self,
    internal_id: int,
    mailbox: str = None
) -> Optional[Dict[str, Any]]:
    """
    通过内部 id（整数）获取邮件完整内容

    Args:
        internal_id: 邮件内部 id（= SQLite ROWID）
        mailbox: 邮箱名称（如 "收件箱"），指定可加速查询

    Returns:
        Dict 包含:
            - message_id: str (RFC 2822)
            - subject: str
            - sender: str
            - date: str
            - content: str
            - source: str
            - is_read: bool
            - is_flagged: bool
    """
```

AppleScript 实现：

```applescript
tell application "Mail"
    tell account "Exchange"
        -- 如果指定了邮箱，直接在该邮箱查找（更快）
        if mailbox_name is not "" then
            tell mailbox mailbox_name
                set theMessage to first message whose id is internal_id
            end tell
        else
            -- 否则遍历所有邮箱查找
            repeat with mbox in mailboxes
                try
                    set theMessage to first message of mbox whose id is internal_id
                    exit repeat
                end try
            end repeat
        end if

        -- 获取完整信息
        set msgMessageId to message id of theMessage
        set msgSource to source of theMessage
        -- ...
    end tell
end tell
```

### 4.3 SyncStore 数据库变更

#### 核心改动：internal_id 作为主键

**当前架构问题：**
- `message_id` 作为主键
- AppleScript 获取失败时没有 message_id，无法写入 SyncStore
- 邮件可能丢失

**新架构：internal_id 作为主键**

```sql
-- email_metadata 表（重构后）
CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY,      -- 新主键：SQLite ROWID = AppleScript id
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
    sync_status TEXT DEFAULT 'pending',   -- pending/fetch_failed/synced/failed/skipped/dead_letter
    notion_page_id TEXT,
    sync_error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,
    created_at REAL,
    updated_at REAL
);

-- 索引
CREATE UNIQUE INDEX idx_message_id ON email_metadata(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_sync_status ON email_metadata(sync_status);
CREATE INDEX idx_next_retry ON email_metadata(next_retry_at) WHERE sync_status IN ('fetch_failed', 'failed');
```

#### 状态流转

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           状态流转图                                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  SQLite 检测到新邮件                                                        │
│         │                                                                   │
│         ▼                                                                   │
│     ┌────────┐                                                              │
│     │pending │ ← 写入 SyncStore（internal_id, SQLite 元数据）              │
│     └───┬────┘                                                              │
│         │                                                                   │
│         ▼ AppleScript 获取                                                  │
│     ┌───┴───┐                                                               │
│     │       │                                                               │
│   成功    失败                                                              │
│     │       │                                                               │
│     │       ▼                                                               │
│     │   ┌──────────────┐                                                    │
│     │   │ fetch_failed │ ← 等待重试                                        │
│     │   └──────┬───────┘                                                    │
│     │          │ 重试成功                                                   │
│     │          │                                                            │
│     ▼          ▼                                                            │
│  更新 message_id + 刷新元数据                                               │
│         │                                                                   │
│         ▼ Notion 同步                                                       │
│     ┌───┴───┐                                                               │
│     │       │                                                               │
│   成功    失败                                                              │
│     │       │                                                               │
│     ▼       ▼                                                               │
│ ┌────────┐ ┌────────┐                                                       │
│ │ synced │ │ failed │ ← 等待重试                                           │
│ └────────┘ └───┬────┘                                                       │
│                │ 超过最大重试次数                                           │
│                ▼                                                            │
│          ┌─────────────┐                                                    │
│          │ dead_letter │                                                    │
│          └─────────────┘                                                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### message_id 重复处理

如果 AppleScript 获取后发现 message_id 已存在（同一封邮件被复制到多个文件夹）：

```python
existing = self.sync_store.get_by_message_id(message_id)
if existing:
    if existing['sync_status'] == 'synced':
        # 已同步过，删除当前记录（重复邮件）
        self.sync_store.delete(internal_id)
        logger.warning(f"Duplicate email detected, skipping: {message_id[:50]}...")
        return
    else:
        # 之前的记录未成功，删除旧的，使用新的 internal_id
        self.sync_store.delete(existing['internal_id'])
```

#### 迁移脚本

```python
# scripts/migrate_sync_store_v3.py

import sqlite3
import subprocess
from pathlib import Path

def migrate():
    """迁移 SyncStore 到 v3 架构（internal_id 作为主键）"""
    db_path = Path('data/sync_store.db')

    if not db_path.exists():
        print("Database not found, skipping migration")
        return

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # 1. 备份原表
    print("Step 1: Backing up original table...")
    cursor.execute("ALTER TABLE email_metadata RENAME TO email_metadata_backup")

    # 2. 创建新表（internal_id 为主键）
    print("Step 2: Creating new table with internal_id as primary key...")
    cursor.execute("""
        CREATE TABLE email_metadata (
            internal_id INTEGER PRIMARY KEY,
            message_id TEXT UNIQUE,
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
            sync_status TEXT DEFAULT 'pending',
            notion_page_id TEXT,
            notion_thread_id TEXT,
            sync_error TEXT,
            retry_count INTEGER DEFAULT 0,
            next_retry_at REAL,
            created_at REAL,
            updated_at REAL
        )
    """)

    # 3. 回填 internal_id（使用 AppleScript 批量获取）
    print("Step 3: Backfilling internal_id from AppleScript...")
    internal_id_map = backfill_internal_ids()

    # 4. 迁移数据
    print("Step 4: Migrating data...")
    cursor.execute("SELECT * FROM email_metadata_backup")
    rows = cursor.fetchall()

    migrated = 0
    skipped = 0
    for row in rows:
        message_id = row['message_id']
        internal_id = internal_id_map.get(message_id)

        if not internal_id:
            # 无法获取 internal_id，可能是旧邮件已删除
            # 对于 synced 状态的保留（用负数作为临时 ID）
            if row['sync_status'] == 'synced':
                internal_id = -hash(message_id) % 1000000000  # 负数临时 ID
            else:
                skipped += 1
                continue

        cursor.execute("""
            INSERT OR IGNORE INTO email_metadata
            (internal_id, message_id, thread_id, subject, sender, sender_name,
             to_addr, cc_addr, date_received, mailbox, is_read, is_flagged,
             sync_status, notion_page_id, notion_thread_id, sync_error,
             retry_count, next_retry_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            internal_id, message_id, row['thread_id'], row['subject'],
            row['sender'], row['sender_name'], row['to_addr'], row['cc_addr'],
            row['date_received'], row['mailbox'], row['is_read'], row['is_flagged'],
            row['sync_status'], row['notion_page_id'], row['notion_thread_id'],
            row['sync_error'], row['retry_count'], None,
            row['created_at'], row['updated_at']
        ))
        migrated += 1

    # 5. 删除 sync_failures 表（如果存在）
    print("Step 5: Dropping sync_failures table...")
    cursor.execute("DROP TABLE IF EXISTS sync_failures")

    # 6. 创建索引
    print("Step 6: Creating indexes...")
    cursor.execute("CREATE INDEX idx_sync_status ON email_metadata(sync_status)")
    cursor.execute("CREATE INDEX idx_next_retry ON email_metadata(next_retry_at)")
    cursor.execute("CREATE INDEX idx_mailbox ON email_metadata(mailbox)")

    conn.commit()

    print(f"\nMigration complete!")
    print(f"  Migrated: {migrated}")
    print(f"  Skipped (no internal_id): {skipped}")
    print(f"\nBackup table 'email_metadata_backup' preserved for safety.")
    print("Run 'DROP TABLE email_metadata_backup' after verification.")

    conn.close()


def backfill_internal_ids() -> dict:
    """批量获取 message_id → internal_id 映射"""
    # 使用 AppleScript 批量获取最近的邮件
    # 返回 {message_id: internal_id} 映射

    script = '''
    tell application "Mail"
        set resultList to {}
        repeat with acct in accounts
            repeat with mbox in mailboxes of acct
                try
                    set msgs to messages 1 thru 5000 of mbox
                    repeat with m in msgs
                        set msgId to message id of m
                        set internalId to id of m
                        set end of resultList to msgId & "{{SEP}}" & (internalId as string)
                    end repeat
                end try
            end repeat
        end repeat

        set AppleScript's text item delimiters to "{{REC}}"
        return resultList as string
    end tell
    '''

    try:
        result = subprocess.run(
            ['osascript', '-e', script],
            capture_output=True, text=True, timeout=600
        )

        if result.returncode != 0:
            print(f"Warning: AppleScript failed: {result.stderr}")
            return {}

        id_map = {}
        for record in result.stdout.strip().split("{{REC}}"):
            if "{{SEP}}" in record:
                parts = record.split("{{SEP}}")
                if len(parts) == 2:
                    id_map[parts[0]] = int(parts[1])

        print(f"  Retrieved {len(id_map)} message_id → internal_id mappings")
        return id_map

    except subprocess.TimeoutExpired:
        print("Warning: AppleScript timed out during backfill")
        return {}
    except Exception as e:
        print(f"Warning: Failed to backfill: {e}")
        return {}


if __name__ == "__main__":
    migrate()
```

### 4.4 NewWatcher 主循环重构

#### 关键设计点

1. **SQLite 检测到新邮件 → 立即写入 SyncStore**（用 internal_id 作为主键）
2. **AppleScript 成功后刷新元数据**（确保 SyncStore 与 Notion 一致）
3. **MIME 不缓存**，重试时用 internal_id 快速重新获取

#### 完整的主循环

```python
# src/mail/new_watcher.py

async def _poll_cycle(self):
    """单次轮询周期 - v3 架构"""

    # 1. SQLite 检测新邮件
    current_max = self.radar.get_current_max_row_id()
    last_max = self.sync_store.get_last_max_row_id()

    if current_max > last_max:
        # 2. SQLite 查询新邮件元数据
        new_emails = self.radar.get_new_emails(since_row_id=last_max)
        logger.info(f"Detected {len(new_emails)} new emails via SQLite")

        # 3. 写入 SyncStore 并同步
        for email_meta in new_emails:
            await self._sync_single_email_v3(email_meta)

        # 4. 更新 last_max_row_id
        self.sync_store.set_last_max_row_id(current_max)

    # 5. 处理待重试的邮件（每次轮询都检查）
    await self._process_retry_queue()

async def _sync_single_email_v3(self, email_meta: Dict[str, Any]):
    """同步单封邮件 - v3 架构"""
    internal_id = email_meta['internal_id']
    mailbox = email_meta['mailbox']

    # 1. 立即写入 SyncStore（状态 pending，用 SQLite 元数据）
    #    这样即使后续 AppleScript 失败，也有记录可追踪
    self.sync_store.save_email({
        'internal_id': internal_id,
        'mailbox': mailbox,
        'subject': email_meta.get('subject', ''),      # SQLite 提供
        'sender': email_meta.get('sender_email', ''),  # SQLite 提供
        'date_received': email_meta.get('date_received', ''),
        'is_read': email_meta.get('is_read', False),
        'is_flagged': email_meta.get('is_flagged', False),
        'sync_status': 'pending',
    })

    # 2. AppleScript 获取完整内容
    try:
        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
    except Exception as e:
        logger.error(f"AppleScript failed for id={internal_id}: {e}")
        self.sync_store.mark_fetch_failed(internal_id, str(e))
        return

    if not full_email:
        logger.error(f"AppleScript returned None for id={internal_id}")
        self.sync_store.mark_fetch_failed(internal_id, "AppleScript returned None")
        return

    message_id = full_email['message_id']

    # 3. 检查 message_id 是否已存在（去重）
    existing = self.sync_store.get_by_message_id(message_id)
    if existing and existing['internal_id'] != internal_id:
        if existing['sync_status'] == 'synced':
            # 已同步过（可能是邮件复制），删除当前记录
            self.sync_store.delete(internal_id)
            logger.warning(f"Duplicate email detected, skipping: {message_id[:50]}...")
            return
        else:
            # 之前的记录未成功，删除旧的
            self.sync_store.delete(existing['internal_id'])
            logger.info(f"Replacing old record with new internal_id: {internal_id}")

    # 4. 用 AppleScript 返回的数据刷新元数据（确保准确性）
    #    SQLite 的 subject/date 可能与 AppleScript 略有差异
    self.sync_store.update_after_fetch(internal_id, {
        'message_id': message_id,
        'subject': full_email.get('subject', ''),       # AppleScript 提供（更准确）
        'sender': full_email.get('sender', ''),         # AppleScript 提供
        'date_received': full_email.get('date', ''),    # AppleScript 提供
        'thread_id': full_email.get('thread_id'),
        'is_read': full_email.get('is_read', False),
        'is_flagged': full_email.get('is_flagged', False),
        'sync_status': 'fetched',  # AppleScript 成功
    })

    # 5. 解析 MIME 源码
    email_obj = self.email_reader.parse_email_source(
        source=full_email['source'],
        message_id=message_id,
        is_read=full_email.get('is_read', False),
        is_flagged=full_email.get('is_flagged', False)
    )

    if not email_obj:
        logger.error(f"Failed to parse email: {message_id[:50]}...")
        self.sync_store.mark_failed(internal_id, "Failed to parse MIME")
        return

    # 6. Notion 同步
    try:
        page_id = await self.notion_sync.create_email_page_v2(email_obj)

        if page_id:
            self.sync_store.mark_synced(internal_id, page_id)
            logger.info(f"Email synced: {message_id[:50]}... -> {page_id}")
        else:
            self.sync_store.mark_failed(internal_id, "Notion returned None")

    except Exception as e:
        logger.error(f"Notion sync failed for {message_id[:50]}...: {e}")
        self.sync_store.mark_failed(internal_id, str(e))
```

### 4.5 统一的重试机制

**核心思想**：所有操作都用 `internal_id`，AppleScript 失败和 Notion 失败统一处理。

#### SyncStore 方法更新

```python
# src/mail/sync_store.py

def mark_fetch_failed(self, internal_id: int, error: str) -> bool:
    """标记 AppleScript 获取失败"""
    return self._update_for_retry(internal_id, 'fetch_failed', error)

def mark_failed(self, internal_id: int, error: str) -> bool:
    """标记 Notion 同步失败"""
    return self._update_for_retry(internal_id, 'failed', error)

def _update_for_retry(self, internal_id: int, status: str, error: str, max_retries: int = 5) -> bool:
    """更新重试状态（统一逻辑）"""
    now = time.time()

    # 获取当前重试次数
    email = self.get(internal_id)
    current_retry = (email.get('retry_count', 0) if email else 0) + 1

    # 检查是否达到最大重试次数
    if current_retry >= max_retries:
        self._execute("""
            UPDATE email_metadata
            SET sync_status = 'dead_letter',
                sync_error = ?,
                retry_count = ?,
                next_retry_at = NULL,
                updated_at = ?
            WHERE internal_id = ?
        """, (f"Max retries exceeded: {error}", current_retry, now, internal_id))
        logger.warning(f"Marked as dead_letter: internal_id={internal_id}")
        return True

    # 计算下次重试时间（指数退避：1min, 5min, 15min, 1h, 2h）
    delays = [60, 300, 900, 3600, 7200]
    delay = delays[min(current_retry - 1, len(delays) - 1)]
    next_retry = now + delay

    self._execute("""
        UPDATE email_metadata
        SET sync_status = ?,
            sync_error = ?,
            retry_count = ?,
            next_retry_at = ?,
            updated_at = ?
        WHERE internal_id = ?
    """, (status, error, current_retry, next_retry, now, internal_id))

    logger.warning(f"Marked {status}: internal_id={internal_id}, retry #{current_retry} in {delay}s")
    return True

def get_ready_for_retry(self, limit: int = 3) -> List[Dict]:
    """获取可以重试的邮件（fetch_failed 或 failed）"""
    now = time.time()
    return self._query("""
        SELECT * FROM email_metadata
        WHERE sync_status IN ('fetch_failed', 'failed')
          AND next_retry_at IS NOT NULL
          AND next_retry_at <= ?
        ORDER BY next_retry_at ASC
        LIMIT ?
    """, (now, limit))

def mark_synced(self, internal_id: int, notion_page_id: str) -> bool:
    """标记同步成功"""
    now = time.time()
    self._execute("""
        UPDATE email_metadata
        SET sync_status = 'synced',
            notion_page_id = ?,
            sync_error = NULL,
            next_retry_at = NULL,
            updated_at = ?
        WHERE internal_id = ?
    """, (notion_page_id, now, internal_id))
    return True
```

#### 统一的重试处理

```python
async def _process_retry_queue(self):
    """统一的重试处理 - 用 internal_id"""

    ready_emails = self.sync_store.get_ready_for_retry(limit=3)

    if not ready_emails:
        return

    logger.info(f"Processing {len(ready_emails)} emails from retry queue...")

    for record in ready_emails:
        internal_id = record['internal_id']
        mailbox = record.get('mailbox', '收件箱')
        status = record['sync_status']

        logger.info(f"Retrying {status} email: internal_id={internal_id}")

        try:
            # 1. 用 internal_id 获取 MIME（统一，无论是 fetch_failed 还是 failed）
            full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)

            if not full_email:
                # 邮件在 Mail.app 中已删除
                logger.warning(f"Email not found in Mail.app, removing: internal_id={internal_id}")
                self.sync_store.delete(internal_id)
                continue

            message_id = full_email['message_id']

            # 2. 如果是 fetch_failed，需要检查 message_id 去重
            if status == 'fetch_failed':
                existing = self.sync_store.get_by_message_id(message_id)
                if existing and existing['internal_id'] != internal_id:
                    if existing['sync_status'] == 'synced':
                        self.sync_store.delete(internal_id)
                        logger.info(f"Duplicate found during retry, removed: internal_id={internal_id}")
                        continue

            # 3. 用 AppleScript 数据刷新元数据
            self.sync_store.update_after_fetch(internal_id, {
                'message_id': message_id,
                'subject': full_email.get('subject', ''),
                'sender': full_email.get('sender', ''),
                'date_received': full_email.get('date', ''),
                'thread_id': full_email.get('thread_id'),
            })

            # 4. 解析 MIME
            email_obj = self.email_reader.parse_email_source(
                source=full_email['source'],
                message_id=message_id,
                is_read=full_email.get('is_read', False),
                is_flagged=full_email.get('is_flagged', False)
            )

            if not email_obj:
                self.sync_store.mark_failed(internal_id, "Failed to parse MIME on retry")
                continue

            # 5. Notion 同步
            page_id = await self.notion_sync.create_email_page_v2(email_obj)

            if page_id:
                self.sync_store.mark_synced(internal_id, page_id)
                logger.info(f"Retry succeeded: internal_id={internal_id} -> {page_id}")
            else:
                self.sync_store.mark_failed(internal_id, "Notion returned None on retry")

        except Exception as e:
            logger.error(f"Retry failed for internal_id={internal_id}: {e}")
            # 根据当前状态决定标记哪种失败
            if status == 'fetch_failed':
                self.sync_store.mark_fetch_failed(internal_id, str(e))
            else:
                self.sync_store.mark_failed(internal_id, str(e))
```

#### 重试流程图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     统一重试机制 (internal_id)                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  email_metadata 表                                                          │
│  ┌──────────────┬────────────┬──────────────┬─────────────┬──────────────┐  │
│  │ internal_id  │ message_id │ sync_status  │ retry_count │ next_retry_at│  │
│  ├──────────────┼────────────┼──────────────┼─────────────┼──────────────┤  │
│  │ 41456        │ NULL       │ fetch_failed │ 2           │ 1706500000   │  │
│  │ 41457        │ <abc@...>  │ synced       │ 0           │ NULL         │  │
│  │ 41458        │ <def@...>  │ failed       │ 1           │ 1706499900   │  │
│  └──────────────┴────────────┴──────────────┴─────────────┴──────────────┘  │
│                                                                             │
│  查询待重试：                                                               │
│  SELECT * FROM email_metadata                                               │
│  WHERE sync_status IN ('fetch_failed', 'failed')                            │
│    AND next_retry_at <= now()                                               │
│                                                                             │
│  处理流程（统一）：                                                         │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │  1. fetch_email_content_by_id(internal_id, mailbox)                │    │
│  │     └─→ 统一用 internal_id，快速（~1s）                            │    │
│  │                                                                     │    │
│  │  2. 如果是 fetch_failed，检查 message_id 去重                      │    │
│  │                                                                     │    │
│  │  3. 用 AppleScript 数据刷新元数据                                  │    │
│  │                                                                     │    │
│  │  4. 解析 MIME → Notion 同步                                        │    │
│  │     ├─ 成功 → sync_status='synced'                                 │    │
│  │     └─ 失败 → retry_count++, 计算 next_retry_at                   │    │
│  │               └─ 超过最大次数 → sync_status='dead_letter'          │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. 迁移策略

### 5.1 数据库迁移（必需）

**迁移步骤**：
1. 备份原表
2. 批量获取 message_id → internal_id 映射（AppleScript）
3. 创建新表（internal_id 为主键）
4. 迁移数据（补全 internal_id）
5. 删除 sync_failures 表
6. 创建索引

**关键**：迁移时必须补全所有历史数据的 internal_id，因为新架构用 internal_id 作为主键。

迁移脚本见 4.3 节。

### 5.2 迁移注意事项

| 场景 | 处理 |
|------|------|
| 已同步且能找到 internal_id | 正常迁移 |
| 已同步但找不到 internal_id（老邮件已删除）| 用负数临时 ID 保留记录（仅用于线程关系查找）|
| pending/failed 且能找到 internal_id | 正常迁移，等待重试 |
| pending/failed 且找不到 internal_id | 跳过（无法重试）|

### 5.2 历史数据回填（可选）

**方案 A：不回填（推荐）**
- 新架构使用 `message_id` 去重，不依赖 `internal_id`
- 已同步的邮件（synced）不需要再获取内容
- Pending 邮件首次重试时会自动获取并保存 `internal_id`
- 优点：零停机，渐进迁移

**方案 B：批量回填**
- 使用 AppleScript 批量获取 `message_id → id` 映射
- 适用于需要频繁重试的场景

```python
# scripts/backfill_internal_ids.py

def backfill():
    """批量回填 internal_id（可选）"""
    sync_store = SyncStore()
    arm = AppleScriptArm(...)

    # 获取所有缺少 internal_id 的邮件
    emails = sync_store.get_emails_without_internal_id()

    # 分批处理
    for batch in chunks(emails, 100):
        # 使用 AppleScript 批量获取
        # fetch_emails_by_position 返回 message_id 和 id
        recent_emails = arm.fetch_emails_by_position(count=1000, mailbox="收件箱")

        # 建立映射
        id_map = {e['message_id']: e['id'] for e in recent_emails}

        # 更新 SyncStore
        for email in batch:
            if email['message_id'] in id_map:
                sync_store.update_internal_id(
                    email['message_id'],
                    id_map[email['message_id']]
                )
```

### 5.3 迁移对服务的影响

| 场景 | 影响 | 处理方式 |
|------|------|----------|
| 新邮件同步 | 无影响 | 自动使用新架构 |
| 已同步邮件 | 无影响 | 不需要再获取内容 |
| Pending 邮件 | 首次重试稍慢 | 自动获取并保存 internal_id |
| Failed 邮件重试 | 首次重试稍慢 | 自动获取并保存 internal_id |

---

## 6. 测试计划

### 6.1 单元测试

| 测试项 | 描述 |
|--------|------|
| `test_sqlite_get_new_emails` | SQLite 查询新邮件元数据 |
| `test_fetch_content_by_id` | AppleScript 通过 id 获取邮件 |
| `test_fetch_content_by_id_with_mailbox` | 指定邮箱的精准查询 |
| `test_id_mapping_accuracy` | ROWID = id 映射准确性（100 封抽样） |
| `test_fallback_to_message_id` | internal_id 为空时的回退 |
| `test_retry_with_internal_id` | 使用 internal_id 重试失败邮件 |

### 6.2 集成测试

| 测试项 | 描述 |
|--------|------|
| `test_full_sync_cycle_v3` | v3 架构完整同步流程 |
| `test_large_mailbox` | 大邮箱（6-7 万封）同步 |
| `test_migration` | 数据库迁移后功能正常 |
| `test_retry_mechanism` | 失败重试机制 |

### 6.3 性能测试

| 指标 | 目标 |
|------|------|
| SQLite 查询 100 封新邮件 | < 50ms |
| AppleScript 获取单封内容（by id） | < 3 秒 |
| 批量同步 100 封新邮件 | < 5 分钟 |

---

## 7. 实施步骤

### Phase 1: 迁移准备（预计 0.5 天）

1. [ ] 备份 SyncStore 数据库
2. [ ] 运行迁移脚本（补全 internal_id + 改主键）
3. [ ] 验证迁移结果

### Phase 2: 基础设施（预计 0.5 天）

4. [ ] SQLite Radar 新增 `get_new_emails()` 方法
5. [ ] AppleScript Arm 新增 `fetch_email_content_by_id()` 方法
6. [ ] SyncStore 重构（internal_id 为主键，新方法）

### Phase 3: 主循环重构（预计 1 天）

7. [ ] NewWatcher 重构 `_poll_cycle()` - SQLite 检测后立即写入 SyncStore
8. [ ] NewWatcher 重构 `_sync_single_email_v3()` - AppleScript 成功后刷新元数据
9. [ ] NewWatcher 重构 `_process_retry_queue()` - 统一用 internal_id

### Phase 4: 测试 & 发布（预计 0.5 天）

10. [ ] 本地测试（小邮箱）
11. [ ] 同事测试（大邮箱）
12. [ ] 监控重试队列，确保正常工作

---

## 8. 风险与缓解

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| internal_id 变化（邮件移动/删除） | 查找失败 | 低 | 回退到 message_id 查询 |
| SQLite 数据库锁定 | 查询超时 | 低 | 使用只读连接，超时重试 |
| 邮箱名称不匹配 | 定位失败 | 中 | 回退到遍历所有邮箱 |
| 迁移脚本失败 | 服务异常 | 低 | 备份数据库，支持回滚 |

---

## 9. 预期收益

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| 检测新邮件 | ~5ms | ~5ms | - |
| 获取新邮件列表 | ~2s (AppleScript) | **~10ms** (SQLite) | **200x** |
| 获取单封邮件内容 | ~100s | **~1-3s** | **30-100x** |
| 大邮箱支持 | ❌ 卡死 | ✅ 正常 | - |
| Mail.app 稳定性 | ❌ 卡死 | ✅ 正常 | - |

---

## 附录 A: 关键代码示例

### A.1 SQLite 查询新邮件

```sql
SELECT
    m.ROWID as internal_id,
    COALESCE(m.subject_prefix, '') || s.subject as subject,
    a.address as sender_email,
    a.comment as sender_name,
    datetime(m.date_received, 'unixepoch', 'localtime') as date_received,
    m.read as is_read,
    m.flagged as is_flagged,
    mb.url as mailbox_url
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
LEFT JOIN addresses a ON m.sender = a.ROWID
LEFT JOIN mailboxes mb ON m.mailbox = mb.ROWID
WHERE m.deleted = 0 AND m.ROWID > ?
ORDER BY m.ROWID ASC
```

### A.2 AppleScript 通过 id 获取邮件

```applescript
tell application "Mail"
    tell account "Exchange"
        tell mailbox "收件箱"
            set theMessage to first message whose id is 41457
            set msgMessageId to message id of theMessage
            set msgSource to source of theMessage
            -- ...
        end tell
    end tell
end tell
```

## 附录 B: 相关文件

- `src/mail/sqlite_radar.py` - SQLite 雷达
- `src/mail/applescript_arm.py` - AppleScript 机械臂
- `src/mail/applescript.py` - AppleScript 脚本封装
- `src/mail/reader.py` - 邮件读取器
- `src/mail/sync_store.py` - 同步状态存储
- `src/mail/new_watcher.py` - 新架构监听器
- `scripts/test_mail_reader.py` - 测试脚本
- `scripts/migrate_sync_store_v3.py` - 迁移脚本（待创建）
- `scripts/backfill_internal_ids.py` - 回填脚本（可选，待创建）
