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
│  6. 失败重试机制                                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │ - AppleScript 失败：重试 3 次，指数退避                              │   │
│  │ - Notion 同步失败：加入 sync_failures 队列                           │   │
│  │ - 使用 internal_id 重试（快速）                                      │   │
│  │ - 超过最大重试次数 → dead_letter 状态                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 与当前架构的对比

| 步骤 | 当前架构 (v2) | 优化架构 (v3) |
|------|---------------|---------------|
| 检测新邮件 | SQLite max_row_id | SQLite max_row_id |
| 获取新邮件列表 | AppleScript 批量 (N+buffer) | **SQLite 查询** |
| 计算新邮件数 | 估算 + buffer | **精确** |
| 获取完整内容 | `whose message id is` (慢) | **`whose id is`** (快) |
| 邮箱定位 | 需遍历搜索 | **SQLite 提供，精准定位** |
| 单封邮件获取 | ~100 秒 | **~1 秒** |

### 3.3 需要修改的模块

| 模块 | 文件 | 修改内容 |
|------|------|----------|
| **SQLite Radar** | `src/mail/sqlite_radar.py` | 新增 `get_new_emails()` 方法，返回新邮件元数据（含 ROWID 和 mailbox） |
| **AppleScript Arm** | `src/mail/applescript_arm.py` | 1. `fetch_emails_by_position()` 额外返回 `id`<br>2. 新增 `fetch_email_content_by_id(id, mailbox)` 方法 |
| **MailAppScripts** | `src/mail/applescript.py` | 1. `get_email_details()` 支持 `internal_id` 参数<br>2. `get_email_source()` 支持 `internal_id` 参数<br>3. `save_attachments()` 支持 `internal_id` 参数 |
| **SyncStore** | `src/mail/sync_store.py` | 1. `email_metadata` 表新增 `internal_id` 字段<br>2. 新增 `get_internal_id(message_id)` 方法 |
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

#### Schema 变更

```sql
-- 新增 internal_id 字段
ALTER TABLE email_metadata ADD COLUMN internal_id INTEGER;

-- 创建索引
CREATE INDEX idx_email_internal_id ON email_metadata(internal_id);
```

#### 兼容性

- `internal_id` 允许为 NULL（兼容历史数据）
- 新邮件自动填充 `internal_id`
- 旧邮件首次访问时可选择性更新

### 4.4 NewWatcher 主循环重构

```python
# src/mail/new_watcher.py

async def _poll_cycle(self):
    """单次轮询周期 - v3 架构"""

    # 1. 检测新邮件
    current_max = self.radar.get_current_max_row_id()
    last_max = self.sync_store.get_last_max_row_id()

    if current_max <= last_max:
        return  # 无新邮件

    # 2. SQLite 查询新邮件元数据
    new_emails = self.radar.get_new_emails(since_row_id=last_max)
    logger.info(f"Detected {len(new_emails)} new emails via SQLite")

    # 3. 同步每封新邮件
    for email_meta in new_emails:
        await self._sync_single_email_v3(email_meta)

    # 4. 更新 last_max_row_id
    self.sync_store.set_last_max_row_id(current_max)

async def _sync_single_email_v3(self, email_meta: Dict[str, Any]):
    """同步单封邮件 - v3 架构"""
    internal_id = email_meta['internal_id']
    mailbox = email_meta['mailbox']

    try:
        # 1. 通过 internal_id 获取完整内容（含 message_id）
        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
        if not full_email:
            logger.error(f"Failed to fetch email by id={internal_id}")
            return

        message_id = full_email['message_id']

        # 2. 检查是否已同步（用 message_id 去重）
        if self.sync_store.email_exists(message_id):
            logger.debug(f"Email already synced: {message_id[:50]}...")
            return

        # 3. 解析邮件源码
        email_obj = self.email_reader.parse_email_source(
            source=full_email['source'],
            message_id=message_id,
            is_read=full_email['is_read'],
            is_flagged=full_email['is_flagged']
        )

        # 4. 保存到 SyncStore (pending)
        self.sync_store.save_email({
            'message_id': message_id,
            'internal_id': internal_id,  # 新增
            'subject': full_email['subject'],
            'sender': full_email['sender'],
            'mailbox': mailbox,
            'sync_status': 'pending',
            # ...
        })

        # 5. 同步到 Notion
        page_id = await self.notion_sync.create_email_page_v2(email_obj)

        # 6. 更新状态
        if page_id:
            self.sync_store.mark_synced(message_id, page_id)
        else:
            self.sync_store.mark_failed(message_id, "Notion sync failed")

    except Exception as e:
        logger.error(f"Failed to sync email id={internal_id}: {e}")
        # 加入重试队列（见 4.5）
```

### 4.5 失败重试机制

```python
async def _retry_failed_emails(self):
    """重试失败的邮件 - v3 架构"""

    ready_emails = self.sync_store.get_ready_for_retry(limit=3)

    for email_meta in ready_emails:
        message_id = email_meta['message_id']
        internal_id = email_meta.get('internal_id')  # 可能为 None（历史数据）
        mailbox = email_meta.get('mailbox', '收件箱')

        try:
            # 优先使用 internal_id（快），回退到 message_id（慢）
            if internal_id:
                full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
            else:
                # 历史数据回退：使用慢方法，但同时获取并保存 internal_id
                full_email = self.arm.fetch_email_by_message_id(message_id, mailbox)
                if full_email and 'id' in full_email:
                    # 更新 internal_id 以便下次快速访问
                    self.sync_store.update_internal_id(message_id, full_email['id'])

            if not full_email:
                logger.warning(f"Email not found, removing: {message_id[:50]}...")
                self.sync_store.delete_email(message_id)
                continue

            # 重新同步...

        except Exception as e:
            self.sync_store.mark_failed(message_id, str(e))
```

---

## 5. 迁移策略

### 5.1 数据库迁移（必需）

运行一次性迁移脚本添加 `internal_id` 字段：

```python
# scripts/migrate_add_internal_id.py

def migrate():
    """添加 internal_id 字段到 SyncStore"""
    conn = sqlite3.connect('data/sync_store.db')
    cursor = conn.cursor()

    # 检查字段是否已存在
    cursor.execute("PRAGMA table_info(email_metadata)")
    columns = [col[1] for col in cursor.fetchall()]

    if 'internal_id' not in columns:
        cursor.execute("ALTER TABLE email_metadata ADD COLUMN internal_id INTEGER")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_email_internal_id ON email_metadata(internal_id)")
        conn.commit()
        print("Migration complete: added internal_id column")
    else:
        print("Column internal_id already exists")

    conn.close()
```

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

### Phase 1: 基础设施（预计 0.5 天）

1. [ ] 运行数据库迁移脚本（添加 internal_id 字段）
2. [ ] SQLite Radar 新增 `get_new_emails()` 方法
3. [ ] AppleScript Arm 新增 `fetch_email_content_by_id()` 方法

### Phase 2: 核心逻辑（预计 1 天）

4. [ ] MailAppScripts 修改支持 `internal_id` 参数
5. [ ] SyncStore 新增 `update_internal_id()` 方法
6. [ ] EmailReader 修改优先使用 `internal_id`

### Phase 3: 主循环重构（预计 1 天）

7. [ ] NewWatcher 重构 `_poll_cycle()` 使用 v3 架构
8. [ ] NewWatcher 重构 `_sync_single_email_v3()`
9. [ ] NewWatcher 更新 `_retry_failed_emails()` 支持 internal_id

### Phase 4: 测试 & 发布（预计 0.5 天）

10. [ ] 本地测试（小邮箱）
11. [ ] 同事测试（大邮箱）
12. [ ] 可选：运行批量回填脚本

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
- `scripts/migrate_add_internal_id.py` - 迁移脚本（待创建）
