"""
SyncStore - 邮件同步状态存储模块 (v3 架构)

v3 架构变更：
- internal_id (SQLite ROWID = AppleScript id) 作为主键
- message_id 作为 UNIQUE 约束（AppleScript 成功后填充，用于去重）
- 合并 sync_failures 到 email_metadata（统一重试机制）
- 新增 next_retry_at 字段（指数退避）

状态流转：
    pending -> fetch_failed -> (retry) -> synced/failed
    pending -> synced
    pending -> failed -> (retry) -> synced/dead_letter

Usage:
    store = SyncStore("data/sync_store.db")

    # v3 架构：用 internal_id 保存
    store.save_email({
        'internal_id': 41457,
        'mailbox': '收件箱',
        'subject': 'Test',
        'sync_status': 'pending',
    })

    # AppleScript 成功后更新
    store.update_after_fetch(41457, {
        'message_id': '<xxx@example.com>',
        'thread_id': '<yyy@example.com>',
        'subject': 'Test (updated)',
    })

    # 标记同步成功
    store.mark_synced_v3(41457, notion_page_id)

    # 兼容旧 API（使用 message_id）
    store.mark_synced(message_id, notion_page_id)
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Any, Iterator, TypedDict
from loguru import logger


def _local_tz():
    """返回 IANA ``ZoneInfo`` (含 DST 规则). 优先 /etc/localtime 软链, fallback fixed offset.

    mail.app SQLite radar 用 ``datetime(ts, 'unixepoch', 'localtime')`` 转 Unix
    timestamp 成本地 naive 字符串 — 跟 mail.app GUI 显示给用户的时间一致. 关键是同一封
    邮件在不同月份 (DST vs 标准时间) tz 偏移不同, 不能用 ``datetime.now().astimezone()``
    硬拿当前 offset (会让所有历史邮件用今天的 DST 状态, 跨边界时错 1h).

    用 ``zoneinfo.ZoneInfo("America/Los_Angeles")`` 这种 IANA zone 自动按每个 datetime
    的具体日期决定 PDT (-07) / PST (-08).
    """
    try:
        from zoneinfo import ZoneInfo
        import os
        import re
        # macOS /etc/localtime -> /var/db/timezone/zoneinfo/America/Los_Angeles
        link = os.readlink("/etc/localtime")
        m = re.search(r"zoneinfo/(.+)$", link)
        if m:
            return ZoneInfo(m.group(1))
    except Exception:
        pass
    # Fallback: 当前时刻的固定 offset (跨 DST 边界时 ~1h 误差)
    return datetime.now().astimezone().tzinfo or timezone.utc


def _normalize_date_received_iso(value: Optional[str]) -> Optional[str]:
    """把 date_received 归一成 ISO 8601 带 tz 字符串.

    输入支持:
    - 已是 ISO with tz: ``2026-05-22T14:30:00+08:00`` → 原样返回
    - ISO naive: ``2026-01-27T23:01:25`` → 加系统本地 tz
    - space-separated naive (mail.app SQLite radar 用 ``datetime(ts, 'unixepoch',
      'localtime')`` 输出, 是**系统本地 tz** naive): ``2026-05-19 04:23:53`` →
      ``2026-05-19T04:23:53-07:00`` (假设系统 PDT)
    - RFC 822 (旧 davmail 兜底): ``Fri, 22 May 2026 14:30:00 +0800`` → ISO 8601
    - 空 / 解析失败: 原样返回 (上层别 break)

    Sprint 16 cutover: ``_local_tz()`` 动态拿系统 tz 而非硬编码 ``+08:00`` —
    上一版本 hard-code 北京时区导致 PDT 用户的 5148 行被标错 tz.
    """
    if not value:
        return value
    s = value.strip()
    if not s:
        return value
    local_tz = _local_tz()
    # 已是 ISO with tz (T 加 +HH:MM / -HH:MM / Z)
    if "T" in s and (s.endswith("Z") or "+" in s[10:] or "-" in s[10:]):
        return s
    # ISO naive: 2026-01-27T23:01:25
    if "T" in s and len(s) >= 19:
        try:
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                # 加 system tz (含 DST 自动识别)
                dt = dt.replace(tzinfo=local_tz)
                # 但 Python tzinfo 加上去不一定带 DST, 用 astimezone re-resolve 一次
                dt = dt.astimezone(local_tz)
            return dt.isoformat()
        except (TypeError, ValueError):
            pass
    # space-separated: 2026-05-19 04:23:53
    if " " in s and len(s) >= 19 and s[10] == " ":
        try:
            dt = datetime.fromisoformat(s.replace(" ", "T", 1))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=local_tz)
                dt = dt.astimezone(local_tz)
            return dt.isoformat()
        except (TypeError, ValueError):
            pass
    # RFC 822 fallback (e.g. davmail 早期 path / 万一漏掉 normalize)
    try:
        dt = parsedate_to_datetime(s)
        if dt is None:
            return value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_tz)
        return dt.isoformat()
    except Exception:
        return value


class SyncStoreStats(TypedDict, total=False):
    """同步存储统计信息类型定义"""
    total_emails: int
    by_status: Dict[str, int]
    by_mailbox: Dict[str, int]
    pending: int
    synced: int
    failed: int
    fetch_failed: int
    dead_letter: int
    skipped: int
    failure_queue: int
    last_max_row_id: int
    last_sync_time: Optional[str]
    db_size_bytes: int
    db_size_mb: float


class EmailMetadata(TypedDict, total=False):
    """邮件元数据类型定义"""
    internal_id: int  # v3 新增：主键
    message_id: Optional[str]  # v3：UNIQUE，AppleScript 成功后填充
    thread_id: Optional[str]
    subject: str
    sender: str
    sender_name: str
    to_addr: str
    cc_addr: str
    date_received: str
    mailbox: str
    is_read: int  # SQLite boolean as int
    is_flagged: int
    sync_status: str  # 'pending' | 'fetch_failed' | 'synced' | 'failed' | 'skipped' | 'dead_letter'
    notion_page_id: Optional[str]
    notion_thread_id: Optional[str]
    sync_error: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]  # v3 新增：下次重试时间（合并自 sync_failures）
    created_at: float
    updated_at: float


class SyncStore:
    """邮件同步状态存储 - v3 架构（internal_id 为主键）"""

    # 数据库版本，用于迁移检测
    # v3 (2026-01): internal_id 主键 + 合并 sync_failures
    # v4 (2026-05): 新增 email_body + email_attachment（body 作为一等公民进 SQLite，SSoT 切换）
    # v5 (2026-05): 新增 email_body_fts FTS5 虚表 + insert/update/delete trigger + 首次 reindex
    # v6 (2026-05): 新增 cli_checkpoints (长任务 checkpoint resume) + v4_rollout_stats (R-06 持久化)
    # v7 (2026-05): 新增 island_dispatch (Island-Sprint 2 ping-island 派发审计 + 14d 评估指标)
    # v8 (2026-05): email_metadata 增加 is_pinned + pinned_at（前端置顶持久化，Mail.app 无此概念，
    #               仅在 SQLite + CLI 暴露；主进程独占写、Electron 前端 readonly 经 CLI 子进程 toggle）
    # v9 (2026-05): email_metadata 增加 is_important（邮件原生重要性，由 reader._parse_importance
    #               从 Importance / X-Priority / X-MSMail-Priority header 提取；前端 ❗ 角标用）
    # v11 (Sprint 16, 2026-05): listEnriched 性能优化索引 (mailbox+sync_status+date_received /
    #                          is_flagged partial / email_attachment(internal_id, is_inline)).
    #                          纯加索引非破坏, 老 db 重启自动 CREATE INDEX IF NOT EXISTS.
    # v10 (2026-05): email_outbox 表 —— Sprint 15 SQLite SSoT inversion 的基础设施。
    #                所有 mutating 操作（前端 flag / processing_status 变更、Notion webhook 反向同步）
    #                以 intent 形式落库，FanoutWorker 异步派发到 Mail.app + Notion。
    #                Echo prevention: source='notion_webhook' + target='notion' 被强制 silent skip
    #                避免回环。详见 SPRINT15-HANDOFF.md §3.3-§3.4。
    # v12 (Sprint Immersive-Translate, 2026-05): email_translation 表 —— 沉浸式翻译缓存。
    #                Path A (LLM 分类顺带, source='llm_agent') + Path B (用户点翻译, source='on_demand')
    #                双路径写入同一表; segments_json 形状 [{src, tgt}] 统一. 单语言 (zh) 设计,
    #                internal_id PK + FK CASCADE; 重新翻译先 DELETE 再 INSERT.
    #                详见 frontend/SPRINT-IMMERSIVE-TRANSLATE-HANDOFF.md.
    # v13 (Sprint 16 dual-backend, 2026-05): email_metadata 加 imap_uidvalidity / imap_uid /
    #                backend_origin 三列, 支持 DavMail backend (IMAP) 与 AppleScript backend
    #                共存. backend_origin='applescript' → internal_id = Mail.app ROWID (<10^9);
    #                backend_origin='davmail' → internal_id = sync_state['davmail_next_internal_id']
    #                自增 (起点 1_000_000_000, 永不与 ROWID 冲突). 通过 allocate_davmail_internal_id()
    #                atomic 分配. 详见 plan §"主键 / 邮件标识策略" 方案 D +
    #                docs/dual-backend-architecture-handoff.md.
    # v15 (Calendar SSoT, 2026-05): 新增 calendar_event + calendar_sync_state 两表, 把日历事件
    #                落地为 SQLite SSoT (前端日历视图 / CLI / Notion mirror 单一数据源).
    #                calendar_event: PK=id AUTOINCREMENT + UNIQUE(ical_uid, recurrence_id, source);
    #                source 三态 (caldav / email_ics / legacy_calendar_app) 灰度共存. 时间一律存
    #                UTC epoch (REAL), 前端按 toLocaleString 转本地 TZ. 详见 plan
    #                §"Phase 1.1 DB 升级" + frontend-view-silly-knuth.md.
    # v17 (Folder Archive/Drafts, 2026-05): 曾新增 folder_email + folder_email_fts +
    #                folder_sync_state 三表 (旧 FolderSyncWorker 展示链路)。该链路实测从未
    #                工作 (folder_email 0 行), 多文件夹同步 (v22) 改走 email_metadata 主链路。
    #                v23 (P6 cleanup) 已 DROP 这三表 + FTS 触发器, 见下方 v23 迁移块。
    # v21 (async_jobs, C1 2026-06): 新增 async_jobs 表 (长任务统一 enqueue + 执行账本) +
    #                ux_async_jobs_idempotency partial unique + ix_async_jobs_status。纯加表,
    #                CREATE TABLE IF NOT EXISTS 对新/旧库均生效, 无 data migration。serve 进程内
    #                JobWorker (灰度 MAILAGENT_ASYNC_JOBS_ENABLED) 消费。详见 C1 看板格。
    # v23 (P6 folder_sync cleanup, 2026-06): DROP folder_email + folder_email_fts +
    #                folder_sync_state 三表 + FTS 触发器 (旧 FolderSyncWorker 展示链路实测从未
    #                工作)。多文件夹同步走 email_metadata 主链路 (v22)。幂等 DROP IF EXISTS。
    DB_VERSION = 23  # v23: DROP 旧 folder_sync 三表 (展示链路死代码清理)

    def __init__(self, db_path: str = "data/sync_store.db"):
        """初始化同步存储

        Args:
            db_path: SQLite 数据库文件路径
        """
        self.db_path = Path(db_path)
        self._ensure_directory()
        self._init_database()
        logger.info(f"SyncStore initialized: {self.db_path}")

    def _ensure_directory(self):
        """确保数据目录存在"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _get_connection(self) -> sqlite3.Connection:
        """获取数据库连接"""
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")  # v4: CASCADE / SET NULL 生效必需
        return conn

    @contextmanager
    def _connection(self):
        """数据库连接上下文管理器

        确保连接正确关闭，即使发生异常。

        Usage:
            with self._connection() as conn:
                cursor = conn.cursor()
                ...
        """
        conn = self._get_connection()
        try:
            yield conn
        finally:
            conn.close()

    def _init_database(self):
        """初始化数据库表结构（v3 架构）"""
        conn = self._get_connection()
        cursor = conn.cursor()

        # 同步状态表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS sync_state (
                key TEXT PRIMARY KEY,
                value TEXT,
                updated_at REAL
            )
        """)

        # 检查是否需要迁移
        cursor.execute("SELECT value FROM sync_state WHERE key = 'db_version'")
        row = cursor.fetchone()
        current_version = int(row['value']) if row else 1

        if current_version < 3:
            # v3 需要迁移，检查是否已有 email_metadata 表
            cursor.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='email_metadata'
            """)
            if cursor.fetchone():
                # 已有旧表，检查是否有 internal_id 列
                cursor.execute("PRAGMA table_info(email_metadata)")
                columns = {row[1] for row in cursor.fetchall()}
                if 'internal_id' not in columns:
                    # 需要迁移但尚未迁移，记录警告
                    logger.warning(
                        "SyncStore v2 detected, please run migration script: "
                        "python3 scripts/migrate_sync_store_v3.py"
                    )
                    # 继续使用旧表结构
                    conn.close()
                    return

        # v3 架构：email_metadata 表（internal_id 为主键）
        # v8: is_pinned / pinned_at —— 前端置顶 / pin 持久化
        # v9: is_important —— 邮件原生重要性（Importance / X-Priority header）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_metadata (
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
                updated_at REAL,
                is_pinned INTEGER DEFAULT 0,
                pinned_at REAL,
                is_important INTEGER DEFAULT 0,
                imap_uidvalidity INTEGER,
                imap_uid INTEGER,
                backend_origin TEXT DEFAULT 'applescript'
            )
        """)

        # 创建索引
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_message_id
            ON email_metadata(message_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_thread
            ON email_metadata(thread_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_date
            ON email_metadata(date_received DESC)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_sync_status
            ON email_metadata(sync_status)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_mailbox
            ON email_metadata(mailbox)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_next_retry
            ON email_metadata(next_retry_at)
            WHERE sync_status IN ('fetch_failed', 'failed')
        """)

        # 线程头缓存表
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS thread_head_cache (
                thread_id TEXT PRIMARY KEY,
                status TEXT DEFAULT 'not_found',
                checked_at REAL,
                note TEXT
            )
        """)

        # 周期会议系列元数据（用于滚动展开未来 occurrences）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS recurring_series (
                series_uid TEXT PRIMARY KEY,
                rrule_str TEXT NOT NULL,
                exdates_json TEXT DEFAULT '[]',
                rdates_json TEXT DEFAULT '[]',
                master_dtstart TEXT NOT NULL,
                master_dtend TEXT NOT NULL,
                master_summary TEXT,
                master_organizer TEXT,
                master_organizer_email TEXT,
                master_location TEXT,
                master_description TEXT,
                master_tzid TEXT,
                master_is_all_day INTEGER DEFAULT 0,
                last_sequence INTEGER DEFAULT 0,
                last_seen_message_id TEXT,
                last_expanded_until TEXT,
                last_modified TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_recurring_series_expanded_until
            ON recurring_series(last_expanded_until)
        """)

        # 兼容性：保留 sync_failures 表（如果存在，用于迁移）
        # 新代码不再使用此表

        # === v4: email_body 表（邮件正文作为一等公民进 SQLite）===
        # 详见 docs/architecture_v4_sqlite_ssot.md §4.1
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_body (
                internal_id INTEGER PRIMARY KEY,
                message_id TEXT,
                body_html TEXT,
                body_markdown TEXT,
                body_format TEXT,
                body_size_bytes INTEGER,
                has_inline_images INTEGER DEFAULT 0,
                raw_mime_sha256 TEXT,
                fetched_at REAL NOT NULL,
                fetched_source TEXT NOT NULL,
                schema_version INTEGER DEFAULT 1,
                FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_body_message_id
            ON email_body(message_id) WHERE message_id IS NOT NULL
        """)

        # === v4: email_attachment 表（附件元数据，二进制落本地 data/attachments/{internal_id}/）===
        # 详见 docs/architecture_v4_sqlite_ssot.md §4.2
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_attachment (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                internal_id INTEGER NOT NULL,
                content_id TEXT,
                filename TEXT NOT NULL,
                content_type TEXT,
                size_bytes INTEGER,
                is_inline INTEGER DEFAULT 0,
                local_path TEXT,
                sha256 TEXT,
                derived_from INTEGER,
                derived_format TEXT,
                notion_file_id TEXT,
                notion_block_id TEXT,
                created_at REAL NOT NULL,
                schema_version INTEGER DEFAULT 1,
                FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE,
                FOREIGN KEY (derived_from) REFERENCES email_attachment(id) ON DELETE SET NULL
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_attachment_internal
            ON email_attachment(internal_id)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_attachment_cid
            ON email_attachment(content_id) WHERE content_id IS NOT NULL
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_attachment_sha256
            ON email_attachment(sha256) WHERE sha256 IS NOT NULL
        """)

        # === v5: email_body_fts FTS5 全文索引 ===
        # 详见 docs/architecture_v4_sqlite_ssot.md §3.3 + docs/phase2-handoff-to-phase3.md §5.1
        # 设计稿用 contentless (content='')，但实测 snippet() / SELECT 列内容均返回空 ——
        # contentless 不存原文，snippet 无法工作。改成 contentful（FTS 自带数据副本），
        # 索引大小翻倍但实测全量 6131 封后估算 < 100 MB，完全可接受（handoff §7.3）。
        # rowid = internal_id，便于和 email_metadata / email_body 互查。
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts USING fts5(
                body_markdown,
                subject,
                sender,
                tokenize='porter unicode61 remove_diacritics 2'
            )
        """)

        # Trigger：email_body 写入/更新/删除时自动维护 FTS 索引
        # 注意：subject / sender 从 email_metadata join 取，trigger 触发时
        # metadata 行已存在（双写流程 metadata 先 commit）
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_insert
            AFTER INSERT ON email_body BEGIN
                INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(NEW.body_markdown, ''),
                       COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                       COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_delete
            AFTER DELETE ON email_body BEGIN
                DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_update
            AFTER UPDATE ON email_body BEGIN
                DELETE FROM email_body_fts WHERE rowid = OLD.internal_id;
                INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(NEW.body_markdown, ''),
                       COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                       COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
            END
        """)

        # 首次启用 reindex：把已有 email_body 行推入 FTS（migration 友好，
        # 已存在行不会重复写：用 NOT EXISTS 防重，幂等）
        # current_version 是本次 _init_database 入口处读的旧版本
        if current_version < 5:
            cursor.execute("""
                INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
                SELECT b.internal_id,
                       COALESCE(b.body_markdown, ''),
                       COALESCE(m.subject, ''),
                       COALESCE(m.sender, '')
                  FROM email_body b
                  JOIN email_metadata m ON m.internal_id = b.internal_id
                 WHERE NOT EXISTS (
                       SELECT 1 FROM email_body_fts WHERE rowid = b.internal_id
                 )
            """)
            reindexed = cursor.rowcount or 0
            if reindexed:
                logger.info(f"v5 FTS5 reindex: {reindexed} email_body rows indexed")

        # === v6: cli_checkpoints (长任务 checkpoint / resume) ===
        # PR-4 RFC §5 长任务契约。PK (command, target_key) 保证两个同批
        # `email resync --range 53000-53100` 不会互相覆盖。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cli_checkpoints (
                command TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_key TEXT NOT NULL,
                last_completed_internal_id INTEGER,
                succeeded INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                aborted_at REAL,
                started_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                payload TEXT,
                PRIMARY KEY (command, target_key)
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_cli_checkpoints_updated
            ON cli_checkpoints(updated_at DESC)
        """)

        # === v6: v4_rollout_stats (R-06 持久化, RFC §8 选项 A) ===
        # NotionSync 内存累计 (_route_hit / _route_miss / _route_error / latency),
        # 每 60s flush 一行 (window_seconds), admin stats 读最新行 + staleness.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS v4_rollout_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                flushed_at REAL NOT NULL,
                from_sqlite_hit INTEGER NOT NULL DEFAULT 0,
                fallback_miss INTEGER NOT NULL DEFAULT 0,
                fallback_error INTEGER NOT NULL DEFAULT 0,
                route_latency_p99_ms REAL NOT NULL DEFAULT 0,
                body_miss_internal_ids TEXT,
                window_seconds INTEGER NOT NULL DEFAULT 60
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_v4_rollout_flushed_at
            ON v4_rollout_stats(flushed_at DESC)
        """)

        # === v7: island_dispatch (Island-Sprint 2 ping-island 派发审计) ===
        # 来源：frontend/ISLAND-PLUGIN.md §9 评估指标
        # dispatched_ok = 1 表示 socket 路径成功（即使 ping-island 没回 decision）
        # response_decision = 用户点的 option id（仅 expectsResponse=true 且用户回应才填）
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS island_dispatch (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sent_at REAL NOT NULL,
                event_type TEXT NOT NULL,
                session_key TEXT,
                dispatched_ok INTEGER NOT NULL DEFAULT 0,
                response_decision TEXT,
                response_latency_ms INTEGER,
                internal_id INTEGER
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_island_dispatch_sent_at
            ON island_dispatch(sent_at DESC)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_island_dispatch_event_type
            ON island_dispatch(event_type)
        """)

        # === v8: email_metadata 增加 is_pinned + pinned_at ===
        # 旧 v7 库已经有 email_metadata 表（无 is_pinned 列）→ ALTER TABLE 补
        # 新建库走上面的 CREATE TABLE IF NOT EXISTS 已经带这俩列
        # PRAGMA 检测列是否存在 → 避免重复迁移失败（IF NOT EXISTS 对 ADD COLUMN 不可用）
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            existing_cols = {r[1] for r in cursor.fetchall()}
            if 'is_pinned' not in existing_cols:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN is_pinned INTEGER DEFAULT 0"
                )
                logger.info("v8 migration: added email_metadata.is_pinned")
            if 'pinned_at' not in existing_cols:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN pinned_at REAL"
                )
                logger.info("v8 migration: added email_metadata.pinned_at")
        except sqlite3.OperationalError as e:
            # 表不存在等罕见情形（理论上前面的 CREATE TABLE IF NOT EXISTS 已经建好）
            logger.warning(f"v8 migration: skipped is_pinned ADD COLUMN ({e})")

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_is_pinned
            ON email_metadata(is_pinned) WHERE is_pinned = 1
        """)

        # === v9: email_metadata 增加 is_important（邮件原生重要性）===
        # 旧 v8 库已有 email_metadata 表（无 is_important 列）→ ALTER TABLE 补。
        # 历史邮件（无 raw MIME 重解析）默认 0；后续 sync 的新邮件会写入真值。
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            cols_v9 = {r[1] for r in cursor.fetchall()}
            if 'is_important' not in cols_v9:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN is_important INTEGER DEFAULT 0"
                )
                logger.info("v9 migration: added email_metadata.is_important")
        except sqlite3.OperationalError as e:
            logger.warning(f"v9 migration: skipped is_important ADD COLUMN ({e})")

        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_is_important
            ON email_metadata(is_important) WHERE is_important = 1
        """)

        # === v10: email_outbox 表（Sprint 15 SQLite SSoT inversion）===
        # 所有 mutating 操作（flag / processing_status / 反向 webhook 同步）以 intent 落库，
        # FanoutWorker 异步派发到 Mail.app + Notion。详 SPRINT15-HANDOFF.md §3。
        # target='mailapp' | 'notion' —— 单 op 拆两条入队，每条独立失败重试
        # source='frontend' | 'notion_webhook' | 'cli' —— echo prevention 依据
        # status 状态机: pending → processing → done | failed → (retry) | dead_letter
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_outbox (
                outbox_id     INTEGER PRIMARY KEY AUTOINCREMENT,
                internal_id   INTEGER NOT NULL,
                op_type       TEXT NOT NULL,
                target        TEXT NOT NULL,
                payload_json  TEXT NOT NULL,
                source        TEXT,
                status        TEXT NOT NULL DEFAULT 'pending',
                attempts      INTEGER NOT NULL DEFAULT 0,
                last_error    TEXT,
                next_retry_at REAL,
                created_at    REAL NOT NULL,
                updated_at    REAL NOT NULL,
                CHECK (target IN ('mailapp','notion')),
                CHECK (status IN ('pending','processing','done','failed','dead_letter')),
                FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
            )
        """)
        # 调度索引：FanoutWorker poll_ready 主路径 (status, next_retry_at)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_outbox_pending
            ON email_outbox(status, next_retry_at)
            WHERE status IN ('pending','failed')
        """)
        # 邮件级查询索引（admin queue-depth / 调试用）
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_outbox_internal_id
            ON email_outbox(internal_id)
        """)
        # 派发分类索引（per-target 统计 / fanout 分流）
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_outbox_target_status
            ON email_outbox(target, status)
        """)

        # === v11 (Sprint 16): listEnriched 性能优化索引 ===
        # 前端 EmailList 5s 轮询全量 listEnriched (3 表 LEFT JOIN + COUNT 子查询),
        # 加上 SQLite WAL busy_timeout 阻塞主线程, 现进入卡顿. 加 3 个索引覆盖
        # listEnriched 的 WHERE + ORDER + 子聚合, p99 从 200-500ms 降到 10-30ms.
        # 纯加索引非破坏, IF NOT EXISTS 幂等; 老 db 重启即生效.

        # WHERE mailbox=? AND sync_status=? ORDER BY date_received DESC — 默认列表 view
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_meta_listing
            ON email_metadata(mailbox, sync_status, date_received DESC)
        """)
        # "已标旗" 虚拟入口 (Sidebar) 用; partial index 减小尺寸
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_meta_flagged_only
            ON email_metadata(date_received DESC)
            WHERE is_flagged = 1
        """)
        # attach_count LEFT JOIN 聚合 (handlers/email.ts:listEnriched)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_attachment_visible
            ON email_attachment(internal_id, is_inline)
        """)

        # === v12 (Sprint Immersive-Translate): email_translation 缓存表 ===
        # 沉浸式翻译双路径共享缓存层：
        #   - Path A (source='llm_agent'): LLM 邮件分类时 tool_use 同时返回
        #     translation_segments, LLMRunner 在 mark_success 后写入。
        #   - Path B (source='on_demand'): 用户点击 "翻译" 按钮触发的 batch
        #     翻译, 前端 translate.ts:translate:batch 写入。
        # 设计：单语言 (zh) — 用户主语言确定，无多语言并存需求；
        #       internal_id PK + FK CASCADE — 删邮件自动清缓存；
        #       segments_json 是 JSON 数组 [{src, tgt}, ...]，src 是原文段落
        #       verbatim (≤300 字符), tgt 是简体中文译文。前端 EmailBodyFrame
        #       用 textContent.includes(src) fuzzy 配对 DOM 节点注入译文。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_translation (
                internal_id   INTEGER PRIMARY KEY,
                target_lang   TEXT NOT NULL DEFAULT 'zh',
                segments_json TEXT NOT NULL,
                model         TEXT,
                source        TEXT NOT NULL,
                created_at    REAL NOT NULL,
                updated_at    REAL NOT NULL,
                CHECK (source IN ('llm_agent','on_demand')),
                FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
            )
        """)
        # source 维度统计 (admin / debug 看 LLM 路径覆盖率)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_translation_source
            ON email_translation(source)
        """)

        # === v13 (Sprint 16 dual-backend): email_metadata 加 imap_uidvalidity / imap_uid /
        # backend_origin 三列, 支持 DavMail (IMAP) backend 与 AppleScript backend 单 driver
        # 显式切换. 详见 plan §"主键 / 邮件标识策略" 方案 D.
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            cols_v13 = {r[1] for r in cursor.fetchall()}
            if 'imap_uidvalidity' not in cols_v13:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN imap_uidvalidity INTEGER"
                )
                logger.info("v13 migration: added email_metadata.imap_uidvalidity")
            if 'imap_uid' not in cols_v13:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN imap_uid INTEGER"
                )
                logger.info("v13 migration: added email_metadata.imap_uid")
            if 'backend_origin' not in cols_v13:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN backend_origin TEXT DEFAULT 'applescript'"
                )
                logger.info("v13 migration: added email_metadata.backend_origin (default 'applescript')")
            # Sprint 15 D 块漏的 ALTER TABLE — update_local_flags(processing_status) 假设
            # email_metadata 有 processing_status 列, 但当时只加了写入路径没加 schema.
            # 顺手补上 (idempotent, 跟 v13 一并跑).
            if 'processing_status' not in cols_v13:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN processing_status TEXT"
                )
                logger.info("v13 migration: added email_metadata.processing_status (Sprint 15 D backfill)")
        except sqlite3.OperationalError as e:
            logger.warning(f"v13 migration: skipped ADD COLUMN ({e})")

        # ==================== v14 migration: AI 字段提升为主表列 ====================
        # 把 ai_priority / ai_action 从 llm_processing.labels_json (JSON 间接查) 提升为
        # email_metadata 主表列, 让前端按这两个字段排序 / 过滤可走索引 (json_extract 不走).
        # labels_json 仍保留全量作 backup (其他 AI 字段如 ai_summary / key_points /
        # reply_suggestion_md / category / language 不进主表, 走 JSON 灵活扩展).
        # 主写路径: LLMProcessingStore.mark_success + upsert_external_labels(source='notion')
        try:
            cursor.execute("PRAGMA table_info(email_metadata)")
            cols_v14 = {r[1] for r in cursor.fetchall()}
            if 'ai_priority' not in cols_v14:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN ai_priority TEXT"
                )
                logger.info("v14 migration: added email_metadata.ai_priority")
            if 'ai_action' not in cols_v14:
                cursor.execute(
                    "ALTER TABLE email_metadata ADD COLUMN ai_action TEXT"
                )
                logger.info("v14 migration: added email_metadata.ai_action")
        except sqlite3.OperationalError as e:
            logger.warning(f"v14 migration: skipped ADD COLUMN ({e})")

        # 索引: imap_uid 反查 (DavMail backend fetch_email_by_id 快路径) — partial 减小尺寸
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_imap_uid
            ON email_metadata(imap_uidvalidity, imap_uid)
            WHERE imap_uid IS NOT NULL
        """)
        # backend_origin 分组统计 / 灰度对账用
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_backend_origin
            ON email_metadata(backend_origin)
        """)
        # v14: AI 字段索引 (partial - 仅非 NULL, 大幅减小索引尺寸)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_ai_priority
            ON email_metadata(ai_priority)
            WHERE ai_priority IS NOT NULL
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_ai_action
            ON email_metadata(ai_action)
            WHERE ai_action IS NOT NULL
        """)

        # 初始化 davmail internal_id 自增序列 (起点 1_000_000_000, 永不与 Mail.app ROWID 冲突).
        # SQLite INTEGER PRIMARY KEY 不能 ALTER 成 AUTOINCREMENT, 用 sync_state KV 维护.
        cursor.execute("""
            INSERT OR IGNORE INTO sync_state (key, value, updated_at)
            VALUES ('davmail_next_internal_id', '1000000000', ?)
        """, (time.time(),))

        # ==================== v15: Calendar SSoT (CalDAV → SQLite) ====================
        # 日历事件落地表 — 前端日历视图 + CLI calendar events 子命令 + Notion mirror
        # 单一数据源. PK=id (AUTOINCREMENT), 业务唯一性靠 UNIQUE(ical_uid, recurrence_id, source).
        # 同一 ical_uid 可能跨 source 各有一行 (灰度期 caldav / legacy_calendar_app 共存):
        #   - 'caldav': CalendarSyncWorker 从 DavMail CalDAV 拉的 (Phase 1 主路径)
        #   - 'email_ics': meeting_sync.py 解析邮件邀请的 .ics 派生 (related_email_internal_id 关联)
        #   - 'legacy_calendar_app': calendar_main.py / src/calendar/ 老 EventKit / AppleScript
        #     路径写入 (Phase 1 灰度期保留, 2-4 周对账后下线)
        # 时间字段全部 UTC epoch (REAL), 跨时区 / DST 统一; 前端 toLocaleString 转本地展示.
        # recurrence_id 为 NULL 表示主事件 (含 RRULE); 子事件 occurrence 跳脱时存非空.
        # rrule 字符串原样保留 (RFC 5545), 前端用 npm rrule lib 展开窗口内 occurrences.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS calendar_event (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ical_uid TEXT NOT NULL,
                recurrence_id TEXT,
                sequence INTEGER NOT NULL DEFAULT 0,
                calendar_name TEXT,
                summary TEXT,
                description TEXT,
                location TEXT,
                organizer TEXT,
                attendees_json TEXT,
                dtstart_utc REAL NOT NULL,
                dtend_utc REAL,
                is_all_day INTEGER NOT NULL DEFAULT 0,
                rrule TEXT,
                exdates_json TEXT,
                rdates_json TEXT,
                status TEXT,
                response_status TEXT,
                url TEXT,
                ics_raw TEXT,
                source TEXT NOT NULL DEFAULT 'caldav',
                notion_page_id TEXT,
                related_email_internal_id INTEGER,
                last_synced_at REAL NOT NULL,
                deleted_at REAL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                CHECK (source IN ('caldav', 'email_ics', 'legacy_calendar_app'))
            )
        """)
        # 唯一约束 (ical_uid, recurrence_id, source) — SQLite UNIQUE 把 NULL 视为
        # 互不相等, 主事件 (recurrence_id IS NULL) 会绕过去重. 改用 COALESCE 空串
        # 让 NULL 也参与去重. Repository upsert 走 ON CONFLICT(ical_uid, COALESCE(...))
        # 命中此 index.
        cursor.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_event_unique
            ON calendar_event(ical_uid, COALESCE(recurrence_id, ''), source)
        """)
        # 时间窗口查询 (前端日/周/月 view) — partial index 跳过软删除行
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_calendar_event_dtstart
            ON calendar_event(dtstart_utc) WHERE deleted_at IS NULL
        """)
        # ical_uid 反查 (受邀链路 cross-source dedup)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_calendar_event_uid
            ON calendar_event(ical_uid)
        """)
        # Notion mirror 反查 (page_id → event)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_calendar_event_notion
            ON calendar_event(notion_page_id) WHERE notion_page_id IS NOT NULL
        """)
        # 邮件邀请反查 (email_ics source 关联到 internal_id)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_calendar_event_email
            ON calendar_event(related_email_internal_id)
            WHERE related_email_internal_id IS NOT NULL
        """)

        # CalDAV 增量 sync 状态 — 每个 calendar 一行, RFC 6578 sync-token + ctag
        # last_full_sync_at: 全量初始化时间戳 (worker 启动一次)
        # last_incremental_sync_at: 增量 tick 时间戳 (每轮 60s)
        # sync_token: RFC 6578 sync-collection token, 失败降级到 ctag 重读窗口
        # ctag: RFC 4791 calendar collection tag, 整库变更检测 (省 sync-token call)
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS calendar_sync_state (
                calendar_name TEXT PRIMARY KEY,
                ctag TEXT,
                sync_token TEXT,
                last_full_sync_at REAL,
                last_incremental_sync_at REAL,
                last_error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
        """)

        # ==================== v16: 附件文本索引 (PR-2b, Sprint 19 M2) ====================
        # 把 PDF / docx / pptx / xlsx 附件文本抽出 → FTS5 索引, 让 chat agent /
        # LLM tool 跨附件检索 ('合同条款里 redis timeout 提到过吗').
        # 跟 email_body_fts (Phase 3, v5 schema) 平行: contentful FTS5 +
        # 3 trigger 自动 sync, 但走单独表 email_attachment_text + email_attachment_fts.
        # extraction 由 attachment_text worker queue 异步处理 (new_watcher
        # _process_attachment_text_queue), 不阻塞主 sync.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_attachment_text (
                attachment_id INTEGER PRIMARY KEY,
                text_content TEXT,
                text_size_bytes INTEGER NOT NULL DEFAULT 0,
                extractor TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN
                    ('pending', 'extracted', 'failed', 'unsupported')),
                error_message TEXT,
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at REAL,
                extracted_at REAL,
                truncated INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY (attachment_id) REFERENCES email_attachment(id) ON DELETE CASCADE
            )
        """)
        # 状态分布查询 (worker 取 pending) + 失败重试调度
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_att_text_status
            ON email_attachment_text(status)
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_att_text_retry
            ON email_attachment_text(next_retry_at)
            WHERE status IN ('pending', 'failed')
        """)

        # FTS5 standalone 虚表 — bm25 + snippet/highlight, rowid = attachment_id
        # 反查 email_attachment 拼上下文 (filename / email subject / sender / date).
        # 风格跟 email_body_fts (v5) 一致: standalone 模式 (无 content=) — trigger
        # 用 SQL DELETE/INSERT 而非 contentful 的 special 'delete' command. 索引
        # 大小翻倍但简单 + 跟现有 trigger 模式 1:1.
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts USING fts5(
                text_content,
                tokenize='porter unicode61 remove_diacritics 2'
            )
        """)

        # 3 个 trigger 自动 sync email_attachment_text ↔ email_attachment_fts.
        # INSERT trigger: 只在 status='extracted' 且 text_content 非空时入 FTS
        # (pending/failed/unsupported 行不索引).
        # UPDATE trigger: 先删 + 重插, 防 status 翻转 (failed → extracted) 漏入索引.
        # DELETE trigger: CASCADE 链路 (email_metadata DELETE → email_attachment
        # CASCADE → email_attachment_text CASCADE → 这里触发清理 FTS).
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_insert
            AFTER INSERT ON email_attachment_text
            WHEN NEW.status = 'extracted' AND NEW.text_content IS NOT NULL
            BEGIN
                INSERT INTO email_attachment_fts(rowid, text_content)
                VALUES (NEW.attachment_id, NEW.text_content);
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_update
            AFTER UPDATE ON email_attachment_text
            BEGIN
                DELETE FROM email_attachment_fts WHERE rowid = OLD.attachment_id;
                INSERT INTO email_attachment_fts(rowid, text_content)
                SELECT NEW.attachment_id, NEW.text_content
                WHERE NEW.status = 'extracted' AND NEW.text_content IS NOT NULL;
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_delete
            AFTER DELETE ON email_attachment_text
            BEGIN
                DELETE FROM email_attachment_fts WHERE rowid = OLD.attachment_id;
            END
        """)

        # v18: 报告 Agent 系统 —— agent 配置表 + 报告产物表。
        # Python 后端 report_worker 写, Electron main (better-sqlite3) 直读展示。
        # report_agent: 可扩展向全自定义 agent（v1 固定 type=report）。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS report_agent (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL DEFAULT 'report',
                enabled INTEGER NOT NULL DEFAULT 0,
                title TEXT,
                schedule_json TEXT,            -- {"cadence":"daily","hours":[9],"weekday":0,"day_of_month":1}
                window_hours INTEGER,
                prompt TEXT,                   -- NULL = 用内置默认 prompt
                model TEXT,                    -- NULL = 用 config.llm_model 默认
                tools_json TEXT,               -- 预留: agent 可用 tool 白名单
                kos_enrich INTEGER NOT NULL DEFAULT 0,
                trigger_mode TEXT,             -- daily: rolling_24h | natural_day（NULL=rolling_24h）
                timezone TEXT,                 -- IANA 时区（NULL=本地）; 仅 natural_day 用
                body_full_max INTEGER,         -- 遗留(v19 早期)，不再读写；带正文改 body_full_priorities
                body_full_priorities TEXT,     -- daily: JSON 数组 of priority label，命中则带正文（NULL=默认紧急+重要）
                updated_at REAL
            )
        """)
        # report: ReportDoc 块模型 SSoT（blocks_json）+ 列表展示冗余字段。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS report (
                id TEXT PRIMARY KEY,           -- "{agent_id}:{cadence}:{report_date}"
                agent_id TEXT NOT NULL,
                cadence TEXT,
                report_date TEXT,              -- slot 日期 "YYYY-MM-DD"
                window_start TEXT,
                window_end TEXT,
                status TEXT NOT NULL DEFAULT 'generating',  -- generating|ready|failed|skipped|empty
                blocks_json TEXT,              -- ReportDoc SSoT (前端直接渲染)
                counts_json TEXT,
                headline TEXT,                 -- 冗余: 列表展示用 (从 blocks 抽)
                model TEXT,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                cost_usd REAL DEFAULT 0,
                error TEXT,
                created_at REAL,
                generated_at REAL
            )
        """)
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_report_agent_date ON report(agent_id, report_date DESC)"
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS idx_report_created ON report(created_at DESC)"
        )

        # async_jobs (C1): 长任务 (batch resync / backfill) 的统一 enqueue + 执行账本。
        # 与 email_outbox 同构 (sync-engine 队列): serve 进程内 JobWorker 串行 claim
        # (status queued→running 条件 UPDATE, 仿 fanout) + 执行 (复用 LongTaskContext) +
        # 写终态。idempotency_key partial unique → 弱网重发同一 job 不重复起 (返已有 job_id)。
        # checkpoint_internal_id 让 worker 崩溃重启后从断点续跑。不复用 email_outbox
        # (outbox=字段级 merge 幂等 intent; job=带 checkpoint/熔断/进度的过程, 语义不同)。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS async_jobs (
                job_id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_type TEXT NOT NULL,                 -- resync | backfill_body | backfill_derivatives | backfill_metadata
                target_kind TEXT NOT NULL DEFAULT '',   -- range | ids | all (LongTaskContext target_kind)
                target_key TEXT NOT NULL DEFAULT '',     -- '53000-53100' / 'ids:1,2,3' / 'all'
                params_json TEXT NOT NULL DEFAULT '{}',  -- job_type 特定参数 (replace_existing / force / ...)
                status TEXT NOT NULL DEFAULT 'queued',   -- queued|running|succeeded|partial_failure|failed|aborted
                idempotency_key TEXT,                    -- hash(job_type+target+request_id); partial unique 防弱网重发
                progress_done INTEGER NOT NULL DEFAULT 0,
                progress_total INTEGER NOT NULL DEFAULT 0,
                checkpoint_internal_id INTEGER,          -- 最后完成的 unit internal_id (crash resume floor)
                result_json TEXT,                        -- 终态 summary (succeeded/failed/aborted counts)
                last_error TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL
            )
        """)
        cursor.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_async_jobs_idempotency "
            "ON async_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL"
        )
        cursor.execute(
            "CREATE INDEX IF NOT EXISTS ix_async_jobs_status ON async_jobs(status, job_id)"
        )

        # === v19: 旧 v18 库 report_agent 无新列 → ALTER 补。**必须在 seed 前**（下面 seed
        # 引用新列）；新库 CREATE 已含, PRAGMA 检查会跳过。
        if current_version < 19:
            try:
                _ra_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                for _c, _t in (("trigger_mode", "TEXT"), ("timezone", "TEXT"), ("body_full_max", "INTEGER"), ("body_full_priorities", "TEXT")):
                    if _c not in _ra_cols:
                        cursor.execute(f"ALTER TABLE report_agent ADD COLUMN {_c} {_t}")
                logger.info("v19 migration: report_agent +trigger_mode/timezone/body_full_max")
            except sqlite3.OperationalError as e:
                logger.warning(f"v19 migration skipped: {e}")

        # 种子: 日 / 周 / 月报三个独立 agent（enabled=0, prompt=NULL→内置默认）。幂等。
        # daily=rolling_24h 触发 + 预载 15 封正文；周 / 月报走层级聚合（读子报告，无窗口 /
        # 正文配置，trigger_mode/body_full_max 留 NULL）。
        _seed_cols = (
            "(id, type, enabled, title, schedule_json, window_hours, prompt, model, "
            "tools_json, kos_enrich, trigger_mode, timezone, body_full_priorities, updated_at)"
        )
        _seed_now = time.time()
        for _id, _title, _sched, _win, _trig, _bpri in (
            ("daily_email_digest", "邮件日报", '{"cadence": "daily", "hours": [9]}', 24,
             "rolling_24h", '["🔴 紧急", "🟡 重要"]'),
            ("weekly_email_digest", "邮件周报", '{"cadence": "weekly", "hours": [9], "weekday": 0}', 168, None, None),
            ("monthly_email_digest", "邮件月报", '{"cadence": "monthly", "hours": [9], "day_of_month": 1}', 720, None, None),
        ):
            cursor.execute(
                f"INSERT OR IGNORE INTO report_agent {_seed_cols} "
                "VALUES (?, 'report', 0, ?, ?, ?, NULL, 'claude-opus-4-8', NULL, 0, ?, NULL, ?, ?)",
                (_id, _title, _sched, _win, _trig, _bpri, _seed_now),
            )

        # 旧库（v18→v19 升级）daily 行已存在 → 上面 INSERT OR IGNORE 跳过 → ALTER 新列仍 NULL。
        # 补默认（仅当 NULL，幂等自愈，覆盖已升到 v19 的库）：daily 走 rolling_24h + 紧急/重要
        # 带正文；timezone 留 NULL（rolling 不需要，natural_day 时前端兜底本地）。周 / 月报新列
        # NULL 是正确语义（层级聚合无触发模式 / 正文配置），不回填。
        cursor.execute(
            "UPDATE report_agent SET trigger_mode = 'rolling_24h' "
            "WHERE id = 'daily_email_digest' AND trigger_mode IS NULL"
        )
        cursor.execute(
            "UPDATE report_agent SET body_full_priorities = ? "
            "WHERE id = 'daily_email_digest' AND body_full_priorities IS NULL",
            ('["🔴 紧急", "🟡 重要"]',),
        )

        # === v20: email_outbox merge 原子化前置 —— partial unique index ===
        # B1: enqueue 的 read-modify-write merge 换成单条原子 UPSERT
        # (ON CONFLICT(internal_id,op_type,target) WHERE status='pending'
        #  DO UPDATE json_patch)，消「TS write_ops.ts 与 Python outbox.py 两份手抄
        # merge」+ 读-改-写竞态。建唯一索引前必须先合并历史竞态产生的重复 pending
        # 行 (同 key 多条 pending → 否则 CREATE UNIQUE INDEX 失败)。幂等：已迁移库
        # 重跑时无重复行 (索引已挡) → dedup no-op。
        if current_version < 20:
            try:
                _dup_groups = cursor.execute(
                    """
                    SELECT internal_id, op_type, target FROM email_outbox
                     WHERE status = 'pending'
                     GROUP BY internal_id, op_type, target HAVING COUNT(*) > 1
                    """
                ).fetchall()
                for _iid, _op, _tgt in _dup_groups:
                    _rows = cursor.execute(
                        """
                        SELECT outbox_id, payload_json FROM email_outbox
                         WHERE internal_id = ? AND op_type = ? AND target = ?
                           AND status = 'pending'
                         ORDER BY outbox_id ASC
                        """,
                        (_iid, _op, _tgt),
                    ).fetchall()
                    # 按 outbox_id 升序合并 payload (后写覆盖同 key)，保留最新 (max
                    # outbox_id) 那行作聚合点 (与运行时 merge 进 latest 语义一致)。
                    _merged: dict = {}
                    for _r in _rows:
                        try:
                            _merged.update(json.loads(_r[1] or "{}"))
                        except json.JSONDecodeError:
                            pass
                    _keep_id = _rows[-1][0]
                    cursor.execute(
                        "UPDATE email_outbox SET payload_json = ? WHERE outbox_id = ?",
                        (
                            json.dumps(
                                _merged, ensure_ascii=False, sort_keys=True,
                                separators=(",", ":"),
                            ),
                            _keep_id,
                        ),
                    )
                    cursor.executemany(
                        "DELETE FROM email_outbox WHERE outbox_id = ?",
                        [(_r[0],) for _r in _rows[:-1]],
                    )
                if _dup_groups:
                    logger.info(
                        f"v20 migration: merged {len(_dup_groups)} duplicate "
                        f"outbox pending group(s) before unique index"
                    )
                cursor.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_pending_intent
                    ON email_outbox(internal_id, op_type, target)
                    WHERE status = 'pending'
                    """
                )
                logger.info("v20 migration: email_outbox partial unique index ready")
            except sqlite3.OperationalError as e:
                logger.warning(f"v20 migration skipped: {e}")

        # === v22: 多文件夹同步 ===
        # per-folder 增量游标 = email_metadata 派生的 MAX(imap_uid) (复用 Sent 模式)；
        # per-folder UIDVALIDITY 存现有 sync_state KV 表 (key=folder_uidvalidity:<imap_name>)，
        # 无需新表/新列 → 本版本是 marker-only bump (记录语义 + 同步前端 EXPECTED_DB_VERSION)。
        # 无结构迁移动作，幂等天然成立。

        # === v23: DROP 旧 folder_sync 三表 (P6 展示链路死代码清理) ===
        # 旧 FolderSyncWorker → folder_email/folder_email_fts/folder_sync_state 展示链路
        # 实测从未工作 (folder_email 0 行)。多文件夹同步走 email_metadata 主链路 (v22)。
        # 幂等: DROP ... IF EXISTS 对有无三表的库均安全。先 DROP 触发器再 DROP 表 (避免
        # AFTER DELETE 触发器在 DROP TABLE 时触碰已不存在的 FTS 影子表)。
        cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_insert")
        cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_delete")
        cursor.execute("DROP TRIGGER IF EXISTS folder_email_fts_update")
        cursor.execute("DROP TABLE IF EXISTS folder_email_fts")
        cursor.execute("DROP TABLE IF EXISTS folder_email")
        cursor.execute("DROP TABLE IF EXISTS folder_sync_state")

        # 更新数据库版本
        cursor.execute("""
            INSERT OR REPLACE INTO sync_state (key, value, updated_at)
            VALUES ('db_version', ?, ?)
        """, (str(self.DB_VERSION), time.time()))

        conn.commit()
        conn.close()
        logger.debug(f"Database tables initialized (v{self.DB_VERSION})")

    # ==================== 同步状态操作 ====================

    def get_state(self, key: str) -> Optional[str]:
        """获取同步状态值

        Args:
            key: 状态键名

        Returns:
            状态值，不存在返回 None
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT value FROM sync_state WHERE key = ?",
                    (key,)
                )
                row = cursor.fetchone()
                return row['value'] if row else None

            except sqlite3.Error as e:
                logger.error(f"Failed to get state {key}: {e}")
                return None

    def set_state(self, key: str, value: str) -> bool:
        """设置同步状态值

        Args:
            key: 状态键名
            value: 状态值

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    INSERT OR REPLACE INTO sync_state (key, value, updated_at)
                    VALUES (?, ?, ?)
                """, (key, value, time.time()))
                conn.commit()
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to set state {key}: {e}")
                conn.rollback()
                return False

    def get_last_max_row_id(self) -> int:
        """获取上次记录的最大 row_id"""
        value = self.get_state('last_max_row_id')
        return int(value) if value else 0

    def set_last_max_row_id(self, row_id: int) -> bool:
        """设置最大 row_id"""
        return self.set_state('last_max_row_id', str(row_id))

    def get_last_sync_time(self) -> Optional[str]:
        """获取上次同步时间（ISO 格式）"""
        return self.get_state('last_sync_time')

    def set_last_sync_time(self, time_str: str) -> bool:
        """设置上次同步时间"""
        return self.set_state('last_sync_time', time_str)

    # ==================== v3 架构：internal_id 操作 ====================

    def get(self, internal_id: int) -> Optional[EmailMetadata]:
        """通过 internal_id 获取邮件元数据

        Args:
            internal_id: 邮件内部 ID (SQLite ROWID = AppleScript id)

        Returns:
            邮件数据字典，不存在返回 None
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata WHERE internal_id = ?
                """, (internal_id,))

                row = cursor.fetchone()
                if row:
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get email by internal_id: {e}")
                return None

    def get_by_message_id(self, message_id: str) -> Optional[EmailMetadata]:
        """通过 message_id 获取邮件元数据

        Args:
            message_id: 邮件 Message-ID (RFC 2822)

        Returns:
            邮件数据字典，不存在返回 None
        """
        if not message_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata WHERE message_id = ?
                """, (message_id,))

                row = cursor.fetchone()
                if row:
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get email by message_id: {e}")
                return None

    def delete(self, internal_id: int) -> bool:
        """通过 internal_id 删除邮件记录

        Args:
            internal_id: 邮件内部 ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "DELETE FROM email_metadata WHERE internal_id = ?",
                    (internal_id,)
                )
                conn.commit()
                logger.debug(f"Deleted email record: internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to delete email: {e}")
                conn.rollback()
                return False

    def update_after_fetch(self, internal_id: int, data: Dict[str, Any]) -> bool:
        """AppleScript 获取成功后更新元数据

        用于 v3 架构：AppleScript 获取成功后，用准确的数据刷新 SyncStore。

        Args:
            internal_id: 邮件内部 ID
            data: 要更新的字段（message_id, subject, sender, date_received, thread_id 等）

        Returns:
            是否成功
        """
        if not data:
            return True

        now = time.time()

        # 构建 SET 子句
        allowed_fields = {
            'message_id', 'thread_id', 'subject', 'sender', 'sender_name',
            'to_addr', 'cc_addr', 'date_received', 'is_read', 'is_flagged',
            'sync_status', 'sync_error',
            'is_important',  # v9 — 邮件原生重要性（reader._parse_importance 提取）
        }
        set_parts = []
        values = []

        for key, value in data.items():
            if key in allowed_fields:
                set_parts.append(f"{key} = ?")
                if key in ('is_read', 'is_flagged', 'is_important'):
                    values.append(1 if value else 0)
                else:
                    values.append(value)

        if not set_parts:
            return True

        set_parts.append("updated_at = ?")
        values.append(now)
        values.append(internal_id)

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                query = f"""
                    UPDATE email_metadata
                    SET {', '.join(set_parts)}
                    WHERE internal_id = ?
                """
                cursor.execute(query, values)
                conn.commit()
                logger.debug(f"Updated email after fetch: internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to update after fetch: {e}")
                conn.rollback()
                return False

    def mark_fetch_failed(self, internal_id: int, error: str) -> bool:
        """标记 AppleScript 获取失败

        Args:
            internal_id: 邮件内部 ID
            error: 错误信息

        Returns:
            是否成功
        """
        return self._update_for_retry(internal_id, 'fetch_failed', error)

    def mark_synced_v3(self, internal_id: int, notion_page_id: str, notion_thread_id: str = None) -> bool:
        """标记邮件同步成功（v3 架构，使用 internal_id）

        Args:
            internal_id: 邮件内部 ID
            notion_page_id: Notion 页面 ID
            notion_thread_id: Notion 线程页面 ID（可选）

        Returns:
            是否成功
        """
        now = time.time()

        ok = False
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        notion_page_id = ?,
                        notion_thread_id = ?,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (notion_page_id, notion_thread_id, now, internal_id))

                conn.commit()
                logger.debug(f"Marked synced: internal_id={internal_id}")
                ok = True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced: {e}")
                conn.rollback()
                ok = False

        # Sprint 15 Stage 2: SSE publish (out of transaction, silent on failure)
        if ok:
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.synced",
                    internal_id=internal_id,
                    data={"notion_page_id": notion_page_id},
                    source="new_watcher",
                )
            except Exception:
                pass
        return ok

    def mark_failed_v3(self, internal_id: int, error: str, max_retries: int = 5) -> bool:
        """标记 Notion 同步失败（v3 架构，使用 internal_id）

        Args:
            internal_id: 邮件内部 ID
            error: 错误信息
            max_retries: 最大重试次数

        Returns:
            是否成功
        """
        return self._update_for_retry(internal_id, 'failed', error, max_retries)

    def mark_skipped(self, internal_id: int) -> bool:
        """标记邮件为跳过状态（因日期过滤等原因不同步到 Notion）

        Args:
            internal_id: 邮件内部 ID

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'skipped',
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (now, internal_id))

                conn.commit()
                logger.debug(f"Marked skipped: internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark skipped: {e}")
                conn.rollback()
                return False

    # ==================== v8: 置顶 / pin ====================

    def get_pin(self, internal_id: int) -> bool:
        """读取邮件置顶状态（不存在视为未置顶，返回 False）。"""
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                return bool(row['is_pinned'])
            except sqlite3.Error as e:
                logger.error(f"Failed to get pin state for {internal_id}: {e}")
                return False

    def set_pin(self, internal_id: int, pinned: bool) -> bool:
        """设置邮件置顶状态。

        Args:
            internal_id: 邮件内部 ID
            pinned: 是否置顶；True → is_pinned=1 + pinned_at=now，False → 清零

        Returns:
            True 表示状态从 ``not pinned`` ↔ ``pinned`` 真的翻转过；
            False 表示状态未变化（idempotent no-op）或邮件不存在 / SQL 错误。
            邮件不存在时直接 False（caller 自行决定是否抛 NotFound，
            可结合 ``self.get(internal_id) is None`` 区分）。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                current = bool(row['is_pinned'])
                target = bool(pinned)
                if current == target:
                    return False  # no-op，让 caller 区分 changed/unchanged
                now = time.time()
                conn.execute(
                    """UPDATE email_metadata
                          SET is_pinned = ?,
                              pinned_at = ?,
                              updated_at = ?
                        WHERE internal_id = ?""",
                    (
                        1 if target else 0,
                        now if target else None,
                        now,
                        internal_id,
                    ),
                )
                conn.commit()
                logger.debug(
                    f"set_pin: internal_id={internal_id} pinned={target}"
                )
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to set pin for {internal_id}: {e}")
                conn.rollback()
                return False

    def update_mailbox(self, internal_id: int, mailbox: str) -> bool:
        """改邮件所属 mailbox (收件箱归档场景: 收件箱 → 存档)。

        归档把邮件 IMAP MOVE 到 Archive 文件夹后, 调本方法把 email_metadata.mailbox
        改成目标值; 列表查询按 mailbox 过滤 (见 query_emails), 改后该邮件即不再出现在
        收件箱视图。不删行 (保 v4 body/附件 SSoT + Notion 镜像引用)。

        Returns: True=更新成功且值有变; False=邮件不存在 / 值未变 / SQL 错误。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT mailbox FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return False
                if (row['mailbox'] or "") == mailbox:
                    return False
                conn.execute(
                    "UPDATE email_metadata SET mailbox = ?, updated_at = ? WHERE internal_id = ?",
                    (mailbox, time.time(), internal_id),
                )
                conn.commit()
                logger.info(f"update_mailbox: internal_id={internal_id} → {mailbox!r}")
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to update mailbox for {internal_id}: {e}")
                conn.rollback()
                return False

    def toggle_pin(self, internal_id: int) -> Optional[bool]:
        """翻转置顶状态。

        Returns:
            新的置顶状态（True / False）；邮件不存在返回 None。
        """
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return None
                new_state = not bool(row['is_pinned'])
            except sqlite3.Error as e:
                logger.error(
                    f"Failed to read pin for toggle on {internal_id}: {e}"
                )
                return None
        # 走同一份 set_pin 逻辑，确保 pinned_at + updated_at 时间戳一致
        self.set_pin(internal_id, new_state)
        return new_state

    def get_pinned_at(self, internal_id: int) -> Optional[float]:
        """读取置顶时间戳（未置顶 / 不存在 → None）。"""
        with self._connection() as conn:
            try:
                row = conn.execute(
                    "SELECT pinned_at FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if row is None:
                    return None
                return row['pinned_at']
            except sqlite3.Error as e:
                logger.error(f"Failed to get pinned_at for {internal_id}: {e}")
                return None

    def _update_for_retry(
        self,
        internal_id: int,
        status: str,
        error: str,
        max_retries: int = 5
    ) -> bool:
        """更新重试状态（统一逻辑）

        Args:
            internal_id: 邮件内部 ID
            status: 目标状态 ('fetch_failed' 或 'failed')
            error: 错误信息
            max_retries: 最大重试次数

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 获取当前重试次数 + mailbox（用于死信降级判断）
                cursor.execute(
                    "SELECT retry_count, mailbox FROM email_metadata WHERE internal_id = ?",
                    (internal_id,)
                )
                row = cursor.fetchone()
                current_retry = (row['retry_count'] if row else 0) + 1
                mailbox = row['mailbox'] if row else None

                # 检查是否达到最大重试次数
                if current_retry >= max_retries:
                    # 发件箱 fetch_failed 用尽：邮件已被 Mail.app 移走/索引失效，
                    # 业务上发件箱漏一封不致命，降级为 skipped，避免污染死信告警
                    if status == 'fetch_failed' and mailbox == '发件箱':
                        cursor.execute("""
                            UPDATE email_metadata
                            SET sync_status = 'skipped',
                                sync_error = ?,
                                retry_count = ?,
                                next_retry_at = NULL,
                                updated_at = ?
                            WHERE internal_id = ?
                        """, (f"Skipped (sent box unreachable): {error}", current_retry, now, internal_id))
                        conn.commit()
                        logger.warning(
                            f"Marked sent-box email as skipped after {current_retry} fetch attempts: "
                            f"internal_id={internal_id}"
                        )
                        return True

                    cursor.execute("""
                        UPDATE email_metadata
                        SET sync_status = 'dead_letter',
                            sync_error = ?,
                            retry_count = ?,
                            next_retry_at = NULL,
                            updated_at = ?
                        WHERE internal_id = ?
                    """, (f"Max retries exceeded: {error}", current_retry, now, internal_id))

                    conn.commit()
                    logger.warning(f"Marked as dead_letter: internal_id={internal_id}")
                    # Sprint 15 Stage 2: SSE publish
                    try:
                        from src.events.publisher import safe_publish
                        safe_publish(
                            "email.dead_letter",
                            internal_id=internal_id,
                            data={"retry_count": current_retry, "error": (error or "")[:200]},
                            source="sync_store",
                        )
                    except Exception:
                        pass
                    return True

                # 计算下次重试时间（指数退避：1min, 5min, 15min, 1h, 2h）
                delays = [60, 300, 900, 3600, 7200]
                delay = delays[min(current_retry - 1, len(delays) - 1)]
                next_retry = now + delay

                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = ?,
                        sync_error = ?,
                        retry_count = ?,
                        next_retry_at = ?,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (status, error, current_retry, next_retry, now, internal_id))

                conn.commit()
                logger.warning(f"Marked {status}: internal_id={internal_id}, retry #{current_retry} in {delay}s")
                # Sprint 15 Stage 2: SSE publish
                try:
                    from src.events.publisher import safe_publish
                    safe_publish(
                        "email.failed",
                        internal_id=internal_id,
                        data={
                            "status": status,
                            "retry_count": current_retry,
                            "next_retry_at": next_retry,
                            "error": (error or "")[:200],
                        },
                        source="sync_store",
                    )
                except Exception:
                    pass
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to update for retry: {e}")
                conn.rollback()
                return False

    # ==================== 邮件元数据操作（兼容旧 API） ====================

    def save_email(self, email: Dict[str, Any]) -> bool:
        """保存单个邮件元数据

        支持两种模式：
        1. v3 架构：必须包含 internal_id
        2. 兼容模式：只包含 message_id（用于旧代码）

        Args:
            email: 邮件数据字典

        Returns:
            是否成功
        """
        internal_id = email.get('internal_id')
        message_id = email.get('message_id')

        # v3 架构：使用 internal_id 作为主键
        if internal_id is not None:
            return self._save_email_v3(email)

        # 兼容模式：使用 message_id（生成临时 internal_id）
        if message_id:
            return self._save_email_compat(email)

        logger.warning("Cannot save email without internal_id or message_id")
        return False

    def _save_email_v3(self, email: Dict[str, Any]) -> bool:
        """v3 架构保存邮件（internal_id 为主键）.

        v13 新增字段 (向后兼容, 老调用方不传 = 默认值):
            imap_uidvalidity / imap_uid: DavMail backend 必填; AppleScript 留 None
            backend_origin: 'applescript' (default) | 'davmail' — 标记 internal_id 是谁生成的

        ## Cross-backend merge protection (Sprint 16 dual-backend cutover 安全网)

        触发场景: backend 切换后, 同一封邮件可能被两个 backend 各看到一次 (e.g. 切到
        davmail 后, davmail 抓到该邮件分配了 >=10^9 的新 internal_id; 而该邮件的
        message_id 已经在 applescript 时代写过 row=小 ROWID). 老逻辑用 ``INSERT OR
        REPLACE`` → message_id UNIQUE 约束 → 老 row 整行被删 → ``notion_page_id``
        / ``sync_status='synced'`` / ``thread_id`` 等同步状态全丢, Notion 端孤儿.

        修复策略: 写入前 SELECT 同 message_id 的 row, 如果存在但 internal_id 不同 →
        UPDATE 老 row 的 backend-related 字段 (imap_uid / imap_uidvalidity 等), 保留
        notion_page_id / sync_status / thread_id / notion_thread_id 不动. 新分配的
        internal_id 浪费 (sequence 不回收, 但无害).

        SQLite SSoT 视角: internal_id 仅是邮件代号, 长度不同代表 origin 不同, 不影响
        message_id 这个对外唯一标识 — 一封 message_id 在 sync_store 只能有一条记录.
        """
        internal_id = email['internal_id']
        message_id = email.get('message_id')
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # === Cross-backend merge guard ===
                # 仅在 message_id 非空时检查 (None 不会触发 UNIQUE 冲突, 是 v3 pending 邮件).
                if message_id:
                    existing = cursor.execute(
                        "SELECT internal_id, sync_status, notion_page_id, "
                        "notion_thread_id, thread_id, backend_origin "
                        "FROM email_metadata WHERE message_id = ?",
                        (message_id,),
                    ).fetchone()
                    if existing is not None and existing['internal_id'] != internal_id:
                        # 跨 backend 切换产生的 dup. UPDATE 老 row 的 davmail 字段,
                        # 保留同步状态.
                        old_iid = existing['internal_id']
                        old_origin = existing['backend_origin']
                        new_origin = email.get('backend_origin', 'applescript')
                        logger.info(
                            f"[sync_store] cross-backend merge: message_id={message_id[:40]!r} "
                            f"already at internal_id={old_iid} (origin={old_origin!r}); "
                            f"merging new internal_id={internal_id} (origin={new_origin!r}) "
                            f"— keep notion_page_id/sync_status, update imap_uid"
                        )
                        cursor.execute(
                            """UPDATE email_metadata
                               SET imap_uid = COALESCE(?, imap_uid),
                                   imap_uidvalidity = COALESCE(?, imap_uidvalidity),
                                   thread_id = COALESCE(thread_id, ?),
                                   sender_name = COALESCE(NULLIF(sender_name, ''), ?),
                                   to_addr = COALESCE(NULLIF(to_addr, ''), ?),
                                   cc_addr = COALESCE(NULLIF(cc_addr, ''), ?),
                                   updated_at = ?
                               WHERE internal_id = ?""",
                            (
                                email.get('imap_uid'),
                                email.get('imap_uidvalidity'),
                                email.get('thread_id'),
                                email.get('sender_name', ''),
                                email.get('to_addr', ''),
                                email.get('cc_addr', ''),
                                now,
                                old_iid,
                            ),
                        )
                        conn.commit()
                        return True

                # === 正常路径: 全新 row 或 internal_id 已存在 (同 backend 内重复触发) ===
                cursor.execute("""
                    INSERT OR REPLACE INTO email_metadata
                    (internal_id, message_id, thread_id, subject, sender, sender_name,
                     to_addr, cc_addr, date_received, mailbox,
                     is_read, is_flagged, sync_status, notion_page_id,
                     notion_thread_id, sync_error, retry_count, next_retry_at,
                     imap_uidvalidity, imap_uid, backend_origin,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?, ?, ?,
                            COALESCE((SELECT created_at FROM email_metadata WHERE internal_id = ?), ?),
                            ?)
                """, (
                    internal_id,
                    email.get('message_id'),
                    email.get('thread_id'),
                    email.get('subject', ''),
                    email.get('sender', ''),
                    email.get('sender_name', ''),
                    email.get('to_addr', ''),
                    email.get('cc_addr', ''),
                    _normalize_date_received_iso(email.get('date_received', '')) or '',
                    email.get('mailbox', '收件箱'),
                    1 if email.get('is_read') else 0,
                    1 if email.get('is_flagged') else 0,
                    email.get('sync_status', 'pending'),
                    email.get('notion_page_id'),
                    email.get('notion_thread_id'),
                    email.get('sync_error'),
                    email.get('retry_count', 0),
                    email.get('next_retry_at'),
                    email.get('imap_uidvalidity'),
                    email.get('imap_uid'),
                    email.get('backend_origin', 'applescript'),
                    internal_id,
                    now,
                    now
                ))

                conn.commit()
                logger.debug(f"Saved email (v3): internal_id={internal_id}")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to save email (v3): {e}")
                conn.rollback()
                return False

    def allocate_davmail_internal_id(self) -> int:
        """Atomic 分配下一个 davmail internal_id (起点 1_000_000_000).

        v13: DavMail backend 抓新邮件时调用, 拿到 ID 后传给 save_email(backend_origin='davmail').
        SQLite INTEGER PRIMARY KEY 不能 ALTER 成 AUTOINCREMENT, 用 sync_state KV 维护序列.
        BEGIN IMMEDIATE 锁住 sync_state 行避免并发冲突.

        Returns:
            下一个可用的 internal_id (>= 1_000_000_000).
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                cursor.execute(
                    "SELECT value FROM sync_state WHERE key = 'davmail_next_internal_id'"
                )
                row = cursor.fetchone()
                next_id = int(row['value']) if row else 1_000_000_000
                cursor.execute(
                    """UPDATE sync_state SET value = ?, updated_at = ?
                       WHERE key = 'davmail_next_internal_id'""",
                    (str(next_id + 1), time.time()),
                )
                if cursor.rowcount == 0:
                    # 第一次分配, sync_state 还没这一行 (理论上 _init_database 已经 INSERT OR IGNORE)
                    cursor.execute(
                        """INSERT INTO sync_state (key, value, updated_at)
                           VALUES ('davmail_next_internal_id', ?, ?)""",
                        (str(next_id + 1), time.time()),
                    )
                conn.commit()
                return next_id
            except sqlite3.Error as e:
                conn.rollback()
                logger.error(f"allocate_davmail_internal_id failed: {e}")
                raise

    def _save_email_compat(self, email: Dict[str, Any]) -> bool:
        """兼容模式保存邮件（message_id 为主键，生成临时 internal_id）

        用于旧代码兼容，生成负数 internal_id 避免与真实 ID 冲突。
        """
        message_id = email['message_id']
        # 使用 message_id 的 hash 作为临时 internal_id（负数）
        internal_id = -abs(hash(message_id)) % 2147483647

        # 检查是否已存在（通过 message_id）
        existing = self.get_by_message_id(message_id)
        if existing:
            internal_id = existing['internal_id']

        email_with_id = {**email, 'internal_id': internal_id}
        return self._save_email_v3(email_with_id)

    def save_emails_batch(self, emails: List[Dict[str, Any]]) -> int:
        """批量保存邮件元数据

        使用 executemany() 优化批量插入性能。

        Args:
            emails: 邮件列表

        Returns:
            成功保存的数量
        """
        if not emails:
            return 0

        now = time.time()

        # 准备批量数据
        batch_data = []
        for email in emails:
            internal_id = email.get('internal_id')
            message_id = email.get('message_id')

            # v3 架构
            if internal_id is not None:
                pass
            # 兼容模式
            elif message_id:
                internal_id = -abs(hash(message_id)) % 2147483647
            else:
                continue

            batch_data.append((
                internal_id,
                email.get('message_id'),
                email.get('thread_id'),
                email.get('subject', ''),
                email.get('sender', ''),
                email.get('sender_name', ''),
                email.get('to_addr', ''),
                email.get('cc_addr', ''),
                email.get('date_received', ''),
                email.get('mailbox', '收件箱'),
                1 if email.get('is_read') else 0,
                1 if email.get('is_flagged') else 0,
                email.get('sync_status', 'pending'),
                email.get('notion_page_id'),
                email.get('notion_thread_id'),
                email.get('sync_error'),
                email.get('retry_count', 0),
                email.get('next_retry_at'),
                internal_id,  # for COALESCE created_at
                now,
                now
            ))

        if not batch_data:
            return 0

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.executemany("""
                    INSERT OR REPLACE INTO email_metadata
                    (internal_id, message_id, thread_id, subject, sender, sender_name,
                     to_addr, cc_addr, date_received, mailbox,
                     is_read, is_flagged, sync_status, notion_page_id,
                     notion_thread_id, sync_error, retry_count, next_retry_at,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            COALESCE((SELECT created_at FROM email_metadata WHERE internal_id = ?), ?),
                            ?)
                """, batch_data)

                conn.commit()
                saved_count = len(batch_data)
                logger.info(f"Saved {saved_count} emails to database (batch)")
                return saved_count

            except sqlite3.Error as e:
                logger.error(f"Failed to save emails batch: {e}")
                conn.rollback()
                return 0

    def get_email(self, message_id: str) -> Optional[EmailMetadata]:
        """获取单个邮件元数据（兼容旧 API）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            邮件数据字典，不存在返回 None
        """
        return self.get_by_message_id(message_id)

    def get_earliest_email_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> Optional[EmailMetadata]:
        """[已废弃] 查找同一线程中最早的邮件

        新架构使用 get_latest_email_by_thread_id() 替代。
        保留此方法用于向后兼容。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            最早邮件的元数据字典，不存在返回 None
        """
        if not thread_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if exclude_message_id:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ? AND message_id != ?
                        ORDER BY date_received ASC
                        LIMIT 1
                    """, (thread_id, exclude_message_id))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ?
                        ORDER BY date_received ASC
                        LIMIT 1
                    """, (thread_id,))

                row = cursor.fetchone()
                if row:
                    logger.debug(f"Found earliest email in thread: {thread_id[:30]}...")
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get earliest email by thread_id: {e}")
                return None

    def get_latest_email_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None
    ) -> Optional[EmailMetadata]:
        """查找同一线程中最新的邮件

        用于新架构的 Parent Item 关联：最新邮件作为母节点，
        其他邮件的 Parent Item 指向最新邮件。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）

        Returns:
            最新邮件的元数据字典，不存在返回 None
        """
        if not thread_id:
            return None

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if exclude_message_id:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ? AND message_id != ?
                        ORDER BY date_received DESC
                        LIMIT 1
                    """, (thread_id, exclude_message_id))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE thread_id = ?
                        ORDER BY date_received DESC
                        LIMIT 1
                    """, (thread_id,))

                row = cursor.fetchone()
                if row:
                    logger.debug(f"Found latest email in thread: {thread_id[:30]}...")
                    return dict(row)
                return None

            except sqlite3.Error as e:
                logger.error(f"Failed to get latest email by thread_id: {e}")
                return None

    def get_all_emails_by_thread_id(
        self,
        thread_id: str,
        exclude_message_id: str = None,
        synced_only: bool = False
    ) -> List[EmailMetadata]:
        """获取同一线程中的所有邮件

        用于新架构的 Parent Item 批量重建：找到线程中所有邮件，
        以便设置最新邮件的 Sub-item。

        Args:
            thread_id: 线程标识
            exclude_message_id: 排除的 message_id（当前正在同步的邮件）
            synced_only: 是否只返回已同步的邮件

        Returns:
            邮件元数据列表，按日期降序排序（最新在前）
        """
        if not thread_id:
            return []

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                conditions = ["thread_id = ?"]
                params: List[Any] = [thread_id]

                if exclude_message_id:
                    conditions.append("message_id != ?")
                    params.append(exclude_message_id)

                if synced_only:
                    conditions.append("sync_status = 'synced'")

                where_clause = " AND ".join(conditions)

                cursor.execute(f"""
                    SELECT * FROM email_metadata
                    WHERE {where_clause}
                    ORDER BY date_received DESC
                """, params)

                rows = cursor.fetchall()
                result = [dict(row) for row in rows]
                logger.debug(f"Found {len(result)} emails in thread: {thread_id[:30]}...")
                return result

            except sqlite3.Error as e:
                logger.error(f"Failed to get all emails by thread_id: {e}")
                return []

    def email_exists(self, message_id: str) -> bool:
        """检查邮件是否存在

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否存在
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT 1 FROM email_metadata WHERE message_id = ?",
                    (message_id,)
                )
                return cursor.fetchone() is not None

            except sqlite3.Error as e:
                logger.error(f"Failed to check email exists: {e}")
                return False

    def get_all_message_ids(self) -> Set[str]:
        """获取所有已保存的 message_id

        注意：对于大型数据库，考虑使用 iter_message_ids() 迭代器版本。

        Returns:
            message_id 集合
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL")
                return {row['message_id'] for row in cursor.fetchall()}

            except sqlite3.Error as e:
                logger.error(f"Failed to get all message_ids: {e}")
                return set()

    def iter_message_ids(self, batch_size: int = 10000) -> Iterator[str]:
        """迭代获取所有 message_id（内存友好）

        使用分页查询避免大数据集时的内存问题。

        Args:
            batch_size: 每批次获取的数量

        Yields:
            message_id 字符串
        """
        offset = 0
        with self._connection() as conn:
            cursor = conn.cursor()

            while True:
                try:
                    cursor.execute(
                        "SELECT message_id FROM email_metadata WHERE message_id IS NOT NULL LIMIT ? OFFSET ?",
                        (batch_size, offset)
                    )
                    rows = cursor.fetchall()

                    if not rows:
                        break

                    for row in rows:
                        yield row['message_id']

                    if len(rows) < batch_size:
                        break

                    offset += batch_size

                except sqlite3.Error as e:
                    logger.error(f"Failed to iterate message_ids: {e}")
                    break

    def get_synced_message_ids(self) -> Set[str]:
        """获取所有已同步的 message_id

        Returns:
            message_id 集合
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "SELECT message_id FROM email_metadata WHERE sync_status = 'synced' AND message_id IS NOT NULL"
                )
                return {row['message_id'] for row in cursor.fetchall()}

            except sqlite3.Error as e:
                logger.error(f"Failed to get synced message_ids: {e}")
                return set()

    def get_pending_emails(
        self,
        limit: int = 100,
        since_date: str = None
    ) -> List[EmailMetadata]:
        """获取待同步的邮件

        Args:
            limit: 最大返回数量
            since_date: 只返回此日期之后的邮件（格式: YYYY-MM-DD）

        Returns:
            邮件列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if since_date:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE sync_status = 'pending'
                          AND date_received >= ?
                        ORDER BY date_received DESC
                        LIMIT ?
                    """, (since_date, limit))
                else:
                    cursor.execute("""
                        SELECT * FROM email_metadata
                        WHERE sync_status = 'pending'
                        ORDER BY date_received DESC
                        LIMIT ?
                    """, (limit,))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get pending emails: {e}")
                return []

    def get_emails_by_status(
        self,
        status: str,
        limit: int = 100
    ) -> List[EmailMetadata]:
        """按状态获取邮件

        Args:
            status: 同步状态 (pending/fetch_failed/synced/failed/skipped/dead_letter)
            limit: 最大返回数量

        Returns:
            邮件列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata
                    WHERE sync_status = ?
                    ORDER BY date_received DESC
                    LIMIT ?
                """, (status, limit))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get emails by status: {e}")
                return []

    def mark_synced(
        self,
        message_id: str,
        notion_page_id: str,
        notion_thread_id: str = None
    ) -> bool:
        """标记邮件同步成功（兼容旧 API，使用 message_id）

        Args:
            message_id: 邮件 Message-ID
            notion_page_id: Notion 页面 ID
            notion_thread_id: Notion 线程页面 ID（可选）

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        notion_page_id = ?,
                        notion_thread_id = ?,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ?
                """, (notion_page_id, notion_thread_id, time.time(), message_id))

                conn.commit()
                logger.debug(f"Marked synced: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced: {e}")
                conn.rollback()
                return False

    def mark_pending(self, message_id: str) -> bool:
        """重置邮件状态为待同步（用于重新同步场景）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'pending',
                        notion_page_id = NULL,
                        notion_thread_id = NULL,
                        sync_error = NULL,
                        retry_count = 0,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ?
                """, (time.time(), message_id))

                conn.commit()
                logger.debug(f"Marked pending: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark pending: {e}")
                conn.rollback()
                return False

    def delete_email(self, message_id: str) -> bool:
        """删除邮件记录（兼容旧 API，使用 message_id）

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute(
                    "DELETE FROM email_metadata WHERE message_id = ?",
                    (message_id,)
                )
                conn.commit()
                logger.debug(f"Deleted email record: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to delete email: {e}")
                conn.rollback()
                return False

    def mark_failed(
        self,
        message_id: str,
        error_message: str,
        max_retries: int = 5
    ) -> bool:
        """标记邮件同步失败（兼容旧 API，使用 message_id）

        当重试次数达到 max_retries 时，自动标记为 dead_letter 状态。

        Args:
            message_id: 邮件 Message-ID
            error_message: 错误信息
            max_retries: 最大重试次数，默认 5

        Returns:
            是否成功
        """
        # 先获取 internal_id
        email = self.get_by_message_id(message_id)
        if not email:
            logger.warning(f"Email not found for mark_failed: {message_id[:50]}...")
            return False

        internal_id = email['internal_id']
        return self._update_for_retry(internal_id, 'failed', error_message, max_retries)

    def update_thread_id(
        self,
        message_id: str,
        thread_id: str
    ) -> bool:
        """更新邮件的 thread_id

        Args:
            message_id: 邮件 Message-ID
            thread_id: 新的 Thread ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET thread_id = ?, updated_at = ?
                    WHERE message_id = ?
                """, (thread_id, time.time(), message_id))

                conn.commit()
                return cursor.rowcount > 0

            except sqlite3.Error as e:
                logger.error(f"Failed to update thread_id: {e}")
                conn.rollback()
                return False

    # ==================== 失败重试队列操作（v3 架构统一在 email_metadata） ====================

    def get_ready_for_retry(self, limit: int = 10) -> List[EmailMetadata]:
        """获取可以重试的失败邮件

        v3 架构：统一查询 fetch_failed 和 failed 状态的邮件。

        Args:
            limit: 最大返回数量

        Returns:
            邮件列表（包含 internal_id）
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT * FROM email_metadata
                    WHERE sync_status IN ('fetch_failed', 'failed')
                      AND next_retry_at IS NOT NULL
                      AND next_retry_at <= ?
                    ORDER BY next_retry_at ASC
                    LIMIT ?
                """, (now, limit))

                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get ready for retry: {e}")
                return []

    def get_failure_count(self) -> int:
        """获取失败队列数量（fetch_failed + failed）"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT COUNT(*) FROM email_metadata
                    WHERE sync_status IN ('fetch_failed', 'failed')
                """)
                return cursor.fetchone()[0]

            except sqlite3.Error as e:
                logger.error(f"Failed to get failure count: {e}")
                return 0

    # ==================== 统计和维护 ====================

    def get_synced_flags(self, internal_ids: List[int]) -> Dict[int, Dict]:
        """批量获取已同步邮件的存储 flags 和 notion_page_id

        Args:
            internal_ids: 要查询的 internal_id 列表

        Returns:
            {internal_id: {'is_read': bool, 'is_flagged': bool, 'notion_page_id': str}}
        """
        if not internal_ids:
            return {}

        result = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            # 分批查询避免 SQL 参数过多
            batch_size = 500
            for i in range(0, len(internal_ids), batch_size):
                batch = internal_ids[i:i + batch_size]
                placeholders = ','.join('?' * len(batch))
                cursor.execute(f"""
                    SELECT internal_id, is_read, is_flagged, notion_page_id
                    FROM email_metadata
                    WHERE internal_id IN ({placeholders})
                      AND sync_status = 'synced'
                      AND notion_page_id IS NOT NULL
                """, batch)
                for row in cursor.fetchall():
                    result[row[0]] = {
                        'is_read': bool(row[1]),
                        'is_flagged': bool(row[2]),
                        'notion_page_id': row[3],
                    }
        return result

    def get_all_synced_flags(self) -> Dict[int, Dict]:
        """获取所有已同步邮件的存储 flags（不限数量，用于全量 flag 检测）"""
        result = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT internal_id, is_read, is_flagged, notion_page_id
                FROM email_metadata
                WHERE sync_status = 'synced'
                  AND notion_page_id IS NOT NULL
            """)
            for row in cursor.fetchall():
                result[row[0]] = {
                    'is_read': bool(row[1]),
                    'is_flagged': bool(row[2]),
                    'notion_page_id': row[3],
                }
        return result

    def update_local_flags(
        self,
        internal_id: int,
        is_read: bool,
        is_flagged: bool,
        processing_status: Optional[str] = None,
    ):
        """更新本地存储的 read/flagged 状态（不触发 Notion 同步）

        Sprint 15 D 块: processing_status 也镜像到 SQLite, 让前端 listEnriched
        能立即读到 done 状态 (processing_status='已完成'), 不等 Notion fanout.

        Args:
            internal_id: 邮件 internal_id
            is_read: 新的已读状态
            is_flagged: 新的旗标状态
            processing_status: 新的 Notion Processing Status 镜像值. None 表示不动
                (e.g. 只改 flag 不改 status 的场景). 空串 '' 视为清空.
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            if processing_status is None:
                cursor.execute("""
                    UPDATE email_metadata
                    SET is_read = ?, is_flagged = ?, updated_at = ?
                    WHERE internal_id = ?
                """, (1 if is_read else 0, 1 if is_flagged else 0, time.time(), internal_id))
            else:
                cursor.execute("""
                    UPDATE email_metadata
                    SET is_read = ?, is_flagged = ?, processing_status = ?, updated_at = ?
                    WHERE internal_id = ?
                """, (
                    1 if is_read else 0,
                    1 if is_flagged else 0,
                    processing_status,
                    time.time(),
                    internal_id,
                ))
            conn.commit()

    def update_ai_main_columns(
        self,
        internal_id: int,
        ai_priority: Optional[str] = None,
        ai_action: Optional[str] = None,
    ) -> None:
        """v14: 把 AI 标签镜像到 email_metadata 主表列 (走索引).

        LLMProcessingStore.mark_success / upsert_external_labels 内部调; labels_json
        仍保留全量作 backup. 仅 priority / action_type 进主表 (高频排序过滤).
        其他 AI 字段 (ai_summary / key_points / reply_suggestion_md / category /
        language) 仍走 labels_json json_extract.

        Args:
            ai_priority: 新 priority 值 (None 不动, 空串清空)
            ai_action: 新 action_type 值 (None 不动, 空串清空)
        """
        sets, args = [], []
        if ai_priority is not None:
            sets.append("ai_priority = ?")
            args.append(ai_priority or None)  # 空串 → NULL
        if ai_action is not None:
            sets.append("ai_action = ?")
            args.append(ai_action or None)
        if not sets:
            return
        sets.append("updated_at = ?")
        args.append(time.time())
        args.append(internal_id)
        with self._connection() as conn:
            conn.execute(
                f"UPDATE email_metadata SET {', '.join(sets)} WHERE internal_id = ?",
                args,
            )
            conn.commit()

    def get_stats(self) -> SyncStoreStats:
        """获取同步统计信息"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 邮件统计
                cursor.execute("SELECT COUNT(*) FROM email_metadata")
                total_emails = cursor.fetchone()[0]

                cursor.execute("""
                    SELECT sync_status, COUNT(*) as count
                    FROM email_metadata
                    GROUP BY sync_status
                """)
                status_counts = {row['sync_status']: row['count'] for row in cursor.fetchall()}

                cursor.execute("""
                    SELECT mailbox, COUNT(*) as count
                    FROM email_metadata
                    GROUP BY mailbox
                """)
                mailbox_counts = {row['mailbox']: row['count'] for row in cursor.fetchall()}

                # 失败队列统计（fetch_failed + failed）
                failure_count = status_counts.get('fetch_failed', 0) + status_counts.get('failed', 0)

                # 数据库大小
                db_size = self.db_path.stat().st_size if self.db_path.exists() else 0

                return SyncStoreStats(
                    total_emails=total_emails,
                    by_status=status_counts,
                    by_mailbox=mailbox_counts,
                    pending=status_counts.get('pending', 0),
                    synced=status_counts.get('synced', 0),
                    failed=status_counts.get('failed', 0),
                    fetch_failed=status_counts.get('fetch_failed', 0),
                    dead_letter=status_counts.get('dead_letter', 0),
                    skipped=status_counts.get('skipped', 0),
                    failure_queue=failure_count,
                    last_max_row_id=self.get_last_max_row_id(),
                    last_sync_time=self.get_last_sync_time(),
                    db_size_bytes=db_size,
                    db_size_mb=round(db_size / 1024 / 1024, 2)
                )

            except sqlite3.Error as e:
                logger.error(f"Failed to get stats: {e}")
                return SyncStoreStats()

    def clear_all(self) -> bool:
        """清空所有数据（谨慎使用）"""
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("DELETE FROM email_metadata")
                cursor.execute("DELETE FROM sync_state WHERE key != 'db_version'")
                cursor.execute("DELETE FROM thread_head_cache")
                conn.commit()
                logger.warning("Cleared all data from SyncStore")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to clear all: {e}")
                conn.rollback()
                return False

    def vacuum(self):
        """压缩数据库，回收空间"""
        with self._connection() as conn:
            try:
                conn.execute("VACUUM")
                logger.info("Database vacuumed")
            except sqlite3.Error as e:
                logger.error(f"Failed to vacuum database: {e}")

    # ==================== 线程头缓存操作 ====================

    def mark_thread_head_not_found(self, thread_id: str, note: str = None) -> bool:
        """标记线程头在 Mail.app 中找不到

        用于缓存无法获取的线程头，避免重复请求 Mail.app。

        Args:
            thread_id: 线程头的 message_id
            note: 备注信息

        Returns:
            是否成功
        """
        now = time.time()

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    INSERT OR REPLACE INTO thread_head_cache
                    (thread_id, status, checked_at, note)
                    VALUES (?, 'not_found', ?, ?)
                """, (thread_id, now, note))

                conn.commit()
                logger.debug(f"Marked thread head as not_found: {thread_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to mark thread head not found: {e}")
                conn.rollback()
                return False

    def is_thread_head_not_found(self, thread_id: str) -> bool:
        """检查线程头是否已标记为找不到

        Args:
            thread_id: 线程头的 message_id

        Returns:
            True 如果已标记为 not_found，否则 False
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT 1 FROM thread_head_cache
                    WHERE thread_id = ? AND status = 'not_found'
                """, (thread_id,))
                return cursor.fetchone() is not None

            except sqlite3.Error as e:
                logger.error(f"Failed to check thread head cache: {e}")
                return False

    def get_not_found_thread_heads(self) -> List[Dict[str, Any]]:
        """获取所有标记为找不到的线程头

        Returns:
            线程头列表
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                cursor.execute("""
                    SELECT thread_id, status, checked_at, note
                    FROM thread_head_cache
                    WHERE status = 'not_found'
                """)
                return [dict(row) for row in cursor.fetchall()]

            except sqlite3.Error as e:
                logger.error(f"Failed to get not found thread heads: {e}")
                return []

    def clear_thread_head_cache(self, thread_id: str = None) -> bool:
        """清除线程头缓存

        Args:
            thread_id: 指定线程头，为 None 时清除所有

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                if thread_id:
                    cursor.execute(
                        "DELETE FROM thread_head_cache WHERE thread_id = ?",
                        (thread_id,)
                    )
                else:
                    cursor.execute("DELETE FROM thread_head_cache")

                conn.commit()
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to clear thread head cache: {e}")
                conn.rollback()
                return False

    # ==================== 邮件搜索（query_mail API） ====================

    def search_emails(self, filters: Dict, limit: int = 10, offset: int = 0) -> Dict:
        """搜索邮件元数据

        支持多条件组合查询，用于 query_mail API。

        Args:
            filters: 筛选条件字典，支持的 key：
                - query: 全文模糊搜索（匹配 subject + sender + sender_name）
                - from: 发件人筛选（LIKE 匹配 sender 或 sender_name）
                - subject: 主题筛选（LIKE 匹配）
                - date_from: 起始日期 YYYY-MM-DD
                - date_to: 截止日期 YYYY-MM-DD
                - mailbox: 邮箱名
                - is_flagged: 旗标状态
                - is_read: 已读状态
                - has_notion: 是否已同步到 Notion
            limit: 最大返回数量（上限 50）
            offset: 分页偏移

        Returns:
            {"total": int, "limit": int, "offset": int, "emails": [...]}
        """
        limit = min(limit, 50)
        # R-03: fetched 是死代码状态（无 mark_fetched 写入路径），已从允许列表删除
        conditions = ["sync_status IN ('synced', 'pending')"]
        params: List[Any] = []

        # 全文模糊搜索
        query = filters.get("query")
        if query:
            conditions.append("(subject LIKE ? OR sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{query}%"
            params.extend([like_val, like_val, like_val])

        # 发件人筛选
        from_filter = filters.get("from")
        if from_filter:
            conditions.append("(sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{from_filter}%"
            params.extend([like_val, like_val])

        # 主题筛选
        subject_filter = filters.get("subject")
        if subject_filter:
            conditions.append("subject LIKE ?")
            params.append(f"%{subject_filter}%")

        # 日期范围
        date_from = filters.get("date_from")
        if date_from:
            conditions.append("date_received >= ?")
            params.append(date_from)

        date_to = filters.get("date_to")
        if date_to:
            conditions.append("date_received <= ?")
            params.append(f"{date_to} 23:59:59")

        # 邮箱名
        mailbox = filters.get("mailbox")
        if mailbox:
            conditions.append("mailbox = ?")
            params.append(mailbox)

        # 旗标状态
        is_flagged = filters.get("is_flagged")
        if is_flagged is not None:
            conditions.append("is_flagged = ?")
            params.append(1 if is_flagged else 0)

        # 已读状态
        is_read = filters.get("is_read")
        if is_read is not None:
            conditions.append("is_read = ?")
            params.append(1 if is_read else 0)

        # 是否已同步到 Notion
        has_notion = filters.get("has_notion")
        if has_notion is not None:
            if has_notion:
                conditions.append("notion_page_id IS NOT NULL")
            else:
                conditions.append("notion_page_id IS NULL")

        where_clause = " AND ".join(conditions)

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 查询总数
                cursor.execute(f"SELECT COUNT(*) FROM email_metadata WHERE {where_clause}", params)
                total = cursor.fetchone()[0]

                # 查询数据
                cursor.execute(f"""
                    SELECT internal_id, message_id, subject, sender, sender_name,
                           date_received, mailbox, is_read, is_flagged, notion_page_id
                    FROM email_metadata
                    WHERE {where_clause}
                    ORDER BY date_received DESC
                    LIMIT ? OFFSET ?
                """, params + [limit, offset])

                emails = []
                for row in cursor.fetchall():
                    emails.append({
                        "internal_id": row["internal_id"],
                        "message_id": row["message_id"],
                        "subject": row["subject"],
                        "sender": row["sender"],
                        "sender_name": row["sender_name"],
                        "date_received": row["date_received"],
                        "mailbox": row["mailbox"],
                        "is_read": bool(row["is_read"]),
                        "is_flagged": bool(row["is_flagged"]),
                        "notion_page_id": row["notion_page_id"],
                    })

                return {"total": total, "limit": limit, "offset": offset, "emails": emails}

            except sqlite3.Error as e:
                logger.error(f"Failed to search emails: {e}")
                return {"total": 0, "limit": limit, "offset": offset, "emails": []}

    def get_dead_letter_emails(self, limit: int = 100) -> List[EmailMetadata]:
        """获取死信队列中的邮件（超过最大重试次数的邮件）

        这些邮件需要人工检查处理。

        Args:
            limit: 最大返回数量

        Returns:
            邮件列表
        """
        return self.get_emails_by_status('dead_letter', limit)

    def retry_dead_letter(self, message_id: str) -> bool:
        """将死信邮件重新加入重试队列

        用于人工确认后重新尝试同步。

        Args:
            message_id: 邮件 Message-ID

        Returns:
            是否成功
        """
        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # 重置状态为 pending
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'pending',
                        retry_count = 0,
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE message_id = ? AND sync_status = 'dead_letter'
                """, (time.time(), message_id))

                if cursor.rowcount == 0:
                    logger.warning(f"Email not found or not in dead_letter status: {message_id[:50]}...")
                    return False

                conn.commit()
                logger.info(f"Moved dead_letter email back to pending: {message_id[:50]}...")
                return True

            except sqlite3.Error as e:
                logger.error(f"Failed to retry dead letter: {e}")
                conn.rollback()
                return False

    # ==================== 周期会议系列操作 ====================

    def get_recurring_series(self, series_uid: str) -> Optional[Dict[str, Any]]:
        """读取一条 recurring_series 记录。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT * FROM recurring_series WHERE series_uid = ?",
                    (series_uid,),
                )
                row = cursor.fetchone()
                return dict(row) if row else None
            except sqlite3.Error as e:
                logger.error(f"Failed to get recurring_series {series_uid[:60]}: {e}")
                return None

    def upsert_recurring_series(self, row: Dict[str, Any]) -> bool:
        """写入或更新一条 recurring_series 记录。

        必填: series_uid, rrule_str, master_dtstart, master_dtend
        其他字段 None/missing 视为不更新（但 created_at/updated_at 自动维护）
        """
        required = ("series_uid", "rrule_str", "master_dtstart", "master_dtend")
        for k in required:
            if not row.get(k):
                logger.error(f"upsert_recurring_series missing required field: {k}")
                return False

        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT created_at FROM recurring_series WHERE series_uid = ?",
                    (row["series_uid"],),
                )
                existing = cursor.fetchone()

                payload = {
                    "series_uid": row["series_uid"],
                    "rrule_str": row["rrule_str"],
                    "exdates_json": row.get("exdates_json", "[]"),
                    "rdates_json": row.get("rdates_json", "[]"),
                    "master_dtstart": row["master_dtstart"],
                    "master_dtend": row["master_dtend"],
                    "master_summary": row.get("master_summary"),
                    "master_organizer": row.get("master_organizer"),
                    "master_organizer_email": row.get("master_organizer_email"),
                    "master_location": row.get("master_location"),
                    "master_description": row.get("master_description"),
                    "master_tzid": row.get("master_tzid"),
                    "master_is_all_day": int(bool(row.get("master_is_all_day", False))),
                    "last_sequence": int(row.get("last_sequence", 0)),
                    "last_seen_message_id": row.get("last_seen_message_id"),
                    "last_expanded_until": row.get("last_expanded_until"),
                    "last_modified": row.get("last_modified"),
                    "created_at": existing["created_at"] if existing else now,
                    "updated_at": now,
                }

                cursor.execute(
                    """
                    INSERT INTO recurring_series (
                        series_uid, rrule_str, exdates_json, rdates_json,
                        master_dtstart, master_dtend,
                        master_summary, master_organizer, master_organizer_email,
                        master_location, master_description, master_tzid, master_is_all_day,
                        last_sequence, last_seen_message_id,
                        last_expanded_until, last_modified,
                        created_at, updated_at
                    ) VALUES (
                        :series_uid, :rrule_str, :exdates_json, :rdates_json,
                        :master_dtstart, :master_dtend,
                        :master_summary, :master_organizer, :master_organizer_email,
                        :master_location, :master_description, :master_tzid, :master_is_all_day,
                        :last_sequence, :last_seen_message_id,
                        :last_expanded_until, :last_modified,
                        :created_at, :updated_at
                    )
                    ON CONFLICT(series_uid) DO UPDATE SET
                        rrule_str=excluded.rrule_str,
                        exdates_json=excluded.exdates_json,
                        rdates_json=excluded.rdates_json,
                        master_dtstart=excluded.master_dtstart,
                        master_dtend=excluded.master_dtend,
                        master_summary=excluded.master_summary,
                        master_organizer=excluded.master_organizer,
                        master_organizer_email=excluded.master_organizer_email,
                        master_location=excluded.master_location,
                        master_description=excluded.master_description,
                        master_tzid=excluded.master_tzid,
                        master_is_all_day=excluded.master_is_all_day,
                        last_sequence=excluded.last_sequence,
                        last_seen_message_id=excluded.last_seen_message_id,
                        last_expanded_until=excluded.last_expanded_until,
                        last_modified=excluded.last_modified,
                        updated_at=excluded.updated_at
                    """,
                    payload,
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to upsert recurring_series: {e}")
                conn.rollback()
                return False

    def append_exdate(self, series_uid: str, exdate_iso: str) -> bool:
        """向 exdates_json 追加一个 ISO-8601 时间（去重，原子）。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("BEGIN IMMEDIATE")
                cursor.execute(
                    "SELECT exdates_json FROM recurring_series WHERE series_uid = ?",
                    (series_uid,),
                )
                row = cursor.fetchone()
                if not row:
                    conn.rollback()
                    logger.warning(f"append_exdate: series not found {series_uid[:60]}")
                    return False

                try:
                    existing = json.loads(row["exdates_json"] or "[]")
                except (json.JSONDecodeError, TypeError):
                    existing = []
                if not isinstance(existing, list):
                    existing = []

                if exdate_iso not in existing:
                    existing.append(exdate_iso)

                cursor.execute(
                    "UPDATE recurring_series SET exdates_json = ?, updated_at = ? WHERE series_uid = ?",
                    (json.dumps(existing), time.time(), series_uid),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to append_exdate {series_uid[:60]}: {e}")
                conn.rollback()
                return False

    def update_expanded_until(self, series_uid: str, until_iso: str) -> bool:
        """更新 last_expanded_until 高水位。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "UPDATE recurring_series SET last_expanded_until = ?, updated_at = ? WHERE series_uid = ?",
                    (until_iso, time.time(), series_uid),
                )
                conn.commit()
                return cursor.rowcount > 0
            except sqlite3.Error as e:
                logger.error(f"Failed to update_expanded_until {series_uid[:60]}: {e}")
                conn.rollback()
                return False

    def iter_series_needing_expansion(self, cutoff_iso: str) -> Iterator[Dict[str, Any]]:
        """返回 last_expanded_until < cutoff（或为空）的系列行。

        Args:
            cutoff_iso: ISO-8601 字符串，期望的高水位。低于此的系列需要补展。
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    SELECT * FROM recurring_series
                    WHERE last_expanded_until IS NULL
                       OR last_expanded_until < ?
                    """,
                    (cutoff_iso,),
                )
                for row in cursor.fetchall():
                    yield dict(row)
            except sqlite3.Error as e:
                logger.error(f"Failed to iter_series_needing_expansion: {e}")
                return

    # ============================================================
    # v6: cli_checkpoints (PR-4 长任务 checkpoint / resume)
    # ============================================================

    def upsert_cli_checkpoint(
        self,
        *,
        command: str,
        target_kind: str,
        target_key: str,
        last_completed_internal_id: Optional[int],
        succeeded: int,
        failed: int,
        payload: Optional[Dict[str, Any]] = None,
        aborted_at: Optional[float] = None,
    ) -> None:
        """UPSERT 长任务 checkpoint 行 (PK: command, target_key)."""
        now = time.time()
        payload_json = json.dumps(payload, ensure_ascii=False) if payload else None
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO cli_checkpoints
                    (command, target_kind, target_key, last_completed_internal_id,
                     succeeded, failed, aborted_at, started_at, updated_at, payload)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(command, target_key) DO UPDATE SET
                    target_kind = excluded.target_kind,
                    last_completed_internal_id = excluded.last_completed_internal_id,
                    succeeded = excluded.succeeded,
                    failed = excluded.failed,
                    aborted_at = excluded.aborted_at,
                    updated_at = excluded.updated_at,
                    payload = excluded.payload
                """,
                (
                    command,
                    target_kind,
                    target_key,
                    last_completed_internal_id,
                    int(succeeded),
                    int(failed),
                    aborted_at,
                    now,
                    now,
                    payload_json,
                ),
            )
            conn.commit()

    def get_cli_checkpoint(
        self, command: str, target_key: str
    ) -> Optional[Dict[str, Any]]:
        """读单条 checkpoint, 不存在返回 None."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT command, target_kind, target_key, last_completed_internal_id,
                       succeeded, failed, aborted_at, started_at, updated_at, payload
                  FROM cli_checkpoints
                 WHERE command = ? AND target_key = ?
                """,
                (command, target_key),
            )
            row = cursor.fetchone()
            if not row:
                return None
            return dict(row)

    def delete_cli_checkpoint(self, command: str, target_key: str) -> bool:
        """删 checkpoint (任务完成后清理)."""
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "DELETE FROM cli_checkpoints WHERE command = ? AND target_key = ?",
                (command, target_key),
            )
            conn.commit()
            return cursor.rowcount > 0

    # ============================================================
    # v6: v4_rollout_stats (PR-4 R-06 持久化)
    # ============================================================

    def write_v4_rollout_snapshot(
        self,
        *,
        from_sqlite_hit: int,
        fallback_miss: int,
        fallback_error: int,
        route_latency_p99_ms: float,
        body_miss_internal_ids: Optional[List[int]] = None,
        window_seconds: int = 60,
        flushed_at: Optional[float] = None,
    ) -> int:
        """写一条 v4_rollout 快照, 返回 rowid (id)."""
        ts = flushed_at if flushed_at is not None else time.time()
        ids_json = (
            json.dumps(body_miss_internal_ids, ensure_ascii=False)
            if body_miss_internal_ids else None
        )
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO v4_rollout_stats
                    (flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                     route_latency_p99_ms, body_miss_internal_ids, window_seconds)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ts,
                    int(from_sqlite_hit),
                    int(fallback_miss),
                    int(fallback_error),
                    float(route_latency_p99_ms),
                    ids_json,
                    int(window_seconds),
                ),
            )
            conn.commit()
            return cursor.lastrowid

    def get_latest_v4_rollout(self) -> Optional[Dict[str, Any]]:
        """读最新一条 v4_rollout snapshot, 不存在返回 None.

        body_miss_internal_ids 字段返回 list[int] 而非 JSON 字符串.
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id, flushed_at, from_sqlite_hit, fallback_miss, fallback_error,
                       route_latency_p99_ms, body_miss_internal_ids, window_seconds
                  FROM v4_rollout_stats
                 ORDER BY flushed_at DESC
                 LIMIT 1
                """
            )
            row = cursor.fetchone()
            if not row:
                return None
            out = dict(row)
            raw_ids = out.get("body_miss_internal_ids")
            if raw_ids:
                try:
                    out["body_miss_internal_ids"] = json.loads(raw_ids)
                except (TypeError, ValueError):
                    out["body_miss_internal_ids"] = []
            else:
                out["body_miss_internal_ids"] = []
            return out

    # ==================== Island dispatch 审计 (v7) ====================

    def record_island_dispatch(
        self,
        *,
        event_type: str,
        session_key: str = "",
        dispatched_ok: bool = False,
        response_decision: Optional[str] = None,
        response_latency_ms: int = 0,
        internal_id: Optional[int] = None,
    ) -> Optional[int]:
        """记录一次 ping-island envelope 派发结果（v7 island_dispatch 表）.

        Args:
            event_type: ``MailReceived`` / ``LLMReviewedUrgent`` 等
            session_key: ``mailagent:email:<id>``
            dispatched_ok: socket 是否成功完成 send + recv 流程
            response_decision: 用户在灵动岛点的 option id（仅 expectsResponse=true）
            response_latency_ms: 发出到收到 response 的耗时
            internal_id: 关联邮件，无关事件（如 DeadLetterAccum）传 None

        Returns:
            新插入行的 id；失败返回 None（不抛，调用方 fail-open）
        """
        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    INSERT INTO island_dispatch
                        (sent_at, event_type, session_key, dispatched_ok,
                         response_decision, response_latency_ms, internal_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        time.time(),
                        event_type,
                        session_key or None,
                        1 if dispatched_ok else 0,
                        response_decision,
                        int(response_latency_ms or 0),
                        int(internal_id) if internal_id is not None else None,
                    ),
                )
                conn.commit()
                return cursor.lastrowid
        except sqlite3.Error as e:
            logger.debug(f"record_island_dispatch failed: {e}")
            return None

    def get_island_dispatch_stats(self, days: int = 14) -> Dict[str, Any]:
        """评估指标聚合（最近 N 天，默认 14d）.

        见 ``frontend/ISLAND-PLUGIN.md`` §9 "值得继续维护"四阈值。
        """
        since = time.time() - days * 86400
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN dispatched_ok=1 THEN 1 ELSE 0 END) AS ok,
                    SUM(CASE WHEN response_decision IS NOT NULL THEN 1 ELSE 0 END) AS responded,
                    SUM(CASE WHEN event_type LIKE '%Urgent' OR event_type LIKE '%Reviewed%' THEN 1 ELSE 0 END) AS urgent_or_reviewed
                  FROM island_dispatch
                 WHERE sent_at > ?
                """,
                (since,),
            )
            row = cursor.fetchone() or {}
            total = int(row["total"] or 0)
            ok = int(row["ok"] or 0)
            responded = int(row["responded"] or 0)
            return {
                "days": days,
                "total": total,
                "dispatched_ok": ok,
                "dispatched_ok_rate": (ok / total) if total else 0.0,
                "responded": responded,
                "response_rate": (responded / total) if total else 0.0,
                "urgent_or_reviewed": int(row["urgent_or_reviewed"] or 0),
            }
