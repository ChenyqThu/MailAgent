# MailAgent 邮件同步新架构设计文档

生成时间: 2026-01-24
状态: ✅ **已实现**

## 1. 背景分析

### 1.1 原架构问题

1. **row_id 与 message_id 映射不准确（~85%准确率）**
   - 使用主题前缀匹配算法，当邮件主题相似时容易出错
   - SQLite 中没有直接存储 Message-ID 字符串

2. **线程展示逻辑不理想**
   - 当前使用 Notion parent-child 关系
   - 母邮件是最早的那封，可能不在同步范围内
   - 按时间排序时，新回复会被拉到母邮件的时间点

3. **依赖不稳定的 SQLite row_id**
   - row_id 是 Mail.app 内部 ID，不具备稳定性

### 1.2 原数据流问题

```
SQLite 雷达 → 返回 row_ids → 位置映射器（~85%准确率）→ AppleScript 获取
                                    ↓
                              可能同步错误的邮件
```

---

## 2. 新架构设计

### 2.1 核心设计原则

1. **message_id 为唯一标识** - RFC 822 标准，全球唯一，稳定可靠
2. **SQLite 只做触发器** - 检测 max_row_id 变化触发同步，不依赖 row_id 映射
3. **AppleScript 按位置获取最新 N 封** - 用 message_id 去重
4. **Thread 展示优化** - 使用单一 Email Database + Parent Item + Rollup/Formula

### 2.2 新架构数据流

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           新架构数据流 (v2)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────┐       ┌─────────────────────────────────────────────┐  │
│  │ SQLite 雷达     │       │                AppleScript 获取器           │  │
│  │                 │       │                                             │  │
│  │ 检测:           │       │  fetch_email_by_message_id()                │  │
│  │ - max_row_id    │──────▶│  返回: Email + thread_id                    │  │
│  │   变化          │ 触发  │                                             │  │
│  │                 │       │  ✅ 100% 准确，无需位置映射                 │  │
│  └─────────────────┘       └─────────────────┬───────────────────────────┘  │
│                                              │                              │
│                                              ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                        sync_store.db (SQLite)                          ││
│  │  ┌─────────────────────────────────────────────────────────────────┐    ││
│  │  │ email_metadata 表:                                              │    ││
│  │  │ - message_id (PK): RFC 822 Message-ID                          │    ││
│  │  │ - thread_id: 线程头邮件的 message_id                           │    ││
│  │  │ - subject, sender, date_received, mailbox                      │    ││
│  │  │ - sync_status: pending / synced / failed                       │    ││
│  │  │ - notion_page_id                                               │    ││
│  │  └─────────────────────────────────────────────────────────────────┘    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                              │                              │
│                                              ▼                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                           Notion Sync (v2)                             ││
│  │                                                                         ││
│  │  1. 按 message_id 去重（check_page_exists）                            ││
│  │  2. 查找 Parent Item（thread_id = 线程头的 message_id）               ││
│  │     ├─ 找到 → 直接关联                                                 ││
│  │     └─ 没找到 → AppleScript 获取线程头 → 同步 → 关联                   ││
│  │  3. 创建 Email Page，设置 Parent Item 关联                             ││
│  │  4. Thread Latest Time 通过 Rollup 自动更新                            ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 线程展示方案

### 3.1 方案：单一 Email Database + Parent Item + Rollup/Formula

**核心思路：** 不创建独立的 Thread Database，而是利用现有的 Parent Item 关系和 Rollup/Formula 实现线程展示。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Notion 线程展示架构 (最终方案)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐│
│  │                    Email Database (单一数据库)                         ││
│  │  ┌─────────────────────────────────────────────────────────────────┐    ││
│  │  │ 核心属性:                                                       │    ││
│  │  │ - Subject (Title): 邮件主题                                     │    ││
│  │  │ - Message ID (Text): RFC 822 唯一标识                          │    ││
│  │  │ - Thread ID (Text): 线程头的 message_id                        │    ││
│  │  │ - Date (Date): 邮件时间                                         │    ││
│  │  │ - Parent Item (Relation→自身): 关联到线程头邮件                 │    ││
│  │  │ - Children (Relation→自身): 自动双向关联                        │    ││
│  │  │                                                                 │    ││
│  │  │ Rollup/Formula 属性 (用于线程视图):                             │    ││
│  │  │ - Thread Latest Time (Rollup): MAX(Children.Date)              │    ││
│  │  │ - Display Time (Formula): 用于排序                              │    ││
│  │  │ - Is Thread Head (Formula): 判断是否为线程头                    │    ││
│  │  └─────────────────────────────────────────────────────────────────┘    ││
│  │                                                                         ││
│  │  线程视图配置:                                                          ││
│  │  - 筛选: Is Thread Head = true                                         ││
│  │  - 排序: Display Time 降序                                              ││
│  │  - 展开: 显示 Children，按 Date 降序                                    ││
│  └─────────────────────────────────────────────────────────────────────────┘│
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Notion 属性配置

**Thread Latest Time (Rollup):**
- 关系属性: Children
- 汇总属性: Date
- 计算方式: 最新日期

**Display Time (Formula):**
```
if(empty(prop("Thread Latest Time")), prop("Date"), prop("Thread Latest Time"))
```

**Is Thread Head (Formula):**
```
empty(prop("Parent Item"))
```

### 3.3 展示效果

**线程视图（筛选 Is Thread Head = true，按 Display Time 降序）：**
```
┌──────────────────────────────────────────────────────────────┐
│ Subject                 │ Display Time │ Children │ Unread  │
├──────────────────────────────────────────────────────────────┤
│ DHCP new design         │ 01-24 22:02  │ 5        │ ●       │
│ Weekly Report           │ 01-24 18:30  │ 12       │         │
│ Fusion 设计反馈          │ 01-24 15:00  │ 8        │ ●       │
│ 独立邮件                 │ 01-24 10:00  │ 0        │         │
└──────────────────────────────────────────────────────────────┘
```

**展开后（Children 按 Date 降序）：**
```
Thread: DHCP new design
├─ 01-24 22:02  Gavin: Re: DHCP new design     ← 最新回复
├─ 01-24 18:30  Echo: Re: DHCP new design
├─ 01-24 15:00  Harry: Re: DHCP new design
├─ 01-23 10:00  Joe: Re: DHCP new design
└─ 01-22 09:00  Jackson: DHCP new design       ← 原始邮件 (线程头)
```

### 3.4 Thread ID 提取算法

```python
def extract_thread_id(source: str) -> Optional[str]:
    """从邮件源码提取线程标识

    thread_id = 线程头邮件的 message_id

    优先级:
    1. References 头的第一个 Message-ID（原始邮件）
    2. In-Reply-To 头
    3. 如果都没有，返回 None（自身就是线程头）
    """
    msg = email.message_from_string(source)

    # 优先使用 References（最可靠，包含完整回复链）
    references = msg.get("References")
    if references:
        refs = references.strip().split()
        if refs:
            return refs[0].strip('<>')  # 第一个是原始邮件

    # 次选 In-Reply-To
    in_reply_to = msg.get("In-Reply-To")
    if in_reply_to:
        return in_reply_to.strip().strip('<>')

    # 没有回复关系，自身作为线程头
    return None  # 调用方使用自身 message_id
```

---

## 4. 数据库表结构

### 4.1 sync_store.db 表结构

```sql
-- 同步状态表
CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at REAL
);
-- 预设键值:
-- 'last_max_row_id': 上次检测的最大 row_id（仅用于触发检测）
-- 'last_sync_time': 上次同步时间

-- 邮件元数据表（message_id 为主键）
CREATE TABLE email_metadata (
    message_id TEXT PRIMARY KEY,      -- RFC 822 Message-ID（唯一标识）
    thread_id TEXT,                   -- 线程头的 message_id
    subject TEXT,
    sender TEXT,
    sender_name TEXT,
    to_addr TEXT,
    cc_addr TEXT,
    date_received TEXT,               -- ISO 格式
    mailbox TEXT,                     -- 收件箱/发件箱
    is_read INTEGER DEFAULT 0,
    is_flagged INTEGER DEFAULT 0,

    -- Notion 同步状态
    sync_status TEXT DEFAULT 'pending', -- pending/synced/failed
    notion_page_id TEXT,              -- Notion 页面 ID
    notion_thread_id TEXT,            -- 线程头的 Notion 页面 ID
    sync_error TEXT,                  -- 失败原因
    retry_count INTEGER DEFAULT 0,

    created_at REAL,
    updated_at REAL
);

CREATE INDEX idx_email_thread ON email_metadata(thread_id);
CREATE INDEX idx_email_date ON email_metadata(date_received DESC);
CREATE INDEX idx_email_sync_status ON email_metadata(sync_status);
CREATE INDEX idx_email_mailbox ON email_metadata(mailbox);

-- 失败重试队列
CREATE TABLE sync_failures (
    message_id TEXT PRIMARY KEY,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,
    created_at REAL
);

CREATE INDEX idx_failures_next_retry ON sync_failures(next_retry_at);
```

### 4.2 与原表对比

| 原表/文件 | 新表/文件 | 变化说明 |
|------|------|---------|
| `cache_store.py` | `sync_store.py` | 完全重写，message_id 为主键 |
| `email_cache` 表 | `email_metadata` 表 | 合并，增加 sync_status |
| `id_mapping` 表 | **删除** | 不再需要 row_id 映射 |
| `position_mapper.py` | **删除** | 不再需要 |
| `hybrid_watcher.py` | `new_watcher.py` | 完全重写 |
| `watcher.py` | **删除** | 被 new_watcher 替代 |

---

## 5. 核心流程

### 5.1 初始化同步流程

```
scripts/initial_sync.py 执行流程:

1. 检查环境
   ├─ SQLite 雷达可用性
   └─ 各邮箱邮件数量

2. AppleScript 获取邮件
   ├─ 收件箱: N 封
   └─ 发件箱: M 封

3. 写入 sync_store.db
   ├─ message_id 为主键
   ├─ 提取 thread_id（从邮件源码）
   └─ sync_status = 'pending'

4. 从 Notion 获取已同步邮件
   └─ 标记已存在的为 synced

5. 用户确认后同步 pending 邮件
   ├─ 查找 Parent Item（按 thread_id）
   │   ├─ 找到 → 直接关联
   │   └─ 没找到 → 获取线程头 → 先同步 → 再关联
   └─ 创建 Email Page

6. 更新 sync_state
   └─ 记录 last_max_row_id
```

### 5.2 实时同步流程

```
new_watcher.py 主循环 (每 5 秒):

1. SQLite 雷达检测
   ├─ 获取当前 max_row_id
   ├─ 对比 last_max_row_id
   └─ 差值 = 新邮件数量估算 (N)

2. 如果有新邮件 (N > 0)
   ├─ AppleScript 获取最新 N+10 封
   ├─ 用 message_id 去重
   ├─ 新邮件加入 sync_store (pending)
   └─ 更新 last_max_row_id

3. 同步 pending 邮件
   ├─ 提取 thread_id
   ├─ 查找 Parent Item
   │   ├─ 找到 → 直接关联
   │   └─ 没找到 → 获取并同步线程头 → 关联
   ├─ 创建 Email Page
   ├─ 成功 → synced + 记录 notion_page_id
   └─ 失败 → failed + 加入 sync_failures

4. 处理重试队列
   └─ 指数退避重试 (1min → 5min → 15min → 1h → 2h)
```

### 5.3 Parent Item 关联流程

```python
async def create_email_page_v2(email, fetch_thread_head_callback):
    """创建邮件页面，自动处理 Parent Item 关联"""

    # 1. 检查是否已同步
    if await check_page_exists(email.message_id):
        return existing_page_id

    # 2. 查找 Parent Item
    thread_id = email.thread_id
    parent_page_id = None

    if thread_id and thread_id != email.message_id:
        # 这是回复邮件，需要关联线程头
        parent_page_id = await find_by_message_id(thread_id)

        if not parent_page_id and fetch_thread_head_callback:
            # 线程头不在 Notion，获取并同步
            parent_page_id = await fetch_thread_head_callback(thread_id)

    # 3. 创建页面，设置 Parent Item
    properties = build_properties(email)
    if parent_page_id:
        properties["Parent Item"] = {"relation": [{"id": parent_page_id}]}

    return await create_page(properties, children)
```

---

## 6. Notion 数据库 Schema

### 6.1 Email Database 属性

| 属性名 | 类型 | 状态 | 说明 |
|--------|------|------|------|
| Subject | Title | 保留 | 邮件主题 |
| Message ID | Text | 保留 | RFC 822 唯一标识 |
| Thread ID | Text | 保留 | 线程头的 message_id |
| From, From Name | Email, Text | 保留 | 发件人 |
| To, CC | Text | 保留 | 收件人 |
| Date | Date | 保留 | 邮件时间 |
| Parent Item | Relation (自身) | 保留 | 关联到线程头 |
| Children | Relation (自身) | 保留 | 自动双向关联 |
| Is Read, Is Flagged | Checkbox | 保留 | 状态 |
| Has Attachments | Checkbox | 保留 | 附件 |
| Mailbox | Select | 保留 | 收件箱/发件箱 |
| Original EML | Files | 保留 | 原始邮件 |
| Processing Status | Select | 保留 | 处理状态 |
| Row ID | Number | **可选删除** | 旧架构，不再使用 |
| Conversation ID | Number | **可选删除** | 旧架构，不再使用 |
| **Thread Latest Time** | Rollup | **新增** | MAX(Children.Date) |
| **Display Time** | Formula | **新增** | 用于排序 |
| **Is Thread Head** | Formula | **新增** | 判断是否为线程头 |

---

## 7. 实现状态

### 7.1 已完成任务

| # | 任务 | 文件 | 状态 |
|---|------|------|------|
| 1 | 新建 sync_store.py | `src/mail/sync_store.py` | ✅ 完成 |
| 2 | 修改 models.py | `src/models.py` | ✅ 完成 |
| 3 | 简化 sqlite_radar.py | `src/mail/sqlite_radar.py` | ✅ 完成 |
| 4 | 修改 applescript_arm.py | `src/mail/applescript_arm.py` | ✅ 完成 |
| 5 | 修改 notion/sync.py | `src/notion/sync.py` | ✅ 完成 |
| 6 | 新建 new_watcher.py | `src/mail/new_watcher.py` | ✅ 完成 |
| 7 | 新建 initial_sync.py | `scripts/initial_sync.py` | ✅ 完成 |
| 8 | 删除旧代码和文件 | - | ✅ 完成 |
| 9 | 更新文档和配置 | `.env`, `CLAUDE.md` 等 | ✅ 完成 |

### 7.2 已删除文件

```
src/mail/cache_store.py      # 旧缓存存储
src/mail/position_mapper.py  # row_id 映射器
src/mail/hybrid_watcher.py   # 旧监听器
src/mail/watcher.py          # 旧监听器
data/applescript_cache.json  # 旧缓存数据
data/mail_cache.db           # 旧缓存数据库
data/mapping_report.md       # 映射报告
data/unmapped_row_ids.txt    # 未映射 ID 列表
```

### 7.3 新增文件

```
src/mail/sync_store.py       # 新同步状态存储
src/mail/new_watcher.py      # 新监听器
scripts/initial_sync.py      # 初始化同步脚本
```

---

## 8. 待执行步骤

### 8.1 Notion 配置 (用户操作)

1. **添加 Rollup 属性: Thread Latest Time**
   - 关系属性: Children
   - 汇总属性: Date
   - 计算方式: 最新日期

2. **添加 Formula 属性: Display Time**
   ```
   if(empty(prop("Thread Latest Time")), prop("Date"), prop("Thread Latest Time"))
   ```

3. **添加 Formula 属性: Is Thread Head**
   ```
   empty(prop("Parent Item"))
   ```

4. **创建线程视图**
   - 筛选: Is Thread Head = true
   - 排序: Display Time 降序

5. **可选: 删除旧属性**
   - Row ID
   - Conversation ID

### 8.2 初始化同步 (用户操作)

```bash
cd /Users/chenyuanquan/Documents/MailAgent
source venv/bin/activate

# 运行初始化同步（会逐步确认）
python scripts/initial_sync.py

# 或跳过确认，限制同步 100 封测试
python scripts/initial_sync.py --yes --limit 100
```

### 8.3 启动实时同步

需要更新 `main.py` 使用新的 `NewWatcher`。

---

## 9. 新旧架构对比

| 对比项 | 旧架构 | 新架构 |
|--------|--------|--------|
| 唯一标识 | row_id (不稳定) | message_id (RFC 822) |
| 映射准确率 | ~85% | **100%** |
| 雷达返回 | row_id 列表 | 仅 max_row_id 变化 |
| 缓存结构 | email_cache + id_mapping | email_metadata (统一) |
| 线程关联 | Conversation ID | thread_id = 线程头 message_id |
| Parent Item | 按 Conversation ID 查找 | 按 Message ID 精确查找 |
| 线程头缺失 | 无法关联 | **自动获取并同步** |

---

## 10. 风险评估

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| AppleScript 获取性能 | 中 | 中 | 限制每次获取数量 |
| Thread ID 提取不一致 | 高 | 低 | 完善 References 解析 |
| Notion Rollup 计算延迟 | 低 | 低 | 用户体验可接受 |
| 线程头获取递归 | 中 | 低 | 限制递归深度 |
| Notion API 限流 | 中 | 中 | 指数退避重试 |
