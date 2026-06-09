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

| Action Type | Outbox payload (target=mailapp) | 飞书通知 |
|------------|---------------------------------|---------|
| 需要回复/需要决策/需要Review/需要会议/需要跟进/等待响应 | `{is_read: true, is_flagged: true}` | 紧急/重要时推送卡片（含「✨ 优化回复」「📝 创建草稿」按钮 → Openclaw） |
| 仅供参考/已完结 | `{is_read: true}` (is_flagged 不动) | 否 |

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
- 灰度开关 `MAILAGENT_OUTBOX_ENABLED=false` 时 handler + reverse_sync 都退回老 AppleScript 直调路径（回退兼容）
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
- `src/mail/backend/` 抽象核心: `base.py` (`IMailBackend` Protocol, 8 个方法), `types.py` (EmailContent / EmailMeta / DraftRequest), `factory.py` (probe + create_backend), `imap_client.py` (IMAP/SMTP context manager + cipher key), `applescript_backend.py` (FALLBACK wrapper), `davmail_backend.py` (~700 行 PRIMARY IMAP/SMTP impl), `davmail_uid_mapper.py` (后台 UID backfill 任务)
- **主键策略 (B 副字段)**: `email_metadata.internal_id` PK 不变. AppleScript 时代 `internal_id = Mail.app SQLite ROWID (< 10^9)`. DavMail 时代 `internal_id = allocate_davmail_internal_id() ≥ 10^9` (DB v13 新增 `sync_sequence` 表 AUTOINCREMENT). `(imap_uidvalidity, imap_uid)` 副字段定位 IMAP 端实际邮件. `backend_origin` 列标记哪个 backend 生成的
- **alias 兼容层**: `DavMailBackend.arm = self`, `self.radar = self` — NewWatcher / fanout / handler 19+ 处 `self.arm.fetch_email_content_by_id` / `self.radar.check_for_changes` 调用零改动支持 davmail mode
- **Cross-backend merge guard**: `_save_email_v3` 当 message_id UNIQUE 冲突时不 INSERT OR REPLACE 杀老 row, 只 UPDATE backend 字段, 保留 `notion_page_id` / `sync_status='synced'` / `thread_id`. 防 cutover 时数据丢失
- **正向 sync (davmail 路径)**: `IMAP STATUS UIDNEXT` polling (~30s 间隔) → `radar.check_for_changes` 检测 → `UID FETCH BODY[]` (~236ms vs AppleScript ~1s, 4× 快) → 后续 NotionSync + LLM 路径不变
- **反向 sync (Sprint 15 outbox 派发)**: `FanoutWorker` 调 `backend.arm.set_flag` → `IMAP UID STORE +\Flagged +\Seen` 同步生效, 1:1 映射
- **草稿创建 (Craft 按钮)**: davmail 模式 `IMAP APPEND` 到 Drafts folder (含 SPECIAL-USE detection + fallback), 富文本 multipart/alternative + In-Reply-To 线程折叠. applescript 模式 fallback 走 `scripts/create_reply_draft.sh` 老路径
- **DB v13 schema**: `email_metadata` 加 3 列 (`imap_uidvalidity` / `imap_uid` / `backend_origin`) + 2 索引 (`idx_imap_uid` / `idx_backend_origin`). `sync_sequence` 新表 AUTOINCREMENT seq for davmail internal_id 分配
- **LLM runner backend 注入**: `LLMRunner(backend=...)` 让 LLM fetch 路径走 `backend.arm` (davmail mode 走 IMAP fetch ~236ms 而非 AppleScript ~1s)
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
- EWS 2026-10-01 关停, DavMail 6.7 仍走 EWS, Graph 路线图 (Issue #404) 未 merge — 见 [`docs/roadmap-post-cutover.md`](../roadmap-post-cutover.md) §5.1 双轨方案
- AppleScript fallback 路径**始终可用** — 任何重构都必须保证 emergency 回切不丢数据

**详见**:
- [`docs/sprint16-cutover-complete.md`](../sprint16-cutover-complete.md) — Sprint 16 全程纪要 (含 5 个 cutover-only bug 修复细节)
- [`docs/dual-backend-architecture-handoff.md`](../dual-backend-architecture-handoff.md) — 设计 + 5 个决策点
- [`docs/dual-backend-phase-abc-handoff.md`](../dual-backend-phase-abc-handoff.md) — Phase A/B/C 实施 handoff
- [`docs/next-session-handoff.md`](../next-session-handoff.md) — cold-pickup
- [`docs/roadmap-post-cutover.md`](../roadmap-post-cutover.md) — 短中长期 roadmap

## 多文件夹同步（2026-06，davmail-only）

让用户勾选的自定义 Exchange 文件夹（Jira / Notion / 中文名 DMS固件发布 等）并入 `email_metadata` **主链路**，享受与收件箱**等同**的全部能力（AI 分类 / Notion 同步 / FTS 全文 / 线程 / 标旗·归档·移动·回复·转发）。davmail-only（依赖 IMAP）。

**核心语义**：
- **配置 `SYNC_FOLDERS`**：白名单是 **JSON 数组**（不用 CSV）—— 中文文件夹名经 modified-UTF7（RFC 3501）编码后 base64 段含逗号（`对话历史记录` = `&W,mL3VOGU,KLsF9V-`），CSV 会被逗号劈碎。`parse_folder_csv_or_json` JSON 优先 + CSV 兜底。空数组 = 零激活。
- **imap_name vs display_name**：`imap_name` = 存储键（modified-UTF7，IMAP SELECT 用），`display_name` = `decode_imap_utf7(imap_name)`（解码中文，= `email_metadata.mailbox`）。过滤正确性命根：`WHERE mailbox = display_name`（用解码名，不是编码名）。带空格的名字（`Sent Items`）必须 `quote_mailbox` 加引号，imaplib 不自动加。
- **per-folder marker**：游标从 `email_metadata` 派生 `MAX(imap_uid) WHERE mailbox=label AND backend_origin='davmail'`（`_max_folder_imap_uid`）；uidvalidity 存 `sync_state` KV（`folder_uidvalidity:<imap_name>`）。UIDVALIDITY 变 → 全量重拉（SINCE 窗口）+ message_id merge 去重兜底。不复用 INBOX marker（独立每文件夹）。
  - **已知边界**：per-folder 增量 marker 按**解码后的 display label** 查（`MAX(imap_uid) WHERE mailbox=label`），若两个不同的 IMAP 文件夹解码出**相同显示名**（病态命名场景），它们会共享同一个 marker → 增量游标互相干扰。属已知限制（正常命名不触发）。
- **取数循环**：`get_new_emails` INBOX 段后追加白名单循环（`_fetch_custom_folder` → `_fetch_new_in_folder` 双模式）+ 每文件夹独立 try（单文件夹失败隔离）+ 窗口（`FOLDER_SYNC_PAST_DAYS`=90）+ 上限（`FOLDER_SYNC_MAX_MESSAGES`=2000，取最新 N 截断防极端大邮箱）。
- **🔒 隔离不变量**：`SYNC_FOLDERS` 空 → `_custom_folders=[]` → `get_new_emails`/`check_for_changes` 循环整段跳过（零 STATUS 探测，只 SELECT INBOX）= 逐字节同现状。
- **L2/L3 gate（降噪）**：自定义文件夹默认 **L2-on**（跑 LLM；`FOLDER_LLM_DISABLED` JSON 黑名单可关 `should_skip_llm_for_folder`）/ **L3-off**（默认不推飞书 `should_skip_feishu_for_folder`；`FOLDER_NOTIFY_ENABLED` JSON 白名单 opt-in）。下游 Notion/FTS/线程零改动（mailbox 字段透传，Select 自动建 option，FTS 触发器 mailbox-agnostic）。
- **写操作泛化**：归档 `archive_inbox_message` 加 `src_imap`（解析邮件当前文件夹，修自定义文件夹归档）+ 新 `move_to_folder(internal_id, dst_imap)`（trash 守卫）+ 文件夹管理 CRUD（`create/rename/delete_folder`，IMAP + `quote_mailbox` + 系统文件夹保护 `_assert_not_system_folder`；delete 走 `delete_email_full` 级联清 body/attachment/FTS + 附件目录；rename UPDATE mailbox 含子前缀）。
- **取消勾选清理**：`cleanup_local_folder`（删本地 `email_metadata` 级联 + 移白名单，**不碰 Exchange** —— 不调任何 reader）；默认保留，前端 opt-in。

**关键模块**：
- `src/mail/backend/imap_utf7.py` — `encode/decode_imap_utf7`。
- `src/mail/backend/imap_client.py` — `list_folders`（`imap.list` + special-use + STATUS 计数 + `build_folder_tree` 层级）/ `quote_mailbox` / `parse_folder_csv_or_json`。
- `src/mail/backend/davmail_backend.py` — `get_new_emails`/`check_for_changes` 自定义文件夹遍历 + per-folder marker/uidvalidity helper。
- `src/mail/backend/imap_folder_reader.py` — `FolderImapReader`（IMAP 写底层：list/move/create/delete/draft）；归档/草稿/CRUD 依赖。**注：P6 从已废弃的 `src/folder_sync/` 迁来**。
- `src/services/mail_write.py` — 归档/移动/CRUD/cleanup service 层。

**P6 清理（旧展示链路废弃）**：旧 `folder_sync` 模块（`FolderSyncWorker` + `folder_email`/`_fts`/`folder_sync_state` 三表，专做"存档/草稿箱纯展示"）**实测从未工作**（打包应用里 worker 从没 tick 一次、表 0 行），是"装了门面没接管线"的半成品。P6 统一删除（DB v23 DROP 三表 + 删老 router/CLI 展示端点 + 删前端老 viewer），存档/草稿箱作为可勾选文件夹并入主链路。`FolderImapReader` 永久保留（迁 `src/mail/backend/`）。

**详见**：[`docs/multi-folder-sync-prd.md`](../multi-folder-sync-prd.md) · [`docs/multi-folder-sync-design.md`](../multi-folder-sync-design.md) · [`docs/multi-folder-sync-handoff.md`](../multi-folder-sync-handoff.md) · 看板 [`docs/multi-folder-sync-matrix.md`](../multi-folder-sync-matrix.md)。
