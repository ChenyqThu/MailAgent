# 架构内核详解（从 CLAUDE.md 下沉）

> 本文件是 CLAUDE.md「架构」+「Sprint 16 Dual-Backend」两节的完整下沉版。
> CLAUDE.md 只保留模块地图 + 一句话状态，深度流程/代码示例/DDL 在此。
> 改动正向 sync / 反向 sync / Processing Status / webhook / 线程关系 / 重试逻辑前先读这里。

## v3 SQLite-First 架构（2026-01）

- 使用 `internal_id`（SQLite ROWID = AppleScript id）作为主键
- AppleScript 查询性能提升 **127 倍**（~1s vs ~100s），支持大邮箱（6-7 万封）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        v3 架构 (SQLite 优先)                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. SQLite Radar 检测 (~5ms)                                               │
│     检测 max_row_id 变化 → 直接获取新邮件元数据（含 internal_id）            │
│                              ▼                                              │
│  2. 写入 SyncStore (internal_id 主键, message_id=NULL)                     │
│                              ▼                                              │
│  3. AppleScript 获取完整内容 (~1s/封，使用 `whose id is <int>`)            │
│     fetch_email_content_by_id(internal_id, mailbox)                        │
│     → 返回 message_id, source, thread_id 等 → 更新 SyncStore               │
│                              ▼                                              │
│  4. 同步到 Notion                                                          │
│     - 解析 MIME 源码（HTML、附件、内联图片）                               │
│     - 检测会议邀请 (.ics) → 创建日程                                       │
│     - 创建 Notion 邮件页面（含线程关系）→ 标记 sync_status='synced'        │
│                                                                             │
│  5. 失败重试（统一在 email_metadata 表）                                   │
│     - fetch_failed: AppleScript 失败 → 用 internal_id 重试                 │
│     - failed: Notion 失败 → 用 internal_id 重新获取并同步                  │
│     - 指数退避: 1min, 5min, 15min, 1h, 2h → 超过最大重试 → dead_letter     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 性能对比

| 查询方式 | 耗时 | 说明 |
|---------|------|------|
| `whose message id is "<字符串>"` | ~100 秒 | 旧方式，线性搜索 |
| `whose id is <整数>` | ~1 秒 | **v3 方式，提升 127 倍** |

## 关键流程

### 1. 新邮件检测与同步（v3 架构）

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

### 2. 线程关系处理

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

### 3. 重试机制（统一处理）

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
pending → fetch_failed → (重试) → synced
       └───────────────────────→ failed → (重试) → synced
       └───────────────────────→ dead_letter (超过重试次数)
       └───────────────────────→ skipped (发件箱降级 / 日期过滤)
```

**死信降级例外（避免无意义告警）：**
- 发件箱 `fetch_failed` 用尽重试 → 降级为 `skipped`（`sync_error="Skipped (sent box unreachable): ..."`），不进死信。原因：发件箱里 row_id 在 SQLite radar 检测到之后被 Mail.app 重排/清理，AppleScript `whose id = N` 找不到；发件箱漏一封不致命，硬重试只刷告警。逻辑在 `sync_store._update_for_retry`。
- HTML 转 Notion blocks 时 `link.url` 必须是 ASCII + 协议白名单（http/https/mailto/tel）+ 不含空白；非法 URL 被 `html_converter._sanitize_link_url` 退化成纯文本，避免 Notion API 抛 `Invalid URL for link` 把整封邮件卡进死信。

## 状态型告警的 episode 语义（2026-07，`MAILAGENT_ALERT_EPISODE` 默认开）

**问题**：**状态型告警** = 判据成立后不会自行消失的告警。以死信为例，`dead_count >= threshold` 在人工清理前**恒为真** → `_check_and_alert`（60s 一轮）每轮都调 `alert_dead_letters()`，仅靠 `FeishuAlertNotifier._cooldown_map`（**纯内存**，`ALERT_COOLDOWN` 默认 300s）限流 → 每 5 分钟一条刷到人工干预为止；且冷却是内存态，**进程重启即清空** → 重启后立刻复发。

**方案**：`src/notify/episode.py` 的 `AlertEpisodeTracker` 把 davmail watchdog 已验证的「**调用方持有状态 + 落盘 sync_state**」范式（`_announced_*` + `_write_state`）下沉成通用能力。`Alerter` 的**投递/冷却语义一行不改**（`send_alert` / `_check_cooldown` / `_cooldown_map` 原样，300s 冷却继续作兜底防抖）；alert.py 的改动仅限：三个 recovery 通知的 level（info→warning，见下）+ 给本机制用到的 7 个 `alert_*` 方法补 `return`（纯增量，原返回 `None` 且无人读）。

**🔴 两阶段提交（evaluate → 投递 → commit）**：`evaluate()` **只判定不落盘**，调用方必须在告警**真的投递成功后**（`alert_*` 返回 `True`）才调 `commit()`。因为 `send_alert()` 会在三种情况下静默返回 `False` —— level 门 / 300s cooldown 门 / 网络失败 —— 若判定时就落盘，这条告警就被永久标成「已告警」，value 恒定则之后永远 SILENT，**首告从未送达 = 永久漏告警**。投递失败 → 不 commit → 下轮重新判定重发。

`evaluate(key, value, threshold)` 的四分支（`evaluate_flag(key, bad)` = 布尔态糖，退化为纯 edge-triggered，**对外只暴露 ENTER/SILENT/RECOVER** —— ESCALATE 归一成 ENTER，否则状态残缺时只认 ENTER 的调用方会不告警却写好基准 → 永久静默）：

| 判定 | 条件 | 动作 |
|---|---|---|
| `enter` | 首次 `value >= threshold` 且未 active | 发告警，记 `last_alerted_value=value` |
| `silent` | active 且 `value < last_alerted_value * 2` | **不发**（修掉刷屏的关键分支） |
| `escalate` | active 且 `value >= last_alerted_value * 2` | 再发一次，基准抬到 `value` |
| `recover` | active 且 `value < threshold` | 发恢复通知（`alert_recovery`），复位 |

- **调用方每轮都要调 `evaluate`**（即使判据不成立），否则 episode 永不复位、下次恶化判据失效。
- 失败一律 **fail-open**（读写 sync_state 出错 / 状态损坏 / 多键部分写入 → 倾向发告警）：误判 silent = 漏告警，比刷屏危险。唯一例外是非有限观测值（`NaN`/`inf` → 一律 SILENT 保持 active 原样，因为 `nan >= threshold` 恒 `False` 会把活动 episode 误判成 RECOVER = 假恢复）。
- 状态落 `sync_state` 表，键 `alert.<key>.{active,last_alerted_value,entered_at}`（镜像 `davmail.*` 键先例 → **非 schema 变更，不 bump `DB_VERSION`**）→ 跨进程（serve / serve-api）共享 + 跨重启存活。多键**部分写入是安全的**：所有残缺组合下一轮都 fail-open 落到「发告警」并在下次 commit 时自愈 —— 故未引入单事务/单 JSON 值（那会牺牲逐字段可观测性，而这正是 `davmail.*` 键先例的价值）。

**接入面**：`service.py:_check_and_alert` 的 `dead_letters` / `service_unhealthy` / `radar_unavailable` / `outbox_backlog`，+ `davmail_watchdog._evaluate_alerts` 的 token 门槛告警（tracker 由 service.py 注入，未注入 = disabled = 老行为）。灵动岛 `dispatch_dead_letter_accum` 与告警**同源同生命周期**（在同一个「投递成功 → commit」分支内），不独立刷屏。

**davmail token 是「一个 episode + 一个 severity marker」，不是两个平级 episode**：
- `alert.davmail_token.*`（门槛 80d）= episode 本体，负责「告知一次」与「恢复一次」的生命周期。
- `alert.davmail_token_critical.*`（门槛 87d）= 严重度升级标记，只决定消息用 critical 还是 warning 措辞。

两个平级 episode 会打架：age 首次 89 时两边都 active，之后 age 降到 82（**仍在 warning 区间**）→ critical episode 判 RECOVER → **误报「token 已恢复」**。现在 82 只让 severity marker 复位（不发消息 —— 情况变好且 episode 本体仍 active，用户早已知情），恢复通知**只在 age < 80 时**发。critical 消息同时充当 episode 本体的告知（投递成功时一并 commit 本体），否则本体永远 inactive → 将来 age 归零发不出恢复通知。

**不接**（行为字节级不变）：
- 非状态型告警 `sync_error:{id}` / `notion_error:{op}` / `worker_crashed:{name}` / `davmail_fetch_burst` / `service_started` 等；`consecutive_errors` 为半状态型（成功即归零），保持每轮告。
- **`restart_frequency` 有意不接** —— 它已自带持久去重（E4 `f4612a47`，`sync_state['service.restart_freq_last_alert']`，24h 内最多一条），不属 episode 化要修的刷屏病根；迁移只会让 flag-off 退回 300s 内存冷却 = 比现状更吵，违反「flag-off 字节级回退」纪律。

> `outbox_backlog` 的判据历来是 `> 阈值`（不是 `>=`）→ 调 `evaluate` 时门槛传 `阈值 + 1`，触发边界逐字不变（告警文案里的阈值仍是配置原值）。

**🔴 恢复通知的 level 地板**：`alert_levels` 默认 `critical,error,warning` **不含 info** → info 级通知会被 `send_alert` 的 level 门直接挡掉。故 `alert_recovery` / `alert_davmail_process_recovered` / `alert_davmail_login_recovered` 一律 **warning**（2026-07-14 前是 info → 恢复通知从未发出过，实测 davmail 恢复两次零通知）。新增恢复类通知必须与其对应告警同级（≥ warning），回归闸在 `tests/notify/test_alert_worker_methods.py`（用**生产默认** `enabled_levels` 构造，勿在闸里显式打开 info）。`alert_service_started` 不是恢复通知，保持 info。

## Processing Status 生命周期（双向同步）

```
未处理 ──(AI 审核)──→ AI Reviewed ──(反向同步)──→ 已同步 ──(用户处理)──→ 已完成
```

| 状态 | 含义 | 触发方 | 动作 |
|------|------|--------|------|
| `未处理` | 新邮件等待 AI 审核 | 系统自动 | 无 |
| `AI Reviewed` | AI 已设置 Action Type + Priority | AI Automation | 触发反向同步 |
| `已同步` | 已同步到 Mail.app | 反向同步成功后自动 | 不再处理 |
| `已完成` | 用户已处理（如已回复） | 用户手动 / Mail.app 取消旗标 | 移除旗标 |

**反向同步 Action Type 映射（Sprint 15 后 outbox 路径）：**

| Action Type | 默认 payload（`mark_read_after_processing=true`） | 开关关闭时 | 飞书通知 |
|------------|---------------------------------|---------|---------|
| 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 | `{is_read: true, is_flagged: true}` | `{is_flagged: true}`，保留当前 `is_read` | 紧急/重要时推送卡片（含「✨ 优化回复」「📝 创建草稿」按钮 → Openclaw） |
| 仅供参考/已完结 | `{is_read: true}` (is_flagged 不动) | mailapp payload 为空，保留当前 `is_read/is_flagged` | 否 |

`mark_read_after_processing` 是 `report_agent(id='email_preprocess_agent')` 的行级配置（DB v32，`NULL` 也按 true）；仅约束 AI 预处理完成后的两条反向链路，不影响前端/CLI 主动标已读或 `is_read=false` 写面。

**双向完成闭环：**
- Mail.app 取消旗标 → 正向同步 → Notion `Is Flagged=False` + `Processing Status=已完成`
- Notion 标记 `已完成` → webhook `?event=completed` → outbox(target=mailapp) → fanout 移除 Mail.app 旗标

## Webhook 事件类型（Sprint 15 outbox 路径）

| 事件 | 触发条件 | 处理动作 |
|------|---------|---------|
| `flag_changed` | Is Read / Is Flagged 变化 | handler 写 SQLite + outbox(target=mailapp, source=notion_webhook) → fanout 同步到 Mail.app |
| `ai_reviewed` | Processing Status → AI Reviewed | handler 写 SQLite + outbox(target=mailapp, source=ai_reviewed_handler) + outbox(target=notion, processing_status=已同步) + 飞书通知 |
| `completed` | Processing Status → 已完成 | handler 写 SQLite + outbox(target=mailapp, payload={is_flagged:False, is_read:True}) → fanout 移除 Mail.app 旗标 |
| `create_draft` | Notion 按钮触发 | AppleScript 直调创建草稿（不走 outbox，独立交互） |
| `query_mail` | 外部系统查询 | 搜索邮件元数据（支持 `source=syncstore` 已同步 或 `source=mail` 全量 ~24k） |
| `fetch_mail_content` | 外部系统查询 | 通过 internal_id 获取邮件完整正文（SQLite SSoT 优先，miss fallback AppleScript） |
| `page_updated` | 通用事件 | 自动路由到上述处理器 |

**反向同步两条路径并存**（Sprint 15 后两条都走 outbox，架构纯净）：

| 路径 | 触发 | source 标识 | 说明 |
|---|---|---|---|
| A: webhook | Notion automation 实时 push | `notion_webhook` | 用户在 Notion 端改 property 立即触发 |
| B: 轮询 30s | `NotionToMailSync.check_and_sync` | `reverse_sync_poll` | webhook 漏掉的兜底（webhook-server 挂 / 网络断 / automation 没触发） |

**Echo prevention**：`OutboxRepository.enqueue` 强制 `source='notion_webhook' + target='notion'` silent skip，防止 Notion → handler → outbox → fanout → Notion automation → 死循环。path B 用 source='reverse_sync_poll' 跟前者隔离，admin queue-depth + SSE 可以按 source 分流统计。

## 内联图片处理

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

## SyncStore 数据结构（v3 架构）

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
    sync_status TEXT DEFAULT 'pending',   -- pending/fetch_failed/synced/failed/skipped/dead_letter
    notion_page_id TEXT,
    notion_thread_id TEXT,
    sync_error TEXT,
    retry_count INTEGER DEFAULT 0,
    next_retry_at REAL,                   -- 指数退避重试时间
    created_at REAL,
    updated_at REAL
);

CREATE UNIQUE INDEX idx_message_id ON email_metadata(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX idx_sync_status ON email_metadata(sync_status);
CREATE INDEX idx_next_retry ON email_metadata(next_retry_at) WHERE sync_status IN ('fetch_failed', 'failed');

CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT
);  -- last_max_row_id, last_sync_time

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

---

## Sprint 15 — SQLite SSoT inversion（2026-05 灰度上线）

所有 mutating 操作（flag / processing_status 变化）反转方向，SQLite 是写入 intent 聚合点，FanoutWorker 异步派发到 Mail.app + Notion。

```
            ┌──────────────────────────────────────────┐
            │  SQLite (SSoT) — sync_store.db v10       │
            │  email_metadata + email_outbox + ...     │
            └──┬───────────────────────────────────────┘
   ┌───────────┼──────────────────────────────┬──────────────┐
   ▼           ▼                              ▼              ▼
┌────────┐  ┌──────────────┐         ┌──────────────┐  ┌─────────┐
│Mail.app│  │ 前端/CLI     │         │FanoutWorker  │  │  Notion │
│(本机)  │  │ writers      │         │(mail-sync 内)│  │  Cloud  │
└───┬────┘  │ - email flag │         │ poll 5s,     │  └────┬────┘
    │       │ - BatchAction│         │ async dispatch│      │
    │ ①正向 │ └──────┬──────┘        │ - AppleScript│       │
    │  sync  │  ②写 SQLite intent +   │ - Notion API │       │
    │ Radar  │   outbox.enqueue       └──────┬───────┘       │
    │ →Notion│   双 target (mailapp+notion)  │ ③消费 outbox  │
    └────────┴────────────────────────────────┴──────────────┘
                   ↑ ④反向 — Notion → SQLite + Mail.app（两条路径都走 outbox）
              ┌────┴──────────────────┐
              │ 路径 A: webhook (实时) │  handle_flag_changed → write SQLite
              │                        │  → outbox(mailapp, source=notion_webhook)
              │ 路径 B: 轮询 30s        │  NotionToMailSync → write SQLite
              │                        │  → outbox(mailapp, source=reverse_sync_poll)
              └────────────────────────┘
```

**核心特性**：
- DB v10 新表 `email_outbox`（13 列, CHECK target/status, FK CASCADE）
- `OutboxRepository.enqueue` echo prevention: source='notion_webhook' + target='notion' silent skip 防回环
- `FanoutWorker` asyncio loop 消费, AppleScript / Notion API 本身幂等所以 fanout 不做 SQLite-based idempotency short-circuit
- ~~灰度开关 `MAILAGENT_OUTBOX_ENABLED`~~ **已退役**（E2 灰度收口 2026-07-03）：FanoutWorker 恒启动、`outbox_repo` 在 handlers/reverse_sync 必传（None → TypeError），老 AppleScript 直调分支已删除；三处 flag→outbox 入队（handlers / reverse_sync / mail_write.set_flags）归一到 `src/sync/outbox_intents.py` 共享层（`enqueue_flag_sync` / `mirror_and_enqueue_flag_sync`，target/payload 语义差异由参数承载）
- 详见 `docs/sprint15-backend-complete.md` + `frontend/SPRINT15-HANDOFF.md` §3

---

## Sprint 16 — Dual-Backend (DavMail + AppleScript)（2026-05-22 cutover 上线）

把单一 "Mail.app + AppleScript" 后端重构成可切换的双 backend，**davmail 模式为当前主路径**，AppleScript 保留作 emergency fallback。解决 AppleScript GUI 注入富文本痛点 + 跨平台部署铺路 + EWS 2026-10 关停应对。

```
┌──────────────────────────────────────────────────────────┐
│  Application Layer (new_watcher / FanoutWorker / handler)│
│        depends on  →  IMailBackend Protocol              │
└──────────────────────────────────────────────────────────┘
                  ┌───────┴────────┐
          ┌───────┴────────┐ ┌─────┴──────────────┐
          │ DavMailBackend │ │ AppleScriptBackend │
          │ (PRIMARY)      │ │ (FALLBACK)         │
          │ - SMTP (1025)  │ │ - applescript_arm  │
          │ - IMAP (1143)  │ │ - sqlite_radar     │
          │ - CalDAV(1080) │ │                    │
          └───────┬────────┘ └─────────┬──────────┘
          ┌───────┴────────┐ ┌─────────┴──────────┐
          │ DavMail JVM    │ │ macOS Mail.app +   │
          │ (PM2 managed)  │ │ Envelope Index SQL │
          │ → EWS / Graph  │ │                    │
          └────────────────┘ └────────────────────┘
```

**核心特性**：
- `src/mail/backend/` 抽象核心: `base.py` (`IMailBackend` Protocol, **17 个方法 = 真实消费面**，E1 2026-07 契约收口后按实际调用重定义，盘点见 `docs/plans/architecture-review-2026-07/e1-contract-inventory.md`), `types.py` (EmailContent / EmailMeta / DraftRequest), `factory.py` (probe + create_backend), `imap_client.py` (IMAP/SMTP context manager + cipher key), `applescript_backend.py` (FALLBACK wrapper, 委托内部 arm/radar), `davmail_backend.py` (PRIMARY IMAP/SMTP impl), `davmail_uid_mapper.py` (后台 UID backfill 任务)
- **主键策略 (B 副字段)**: `email_metadata.internal_id` PK 不变. AppleScript 时代 `internal_id = Mail.app SQLite ROWID (< 10^9)`. DavMail 时代 `internal_id = allocate_davmail_internal_id() ≥ 10^9` (DB v13 新增 `sync_sequence` 表 AUTOINCREMENT). `(imap_uidvalidity, imap_uid)` 副字段定位 IMAP 端实际邮件. `backend_origin` 列标记哪个 backend 生成的
- **契约收口（E1 2026-07，原 alias 兼容层已退役）**: 曾经的 `DavMailBackend.arm = self` / `self.radar = self` 影子层已删——NewWatcher / fanout / handler 全部改为直接持 `IMailBackend` 调 `backend.fetch_email_content_by_id` / `backend.check_for_changes`；factory 之外禁止直构 `AppleScriptArm`（唯二豁免：`llm_agent/runner.py` applescript 模式 lazy-init、`cli/commands/debug.py` applescript-only 诊断），davmail 模式下批量 backfill `source=applescript` 显式报错而非静默错配 id 空间
- **Cross-backend merge guard**: `_save_email_v3` 当 message_id UNIQUE 冲突时不 INSERT OR REPLACE 杀老 row, 只 UPDATE backend 字段, 保留 `notion_page_id` / `sync_status='synced'` / `thread_id`. 防 cutover 时数据丢失
- **正向 sync (davmail 路径)**: `IMAP STATUS UIDNEXT` polling (~30s 间隔) → `radar.check_for_changes` 检测 → `UID FETCH BODY[]` (~236ms vs AppleScript ~1s, 4× 快) → 后续 NotionSync + LLM 路径不变
- **反向 sync (Sprint 15 outbox 派发)**: `FanoutWorker` 调 `backend.set_flag` → `IMAP UID STORE +\Flagged +\Seen` 同步生效, 1:1 映射
- **草稿创建 (Craft 按钮)**: davmail 模式 `IMAP APPEND` 到 Drafts folder (含 SPECIAL-USE detection + fallback), 富文本 multipart/alternative + In-Reply-To 线程折叠. applescript 模式 fallback 走 `scripts/create_reply_draft.sh` 老路径
- **DB v13 schema**: `email_metadata` 加 3 列 (`imap_uidvalidity` / `imap_uid` / `backend_origin`) + 2 索引 (`idx_imap_uid` / `idx_backend_origin`). `sync_sequence` 新表 AUTOINCREMENT seq for davmail internal_id 分配
- **LLM runner backend 注入**: `LLMRunner(backend=...)` 让 LLM fetch 路径直接走 `IMailBackend` (davmail mode 走 IMAP fetch ~236ms 而非 AppleScript ~1s)；E1 后 davmail 模式未注入 backend 时显式 raise（拒绝 fallback 到错 id 空间的 AppleScriptArm）
- **CalDAV LLM context (机会主义, 未启用)**: `src/calendar_notion/caldav_reader.py` + `build_llm_caldav_context` 已实现, 通过 DavMail CalDAV 直读 Outlook 服务端日历给 LLM 注入"今日日程" — 等观察期满 + prompt 调优再启用
- **`date_received` SSoT 时区归一**: 入口 `_normalize_date_received_iso` helper + `_local_tz()` 用 `/etc/localtime` 解析 IANA zone 自动处理 DST. cutover 时一次性 backfill 5153 行 (5月 `-07:00` / 1月 `-08:00`), 现 8899/8899 全 iso_with_tz

**切换 / 回切（一行 .env 改动）**:
```bash
# 切到 davmail
echo 'MAILAGENT_BACKEND=davmail' >> .env
echo 'DAVMAIL_POC_MODE=1' >> .env       # PoC 期间用共享 cipher key, 生产前必须改 DAVMAIL_CIPHER_KEY
pm2 restart mail-sync

# 回切 applescript (emergency)
sed -i.bak 's/^MAILAGENT_BACKEND=davmail/MAILAGENT_BACKEND=applescript/' .env
# 关键: marker reset 到 Mail.app ROWID, 否则 applescript 看 davmail UIDNEXT 永远 has_new=False
sqlite3 data/sync_store.db "UPDATE sync_state SET value = (SELECT MAX(internal_id) FROM email_metadata WHERE backend_origin='applescript') WHERE key='last_max_row_id';"
pm2 restart mail-sync
```

**死硬约束**:
- 当前 DavMail 用 Outlook for Windows well-known client_id 伪装 (PoC), **不可上生产** — 需走公司 IT 审批 (推荐直接申请 Graph API 应用)
- EWS 2026-10-01 关停, DavMail 6.7 仍走 EWS, Graph 路线图 (Issue #404) 未 merge — 见 [`docs/roadmap-post-cutover.md`](roadmap-post-cutover.md) §5.1 双轨方案
- AppleScript fallback 路径**始终可用** — 任何重构都必须保证 emergency 回切不丢数据

**详见**:
- [`docs/sprint16-cutover-complete.md`](../../archive/2026-05/sprint16-cutover-complete.md) — Sprint 16 全程纪要 (含 5 个 cutover-only bug 修复细节)
- [`docs/dual-backend-architecture-handoff.md`](../../archive/2026-05/dual-backend-architecture-handoff.md) — 设计 + 5 个决策点
- [`docs/dual-backend-phase-abc-handoff.md`](../../archive/2026-05/dual-backend-phase-abc-handoff.md) — Phase A/B/C 实施 handoff
- [`docs/next-session-handoff.md`](../../archive/2026-05/next-session-handoff.md) — cold-pickup
- [`docs/roadmap-post-cutover.md`](roadmap-post-cutover.md) — 短中长期 roadmap

## 增量 marker 语义契约（davmail，2026-08-11 丢邮件事故）

> **一句话**：同一个 `get_new_emails` 里活着**两种语义相反的 marker**，共用一个 `+1`
> 公式就会静默丢信。改这段代码前先看这张表。

| folder | marker 是什么 | 从哪来 | SEARCH 下界 |
|---|---|---|---|
| **INBOX** | **UIDNEXT** = *下一个将分配的* UID | `STATUS(UIDNEXT)`，持久化为 `last_max_row_id` | `UID {m}:*` **inclusive** |
| **Sent / custom** | **已导入的最大 UID** | `MAX(imap_uid)` from SQLite | `UID {m+1}:*` **exclusive** |

RFC 3501 定义 UIDNEXT 为「此后到达邮件 UID 的**下界**」⇒ 新邮件 `UID >= UIDNEXT`。
所以 INBOX 的下界必须 inclusive；而 Sent/custom 的 marker 是「已经处理过的最大值」，
对它 `+1` 才对。

**事故**：两个分支曾共用 `f"{since_row_id + 1}:*"`。于是每当新邮件恰好拿到
`UID == 上轮 UIDNEXT`，它就落在窗口外 → 配合「空结果照常推进游标」→ **永久跳过**，
全程无日志、无告警、不进 `dead_letter`。生产实测 2026-08 的 351 封里漏 3 封（0.9%）。

**为什么不是全漏**：UIDNEXT 通常跑在最大 UID 前面若干号（实测 +2，空洞成因未确定），
新邮件多数拿到 `UID > 上轮 UIDNEXT`，`> marker` 恰好也能覆盖。只有"恰好等于"才漏 ——
所以它能潜伏很久，且看起来像随机丢信。

🔴 **没有任何兜底会掩盖它**：生产 DavMail 实测**不做 RFC 3501 的范围反转**
（`UID <越界>:*` 直接返空，而非退化成"返回最大 UID 那封"）：

```
UIDNEXT = 162611,  视图内最大 UID = 162609
UID 162609:*  → 1 封 [162609]     UID 162610:*  → 0 封 []   ← 无反转
UID 162611:*  → 0 封 []           UID 162601:*  → 4 封      ← 多封窗口正常
```

**这是第二次踩 marker 语义混用**（第一次是 issue #34「切 backend marker id-space
混用丢数据」）。回归网 `tests/mail/backend/test_inbox_marker_semantics.py` 把两种
语义**各自的下界规则**都钉死了，防第三次。

### 配套：取数三态（`FolderFetchError`）

`_fetch_new_in_folder` 曾把 SELECT/SEARCH/FETCH 非 OK、批量解析少项、
internal_id 分配失败**统统 `return []`**，与「窗口内真的没有新邮件」不可区分，
上层照常推进游标 ⇒ 同样永久丢信。现在三态严格分开：

- `OK` + 空结果 → `[]`，**合法空成功，游标照常推进**
  （UIDNEXT 差值会因删信等高估，空成功不推进会把游标卡死）
- 协议 / 解析 / 分配失败 → **raise `FolderFetchError`**，游标不推进，下轮同窗口重试
- 有结果 → list

隔离语义靠现有 try 层级天然成立：INBOX 的异常冒泡到 `get_new_emails` 顶层 re-raise
→ `_poll_cycle` 守住游标；Sent/custom 的调用各自包在 inner try 里，捕获后只 log，
**不牵连 INBOX 主路径**。另外 `save_email()` 的返回值现在也参与游标提交判定
（此前完全没接，写库失败的那封会随游标推进出窗）。

⚠️ **一个"焊死了错误行为的闸"**：`tests/mail/test_poll_cycle_cursor_guard.py`（PR #23）
原先把「返空 → 推进」写成 **"🔒 铁律"**。它的论证只对 `OK + 空` 成立，却被泛化成
"任何 `[]` 都推进"，于是把「协议失败后永久关窗」一并锚死 —— 一条**恒绿、看起来在
保护正确性、实际在阻止修复**的测试。这正是本次事故的认知根源，值得作为反面样本记住。

## DavMail 大邮箱运维（`davmail.folderSizeLimit`，2026-07-17，issue #46）

**现象**：`davmail.properties` 的 `davmail.folderSizeLimit` 留空（默认）时，DavMail 对每次 IMAP `SELECT`/`EXAMINE`/`SEARCH` 都会触发对整个 Exchange folder 的 **EWS 全量枚举**——不是一次性建索引，是**每次**都重新枚举。大邮箱下这个代价随邮件数线性增长，且单封新邮件的处理会触发两次（`EXAMINE` 一次，紧跟的 `UID SEARCH` 又一次）。

**实测**（2026-07-17，v1.5.0，DavMail 6.8.0，INBOX = 92,743 封）：
- 单次 `EXAMINE`：EWS `FindItem` 分页 500 条/页 × 185 页（~0.75s/页）= 2 分 31 秒；紧跟的 `UID SEARCH` 又触发一次全量枚举（再 ~2.5min）
- MailAgent 侧架构叠加放大：`imap_session` 每 op 新建连接 + SELECT，所有 backend op 走 `run_backend_io` 单线程串行队列，一个 5min 的 op 会阻塞所有后续 op → 单封新邮件端到端延迟被放大到 **30-60 分钟**
- 设置 `davmail.folderSizeLimit=2000` 后：枚举 185 页 → 4 页，`EXAMINE` 2.5min → 7-13s，单封邮件端到端 **32s 实测**（约 50-100 倍改善）

**必须配置**（>10k 邮箱）：在 davmail 部署所用的 `davmail.properties`（路径不固定，取决于部署方式，MailAgent 不管理/不读取该文件）加：

```properties
davmail.folderSizeLimit=2000
log4j.logger.davmail=INFO
```

第二行是顺带修复：`log4j.logger.davmail` 默认/DEBUG 级别下每次 `SELECT` 会刷 2-3MB 的逐条 `Message IMAP uid:` 日志，1MB 滚动日志秒转，掩盖真正有用的日志。生产环境建议至少 `INFO`。

**代价与适用性**：`folderSizeLimit` 生效后 IMAP 视图只保留 folder 内最近 N 封——窗口外老邮件的 UID FETCH/SEARCH 会失效。对 MailAgent 场景**无实际影响**：正向 sync（新邮件）、flag 双向同步、reverse sync 都只碰近期邮件；老邮件的 fetch 走 AppleScript fallback 路径，不依赖 davmail 的 IMAP 视图。真机验证：设限后积压队列正常清空，其中一封 2026-05（早已超出窗口）的老邮件 retry 也成功。

**MailAgent 侧探测告警（enhancement）**：`DavMailBackend.probe_readiness()`（启动一次性 probe）成功后，会 fire-and-forget 一个 daemon 后台线程 `_warn_if_large_mailbox`，一次性 `STATUS INBOX (MESSAGES)` 取邮件总数，若 > 10000 打一条 loguru WARNING 提示设置 `folderSizeLimit`（见 `src/mail/backend/davmail_backend.py`）。🔴 **刻意放后台线程、不放 probe 主流程**：`STATUS(MESSAGES)` 在同等规模 INBOX 上同样可能耗时到分钟级（同一份 issue 批次的 issue #45 实测 92k INBOX 单次 `STATUS(MESSAGES)` 分钟级），若放进 `probe_readiness` 的关键路径会重新引入 Sprint 16 曾修复过的问题——crash-loop 时短时间内密集打 EWS 调用触发 Microsoft 端 throttling（`probe_readiness` 用 `NOOP` 替代 `SELECT INBOX` 正是这个修复的产物，见其 docstring）。放后台线程后即使探测本身耗时，也只影响这条告警的时效，不影响 backend 就绪判定。MailAgent 读不到 `davmail.properties`（路径不固定、PoC 期 gitignored），无法判断用户是否已设置该项，故文案是「若尚未设置请设置」的建议语气，不断言未设置；探测失败（超时/连接失败）静默 debug 日志，不阻断启动；进程内只探测一次。

**Out of scope（2026-07-17 批未做）**：serial executor 的「每 op ~1s」假设对大邮箱 davmail 不成立的长期改造（per-op 连接复用 / fanout 批量化），见 issue #46 建议 3。

## 多文件夹同步（2026-06，davmail-only）

让用户勾选的自定义 Exchange 文件夹（Jira / Notion / 中文名 DMS固件发布 等）并入 `email_metadata` **主链路**，享受与收件箱**等同**的全部能力（AI 分类 / Notion 同步 / FTS 全文 / 线程 / 标旗·归档·移动·回复·转发）。davmail-only（依赖 IMAP）。

**核心语义**：
- **配置 `SYNC_FOLDERS`**：白名单是 **JSON 数组**（不用 CSV）—— 中文文件夹名经 modified-UTF7（RFC 3501）编码后 base64 段含逗号（`对话历史记录` = `&W,mL3VOGU,KLsF9V-`），CSV 会被逗号劈碎。`parse_folder_csv_or_json` JSON 优先 + CSV 兜底。空数组 = 零激活。
- **imap_name vs display_name**：`imap_name` = 存储键（modified-UTF7，IMAP SELECT 用），`display_name` = `decode_imap_utf7(imap_name)`（解码中文，= `email_metadata.mailbox`）。过滤正确性命根：`WHERE mailbox = display_name`（用解码名，不是编码名）。带空格的名字（`Sent Items`）必须 `quote_mailbox` 加引号，imaplib 不自动加。
- **per-folder marker**：游标从 `email_metadata` 派生 `MAX(imap_uid) WHERE mailbox=label AND backend_origin='davmail'`（`_max_folder_imap_uid`）；uidvalidity 存 `sync_state` KV（`folder_uidvalidity:<imap_name>`）。UIDVALIDITY 变 → 全量重拉（SINCE 窗口）+ message_id merge 去重兜底。不复用 INBOX marker（独立每文件夹）。
  - **已知边界**：per-folder 增量 marker 按**解码后的 display label** 查（`MAX(imap_uid) WHERE mailbox=label`），若两个不同的 IMAP 文件夹解码出**相同显示名**（病态命名场景），它们会共享同一个 marker → 增量游标互相干扰。属已知限制（正常命名不触发）。
- **取数循环**：`get_new_emails` INBOX 段后追加白名单循环（`_fetch_custom_folder` → `_fetch_new_in_folder` 双模式）+ 每文件夹独立 try（单文件夹失败隔离）+ 窗口（`FOLDER_SYNC_PAST_DAYS`=90）+ 上限（`FOLDER_SYNC_MAX_MESSAGES`=2000，取最新 N 截断防极端大邮箱）。
- **🔒 隔离不变量**：`SYNC_FOLDERS` 空 → `_custom_folders=[]` → `get_new_emails`/`check_for_changes` 循环整段跳过（零 STATUS 探测，只 SELECT INBOX）= 逐字节同现状。
- **L2/L3 gate（降噪）**：自定义文件夹默认 **L2-on**（跑 LLM）/ **L3-off**（不推飞书）。下游 Notion/FTS/线程零改动（mailbox 字段透传，Select 自动建 option，FTS 触发器 mailbox-agnostic）。
  - **权威在 DB 行（v62, 2026-08-19）**：`folder_pref` 表（PK = **IMAP 原始名**，不是显示名 —— 显示名会撞，不同父目录下可以各有一个 `Archive`）存 `icon` / `notify_enabled` / `llm_disabled`。`NewWatcher._skip_llm_for_folder` / `_skip_feishu_for_folder` **每封邮件现读一行**（写侧是 serve-api 进程，读侧是 mail-sync，共享同一 WAL 库）⇒ **改开关不必重启 mail-sync**。模式同 v31 项目周报的行内热读。
  - 判定顺序恒为：**标准邮箱直接放行 →（读库前短路）folder_pref 行 → env frozenset 回退**。`should_skip_*_for_folder` 两个纯函数保留，降级为回退路径。
  - 🔴 **两键极性相反**：`FOLDER_NOTIFY_ENABLED` 是**白名单 opt-in**（缺省关），`FOLDER_LLM_DISABLED` 是**黑名单 opt-out**（缺省开）；落到列上 `notify_enabled` 与 UI 同向、`llm_disabled` 与 UI 的「AI 分类」**反向**。v62 迁移按这个极性从两键播种一次（显示名 → SYNC_FOLDERS 里 `decode_imap_utf7` 相等的那个 imap_name，**不连 IMAP**），之后 env 只作「行缺失时的回退」。
  - 🔴 **顺序不在 `folder_pref`**：显示顺序的权威仍是 `SYNC_FOLDERS` 数组序（该数组同时是成员表，且被 Electron 与远程 web 共读同一份 `.env`）。再存一列 `sort_order` = 同一事实两处、两个 writer 迟早对不上。
  - 🔴 **重命名/删除必须搬行**：PK 是 imap 路径，`MailWriteService.rename_folder` 后不搬 = 孤儿行 + 配置静默丢失（无报错）。`rename_folder_pref` 做精确 + 子文件夹前缀；`delete_folder` 清行，**`cleanup_local_folder` 有意保留**（取消同步 ≠ 删除，重新勾选该拿回图标/开关）。
- **重命名父文件夹：三处一致性缺一不可**（`MailWriteService.rename_folder`）。IMAP RENAME 一个父文件夹时**子文件夹的路径也跟着变**（`Proj/Sub` → `Project/Sub`），三处都必须做「精确 + `old/` 子前缀」替换：
  | 处 | 载体 | 漏掉的后果 |
  |---|---|---|
  | `_rename_local_mailbox` | `email_metadata.mailbox` | 子文件夹的历史邮件挂在旧标签下，列表/搜索按新名过滤不到 |
  | `_rename_whitelist_entry` | `.env` 的 `SYNC_FOLDERS` | 🔴 子文件夹**静默停止同步**（`_effective_custom_folders` 按名字 SELECT，旧名已不存在）—— 不报错、日志无异常、UI 勾选状态看着还在（2026-08-19 修，此前只做精确匹配） |
  | `SyncStore.rename_folder_pref` | `folder_pref` | 子文件夹的图标 + 两个开关变孤儿行，悄悄回落默认 |

  🔴 判据一律是 `old + "/"`，**不是**裸 `startswith(old)` —— `Proj` 与 `Project` 是两个独立文件夹，裸前缀会把 `Project` 改成 `Renamedect`。
- **写操作泛化**：归档 `archive_inbox_message` 加 `src_imap`（解析邮件当前文件夹，修自定义文件夹归档）+ 新 `move_to_folder(internal_id, dst_imap)`（trash 守卫）+ 文件夹管理 CRUD（`create/rename/delete_folder`，IMAP + `quote_mailbox` + 系统文件夹保护 `_assert_not_system_folder`；delete 走 `delete_email_full` 级联清 body/attachment/FTS + 附件目录；rename UPDATE mailbox 含子前缀）。
- **取消勾选清理**：`cleanup_local_folder`（删本地 `email_metadata` 级联 + 移白名单，**不碰 Exchange** —— 不调任何 reader）；默认保留，前端 opt-in。

**关键模块**：
- `src/mail/backend/imap_utf7.py` — `encode/decode_imap_utf7`。
- `src/mail/backend/imap_client.py` — `list_folders`（`imap.list` + special-use + STATUS 计数 + `build_folder_tree` 层级）/ `quote_mailbox` / `parse_folder_csv_or_json`。
- `src/mail/backend/davmail_backend.py` — `get_new_emails`/`check_for_changes` 自定义文件夹遍历 + per-folder marker/uidvalidity helper。
- `src/mail/backend/imap_folder_reader.py` — `FolderImapReader`（IMAP 写底层：list/move/create/delete/draft）；归档/草稿/CRUD 依赖。**注：P6 从已废弃的 `src/folder_sync/` 迁来**。
- `src/services/mail_write.py` — 归档/移动/CRUD/cleanup service 层。

**P6 清理（旧展示链路废弃）**：旧 `folder_sync` 模块（`FolderSyncWorker` + `folder_email`/`_fts`/`folder_sync_state` 三表，专做"存档/草稿箱纯展示"）**实测从未工作**（打包应用里 worker 从没 tick 一次、表 0 行），是"装了门面没接管线"的半成品。P6 统一删除（DB v23 DROP 三表 + 删老 router/CLI 展示端点 + 删前端老 viewer），存档/草稿箱作为可勾选文件夹并入主链路。`FolderImapReader` 永久保留（迁 `src/mail/backend/`）。

**详见**：[`docs/multi-folder-sync-prd.md`](../folder-sync/multi-folder-sync-prd.md) · [`docs/multi-folder-sync-design.md`](../folder-sync/multi-folder-sync-design.md) · [`docs/multi-folder-sync-handoff.md`](../../archive/2026-06/multi-folder-sync-handoff.md) · 看板 [`docs/multi-folder-sync-matrix.md`](../folder-sync/multi-folder-sync-matrix.md)。

## 跨语言手抄常量的一致性闸（可复用模式，现存二十二闸）

**问题形态**：一个常量 / 派生表 / 集合，在 Python 与 TypeScript（或多个 TS 文件）里各有一份**手抄**镜像。
类型系统跨不过语言边界，import 也跨不过 —— 于是改一处、漏另一处，**测试全绿、编译干净、运行时静默错**。
本仓被这个形态反复咬，形成同一套解法：**建一个一致性闸**（测试形态，非运行时机制）。

**"跨"的不止语言**（issue #68 补的几闸把边界类型摊开了）——只要两侧共享不了同一个定义，就是同一个问题：

| 边界 | 例子 |
|---|---|
| 跨语言 | Python ↔ TS（多数） |
| 跨部署 | 本地 `src/` ↔ 远程 VPS 上的 `webhook-server/`（同是 Python，但 import 不到） |
| 跨构件种类 | Python `Literal` ↔ `docs/cli-schema/*.json`（JSON Schema 不是 Python 值） |
| 跨语言载体 | Python 常量 ↔ **SQL 字符串**里的 `CHECK` 约束（建表语句 import 不进去） |
| 跨进程/跨层 | Electron main handler ↔ renderer / `shared/` 的类型声明（同语言，但 tsconfig 分项目） |

🔴 **但先问能不能不建闸**：issue #68 的一半工作量其实是**消灭镜像**而非补闸 ——
同语言同进程的（CLI ↔ serve-api 的 admin health 组装块、四份 `DEFAULT_API_PORT`、三份
`MAX_OUTPUT_TOKENS`、两份 keychain 寻址键）一律直接单源。
遇到「不能 import，因为对方模块顶层拉了 electron / SyncStore / keytar」这类理由时，
**正解通常是把常量下沉成零依赖的叶子模块**（`@shared/lib/ports.ts` / `llm_limits.ts` /
`src/services/admin_health.py`），而不是照抄一份加句注释说"同源"。
那种注释挡不住任何漂移 —— token 阈值那三份的注释就写着"同源"，而它**已经漂了**。

**解法三要素**：

1. **指定 canonical 源**。要么是某一侧的实现（`DB_VERSION` 常量、`mailbox_semantics.py` 的集合），
   要么是**测试文件自己**（表小、语义独立时更清晰——避免「谁抄谁」的循环依赖）。
2. **闸从另一侧的源码里把镜像取出来比对**：能 import 就 import；不能（TS 侧对 Python 而言）就
   **正则抽取源码分支**，或让 TS 侧测试读 Python 的产物文件。
3. 🔴 **抽取失败必须红，不能静默放过**。抽不出来（对方重构了写法）与「表不一致」同样致命——
   闸失效等于没有闸，而且没人会发现。所以抽取器只认当前的单行习语，重构者被迫回来同步更新抽取器，
   顺手核对镜像仍一致。

**现存二十二闸**（前四条是原有的，中间八条随 issue #68 补齐，再四条随 08-02 custom-agent review 补齐，
再两条随 08-01 MCP connector PR3 补齐，再一条随 08-05 列表筛选/排序菜单重做补齐，
一条随 08-06 connector 双轨目录补齐，末两条随 08-20 perf epic 补齐）：

| 镜像的东西 | 镜像在哪几处 | 闸 | 漏改的后果 |
|---|---|---|---|
| `DB_VERSION`（Python 常量 → TS `EXPECTED_DB_VERSION`） | `src/mail/sync_store.py` · `frontend/src/electron/main/backend_lifecycle.ts` | `frontend/tests/main/db_version_consistency.test.ts`（TS 读 Python 源码） | 打包 app 启动门控 `waitReady` 卡 120s 降级 |
| mailbox 判定集 / 变体集 | `src/mail/mailbox_semantics.py` · `frontend/src/shared/lib/mailboxSemantics.ts` | `frontend/tests/shared/lib/mailboxSemantics.test.ts`（两侧集合逐成员锁死） | 变体行在专属视图不可见 / 徽标与列表口径分裂（issue #42） |
| `trigger.kind → context_mode` 派生表 | `src/api/routers/agent.py::_derive_rule_context_mode`（建规盖章·写侧权威）· `frontend/src/ai-gateway/agentRun.ts::deriveContextMode`（headless 求值）· `frontend/src/shared/components/agents/custom-agent/shared.tsx::deriveHeadlessMode`（抽屉展示） | `tests/api/test_context_mode_consistency.py`（canonical 表 = 该测试文件；Python 穷举断言行为，两处 TS 从源码正则抽分支比对） | 规则双键 `(context_mode, agent_id)` 失配 → owner 配的免卡规则**永不命中**、恒 HITL；抽屉显示「未配置触发」+ 全部规则标 dormant |
| trigger `kind` 值域 + schedule `rule` 10 键 | `src/agents/trigger.py::parse_trigger`（保存校验权威）+ `src/agents/schedule_rule.py::_RULE_KEYS` · `frontend/src/ai-gateway/tools/schemas.ts::customAgentTriggerSchema`（chat CRUD 输入 allowlist，`.strict()`） | `tests/api/test_trigger_kind_parity.py`（两侧都从源码抽真值，本闸不持任何期望值副本；另有合成探针反向用例） | 少一种 kind = 对话式 CRUD 建不出该类 agent（issue #65 —— 07-24 排程批改 4 处独漏此处）；rule 键漂移 = 模型提的排程被 `.strict()`/`parse_rule` 恒拒 |
| SSE channel 名 + 心跳秒数（**跨部署**） | `src/events/publisher.py::DEFAULT_CHANNEL`（发布端真源，本地订阅端 `src/sse_server.py` 已改 import） · `webhook-server/app.py`（远程 VPS 独立部署，import 不到 `src/`） | `tests/events/test_sse_constants_parity.py` | 🔴 Redis pub/sub 对 channel 不匹配**既不抛也不警告，只是零投递** —— 远程看板的实时事件全丢，两端日志都正常 |
| `sync_status` 值域（**跨构件种类**） | `docs/cli-schema/_common.schema.json`（wire 契约，前端 `cli.gen.ts` 由它 codegen） · `src/api/schemas/email.SyncStatus`（Literal；`--status`/`?status=` 过滤白名单已改由它 `get_args` 派生） | `tests/api/test_sync_status_parity.py` | 曾漏 `deleted`：该状态**真实存在于生产库**，却在 CLI 与 web 两端都「过滤不出来」，报错还说它非法（issue #68 病根之一） |
| 中文 AI priority 枚举 | `src/llm_agent/schema.py::PRIORITY_ENUM`（真源 = LLM 输出值域） · `src/kos/producer.py::_CN_PRIORITY_MAP` · `frontend/src/shared/lib/ai_mapping.ts::mapPriority`（**有意**是超集，闸只钉方向） | `tests/kos/test_priority_enum_parity.py`（按源码顺序复刻 TS 的 if 链求值） | 加第 5 档漏改 → `_normalize_priority` **静默降成 normal**（高优邮件按普通件走 KOS floor）；前端认不出则那枚优先级点直接不渲染 |
| `calendar_event.source` 三元组 | canonical `src/calendar_sync/_common.SOURCES_TRY_ORDER`（三处 Python 已改 import） · `sync_store.py` 的 **SQL `CHECK`** · `api/schemas/calendar.py` 的 `Literal` · `src/skills/builtin/calendar.py` · TS 联合 + `shared/lib/calendarSource.ts` + gateway `z.enum` | `tests/calendar_sync/test_event_source_parity.py` | 收窄侧漏加 → 写入/调用被拒但报「非法参数」（排查往调用方去）；放宽侧漏加 → 存得进读得出，却过不了 ajv、前端 fallback 掉（只 `console.warn`） |
| `FIXED_EXEC_PATH`（exec 子进程固定 PATH） | `src/skills/secret_names.py`（冒号串） · `frontend/src/electron/main/exec_policy_matcher.ts`（数组） | `frontend/tests/main/py_ts_constants_parity.test.ts` | owner 派生的 exec 免卡规则钉在子进程**不会去查的目录** → 规则永不命中、次次弹审批（或 UI 承诺免卡而真实执行仍拦） |
| `INTEGRITY_MARKER_FILENAME` | `src/mail/db_safety.py` · `frontend/src/electron/main/backend_lifecycle.ts::DB_INTEGRITY_MARKER_FILENAME` | 同上文件（此前只有 `backend_lifecycle.test.ts` 的**自指**断言：TS 常量 vs 测试里再抄一遍的字面量，Python 改名照样绿） | Python fail-fast 写的 marker 前端永远读不到 → 用户只看到「后端起不来」，quick_check 的损坏详情丢失 |
| `REQUIRED_TABLES`（**子集**关系） | `src/services/admin_health.py`（全量 9 张，CLI/serve-api 共用） · `frontend/src/electron/main/backend_lifecycle.ts`（开窗门控的 4 张关键子集） | 同上文件（钉子集关系，不是相等 —— 子集是有意的） | TS 侧拼错表名 = `probeDbReady` 永远等不到就绪，开窗卡满 120s 超时降级（v0.2.2 同款事故） |
| 日历 IPC(17) + onboarding(16) 类型族（**跨进程，结构性**） | `electron/main/handlers/calendar-{read,sync,write}.ts` ↔ `shared/api/types/calendar.ts`；`handlers/onboarding.ts` ↔ `renderer/onboarding/ipc.ts`（含 4 对**改名**镜像） | `frontend/tests/main/type_family_parity.test.ts`（带花括号深度的小解析器抽**顶层字段键集**；只比键集不逐字段钉值 —— 否则一份手抄变两份） | 生产者多的键 = 前端读不到（TS 说它不存在）；声明多的键 = 恒 `undefined` 且**编译期完全不报**（#67 一整批就是这个形态） |
| 六能力卡工具词表 ↔ headless 可选工具集 | `src/api/routers/agent_runs.py::HEADLESS_TOOL_OPTIONS`（后端权威清单） · `frontend/src/shared/lib/customAgentCapabilities.ts::CUSTOM_AGENT_CAPABILITY_TOOL_SETS`（六档分组） | `tests/config/test_agent_capability_parity.py`（**精确相等**，不是包含；带 spread 闭包解析 + 未解析常量必抛） | 左缺 = 该工具不归任何档管，用户动一次能力卡它就成永久孤儿；右缺 = 写进 `allowed_tools` 后被 gateway 交集丢掉，**UI 显示该档已开而工具根本不存在**（本项目真发生过 `email_search`→`email_list_filter` 改名） |
| `AGENT_RUN_STATES` 9 值读态 | `src/agents/run_state.py`（运行时 frozenset，端点 state 过滤用） · `frontend/src/shared/api/types/report.ts::AgentRunState`（编译期 union，`assertNever` 穷举用） | 同上文件 | 🔴 原注释称「assertNever 会强制 UI 侧同步」——**只在 TS 内部成立**：Python 单方面加值时 TS 毫无感知，多出来的 state 让 `STATE_VISUAL` 查表落空（渲染空白） |
| `max_run_seconds` 默认/上限 | `src/agents/trigger.py::DEFAULT_MAX_RUN_SECONDS`/`MAX_RUN_SECONDS_CEILING` · `frontend/src/ai-gateway/agentRun.ts::DEFAULT_AGENT_RUN_SECONDS`/`MAX_AGENT_RUN_SECONDS`（gateway 边界防御性 re-clamp） | 同上文件 | Python 抬上限而 TS 不动 → run 在 gateway 侧**提前 abort**（用户看到「跑到一半没了」）；反向则畸形 spec 反而拿到更长运行时间 |
| report artifact 两常量 | `src/reports/models.py::MAX_IMAGE_SRC_CHARS` / `MANUAL_CHAT_REPORT_AGENT_ID` · `frontend/src/shared/api/reportBlocks.ts` 同名导出 | `tests/reports/test_block_contract_consistency.py`（与块词表闸同文件） | src 上限不一致 = 「gateway 收下、Python 拒绝」的静默不一致；哨兵 id 不一致 = manual chat 的 `report_write` 被归属校验整个拒掉 |
| `UNTRUSTED_*` 围栏格式 | `src/agents/fence.py`（spec envelope + Python 侧 tool loop 结果） · `frontend/src/shared/assistant/context/contextSerializer.ts::fenceUntrusted`（gateway 工具结果） | `tests/config/test_untrusted_fence_parity.py`（Python 从 TS 源码抽三个模板 + ZWSP 打断字面量重建后逐字节对账） | 围栏是注入面的**结构**硬防御：格式一漂，system prompt 那句「fenced 块是 user-supplied」只对一半内容成立，另一半 untrusted 内容看上去像可信文本 —— **测试全绿、运行时静默失守** |
| MCP connector crud 天花板词表 + 序（🔴 不含 `delete`）+ caller `context_mode` 值域 | `src/agents/trigger.py::_CONNECTOR_GRANT_VALUES`（保存闸权威）· `src/connectors/service.py::CONNECTOR_CRUD_RANK`/`CALLER_CONTEXT_MODES` · `frontend/src/ai-gateway/tools/policy.ts::ConnectorGrant`/`CONNECTOR_CRUD_RANK`/`AGENT_CONTEXT_MODES` · `tools/schemas.ts::customAgentConnectorGrantSchema` · `shared/api/types/chat.ts` + `report.ts` 的 wire 声明（共七处天花板副本） | `tests/config/test_connector_contract_parity.py`（有序相等 + **`delete` 不在任何一侧**的独立负例 + rank 1..N 稠密闸 + 合成源码 canary） | 任一侧多 `delete` = grill Q3=B 安全地板破口（TS 侧多 → 审批卡把删除权限渲染成正常授权；Python 侧多 → headless 真能调删除工具）；序漂 = gateway 注册期过滤与服务端天花板闸各判各的，症状只有「工具时有时无 / 莫名 403」，没有任何报错指向真因 |
| 列表排序 ORDER BY 白名单（词表 + 逐条 SQL 模板） | `frontend/src/shared/lib/emailSort.ts::EMAIL_SORT_KEYS`/`EMAIL_SORT_DIRS`/`ENRICHED_ORDER_BY`（TS 单源叶子，主进程 DAO + renderer store + `ListOpts` 三处都 import 它）· `src/api/routers/email_views.py` 同名常量（serve-api 手抄镜像，跨进程跨语言消灭不掉） | `tests/config/test_email_sort_parity.py`（两侧各自求值模板串/f-string 后空白归一逐条比对 + 「每条必带 `m.internal_id` 尾键与 `{dir}` 占位」+ importance null-guard 恒 ASC 的独立断言 + 四个抽取器失效的 canary） | 同一封邮件在桌面与远程网页排在不同位置，两边各自看都自洽、零报错。最毒的是 importance 的 null-guard 只在一侧存在 —— 那一侧的「由低到高」会把一整片没跑过 AI 的邮件顶到最前 |
| SSE 事件名全集（08-20 perf epic） | `frontend/src/shared/api/types/events.ts::SSE_EVENT_TYPES`（TS 契约数组，28 个）· Python 侧无单一常量表——真源是散布各模块的 `safe_publish("…")` 字面量 | `frontend/tests/shared/api/sseEventTypes.contract.test.ts`（**双向**对拍：正则抽取三种发布写法[字面量 / `event = "a" if … else "b"` / 内联三元首实参] + 20 个 pinned 发布文件的抽取下限 + 禁 `safe_publish(f"…")` 动态拼名；抽取失败必红——首跑即抓到藏在内联三元里的 `llm.gave_up`） | 后端新增事件前端不知道 → renderer 路由 default 静默丢弃（`folder.synced` 曾以死订阅形态存在数月，文件夹树 fallback 是假的）；TS 侧多余成员 = 把枚举当契约读的人拿到幻觉 |
| IMAP modified UTF-7 解码（08-20 perf epic） | `src/mail/backend/imap_utf7.py`（Python 真源：discover 的 display_name 与 `email_metadata.mailbox` 落库值都出自它）· `frontend/src/shared/lib/imapUtf7.ts`（Sidebar seed 树的 TS 镜像，跨进程/跨语言消灭不掉） | `frontend/tests/shared/lib/imapUtf7.test.ts`（6 组共享向量固定 Python 现算产物逐字对拍，样本与 `tests/api/test_folder_discover.py` fixture 同批；一处已知良性分歧[非法 base64 段]在测试注释里写明） | 解码分歧 = seed 树的过滤 key 与库内 mailbox 值不一致 → 点文件夹列表过滤错/过滤空，discover 回来又「自愈」——症状间歇且不可复现 |
| connector 目录 **track** 词表（08-06 双轨）+ track↔source 双射 | `src/connectors/catalog.py::CONNECTOR_TRACKS`（canonical）+ `TRACK_TO_SOURCE`（两套词表的**唯一**对接点）· `frontend/src/shared/api/types/connector.ts::ConnectorTrack`（编译期类型联合，无运行时值可 import） | `tests/config/test_connector_contract_parity.py` ③c（跨语言有序相等）+ `tests/connectors/test_catalog_tracks.py::test_track_and_source_are_a_bijection`（**Python 内**：`TRACK_TO_SOURCE` 的值恰好铺满 `store.CONNECTOR_SOURCES`） | TS 少一档 → 新轨道的目录卡走进 default 分支：`direct` 卡被当 `composio` 卡渲染成「先填 Composio key」的 disabled 态，而那一轨恰恰**不需要 key** ⇒ 一整家结构上连不上，且没有任何报错指向真因。双射漏一边 → `row_is_off_track` 把一整轨的**正确**行判成「已被目录取代」，把 owner 诱导去断开重连一个本来就对的连接 |

**什么时候必须建新闸**：你要在**第二处**手抄一个已有的常量 / 枚举 / 派生表，且两处无法共享同一个源
（跨语言 / 跨部署 / 跨构件种类 / 跨进程 / 打包边界）。每闸的成本都在 100-200 行量级，
而每次事故都是「静默错到用户面」。
先问能不能**消灭镜像**（单源 + 生成/导出 + 零依赖叶子模块）；确实消灭不了，才建闸——闸是妥协，不是首选。

**写抽取器时的两个实战坑**（issue #68 建闸过程中当场踩到的，都在对应测试里留了回归用例）：

- **部分抽取比抽不到更毒**。`REQUIRED_TABLES` 的多行元组用 `\(([^)]*)\)` 抓，会在**条目行尾注释**
  里的右括号（`"email_outbox",  # ... (Sprint 15)`）处截断，**静默少抽后面的条目** —— 闸会红在一个
  根本不存在的漂移上，反过来也可能放过真漂移。多行结构一律锚定**行首的**结束符。
- **同名结构可能不止一个**。`sync_store.py` 里有**两个** `CHECK (source IN (...))`（`calendar_event`
  与 `email_translation`），不先锚到目标表的 `CREATE TABLE` 块就会抓到隔壁那张。抽取前先缩范围。

**TS 侧还有比闸更早的一招**：值域的运行期数组用 `as const satisfies readonly Union[]` 挡住多写/写错，
再加一行 `Exclude<Union, (typeof ARR)[number]> extends never ? true : never` 挡住漏写 ——
加成员时不同步就**编译不过**。见 `frontend/src/shared/lib/calendarSource.ts`。跨语言那一步仍需闸。
