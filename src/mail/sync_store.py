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
    * -> (物理删除)  (message_id 撞上已 synced 的真身 = 重复行, 见 update_after_fetch)

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
from enum import Enum
from pathlib import Path
from typing import Dict, List, Optional, Set, Any, Iterator, TypedDict
from loguru import logger

from src.matters.models import (
    MatterActorKind,
    MatterHealth,
    MatterItemKind,
    MatterItemStatus,
    MatterPriority,
    MatterStatus,
    MatterUpdateReviewStatus,
    sql_check_clause,
)


# Draft→Sent 提升判定用的 mailbox label 集合（见 _save_email_v3 cross-backend merge）。
# issue #42 C 案起单源迁至 src/mail/mailbox_semantics.py，此处 re-export 保兼容
# （历史 import 点：services/mail_write.py / new_watcher.py 等）。
from src.mail.mailbox_semantics import (  # noqa: F401  (re-export)
    DRAFT_MAILBOX_LABELS,
    SENT_MAILBOX_LABELS,
    SENT_CANONICAL_LABEL,
    is_sent_mailbox,
)
# 本模块自用（非 re-export）: 内建 mailbox 的列表/计数面一律走变体展开 + IN 谓词。
from src.mail.mailbox_semantics import (
    INBOX_LABEL,
    filter_labels_for_mailbox,
    sql_in_predicate,
)


# ==================== llm_processing DDL 单源 (v37) ====================
# 🔴 唯一权威 DDL —— 两个消费方共用, 改列/索引只动这里:
#   ① SyncStore._init_database_impl (v37 起版本化建表, 首启即建 —— 主路径);
#   ② src/llm_agent/store.py LLMProcessingStore._ensure_schema (幂等双保险,
#      LLM Agent 启用时独立实例化仍自建表)。
# import 方向必须是 llm_agent → mail (runner.py 已依赖 src.mail.*), 反向 import
# 会触发 src/llm_agent/__init__.py 重依赖链 → 循环 import。
LLM_PROCESSING_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS llm_processing (
        internal_id INTEGER PRIMARY KEY,
        notion_page_id TEXT,
        mailbox TEXT,
        status TEXT,
        retry_count INTEGER DEFAULT 0,
        next_retry_at REAL,
        last_error TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        latency_ms INTEGER,
        labels_json TEXT,
        created_at REAL,
        updated_at REAL
    )
"""
LLM_PROCESSING_INDEX_DDLS = (
    "CREATE INDEX IF NOT EXISTS idx_llm_status ON llm_processing(status)",
    "CREATE INDEX IF NOT EXISTS idx_llm_retry "
    "ON llm_processing(next_retry_at) WHERE status='failed'",
)


# ==================== Matters DDL single source (v44) ====================
MATTER_TABLE_DDLS = (
    """CREATE TABLE IF NOT EXISTS matter_seq (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE CHECK (public_id LIKE 'MAT-%'),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT NOT NULL DEFAULT '',
        matter_type TEXT NULL CHECK (matter_type IS NULL OR length(trim(matter_type)) > 0),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
        status TEXT NOT NULL DEFAULT 'inbox' CHECK (status {sql_check_clause(MatterStatus)}),
        health TEXT NOT NULL DEFAULT 'unknown' CHECK (health {sql_check_clause(MatterHealth)}),
        priority TEXT NOT NULL DEFAULT 'p1' CHECK (priority {sql_check_clause(MatterPriority)}),
        owner_id TEXT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        due_at INTEGER NULL,
        waiting_context_json TEXT NULL CHECK (waiting_context_json IS NULL OR json_valid(waiting_context_json)),
        next_attention_at INTEGER NULL,
        attention_reason TEXT NULL,
        last_activity_at INTEGER NULL,
        latest_accepted_update_id INTEGER NULL,
        current_summary TEXT NULL,
        summary_at INTEGER NULL,
        summary_by_kind TEXT NULL CHECK (summary_by_kind IS NULL OR summary_by_kind {sql_check_clause(MatterActorKind)}),
        summary_by_id TEXT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        archived_at INTEGER NULL,
        archived_by_kind TEXT NULL CHECK (archived_by_kind IS NULL OR archived_by_kind {sql_check_clause(MatterActorKind)}),
        archived_by_id TEXT NULL,
        deleted_at INTEGER NULL,
        deleted_by_kind TEXT NULL CHECK (deleted_by_kind IS NULL OR deleted_by_kind {sql_check_clause(MatterActorKind)}),
        deleted_by_id TEXT NULL,
        purge_after INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(latest_accepted_update_id) REFERENCES matter_update(id) ON DELETE SET NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind {sql_check_clause(MatterItemKind)}),
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        description TEXT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NULL CHECK (status IS NULL OR status {sql_check_clause(MatterItemStatus)}),
        priority TEXT NULL CHECK (priority IS NULL OR priority {sql_check_clause(MatterPriority)}),
        owner_kind TEXT NULL CHECK (owner_kind IS NULL OR owner_kind {sql_check_clause(MatterActorKind)}),
        owner_id TEXT NULL,
        waiting_on_stakeholder_id INTEGER NULL,
        due_at INTEGER NULL,
        completed_at INTEGER NULL,
        checklist_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(checklist_json)),
        source_resource_id INTEGER NULL,
        source_locator_json TEXT NULL CHECK (source_locator_json IS NULL OR json_valid(source_locator_json)),
        created_by_kind TEXT NOT NULL CHECK (created_by_kind {sql_check_clause(MatterActorKind)}),
        created_by_id TEXT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        deleted_at INTEGER NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (kind = 'action' OR (
            status IS NULL AND priority IS NULL AND owner_kind IS NULL AND owner_id IS NULL
            AND waiting_on_stakeholder_id IS NULL AND due_at IS NULL AND completed_at IS NULL
            AND checklist_json = '[]'
        ))
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        happened_at INTEGER NOT NULL,
        actor_kind TEXT NOT NULL CHECK (actor_kind {sql_check_clause(MatterActorKind)}),
        actor_id TEXT NULL,
        source TEXT NOT NULL,
        resource_id INTEGER NULL,
        item_id INTEGER NULL REFERENCES matter_item(id) ON DELETE SET NULL,
        update_id INTEGER NULL REFERENCES matter_update(id) ON DELETE SET NULL,
        reverses_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(payload_json)),
        created_at INTEGER NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS matter_update (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id INTEGER NOT NULL REFERENCES matter(id) ON DELETE CASCADE,
        review_status TEXT NOT NULL CHECK (review_status {sql_check_clause(MatterUpdateReviewStatus)}),
        summary TEXT NULL,
        from_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        to_event_id INTEGER NULL REFERENCES matter_event(id) ON DELETE SET NULL,
        anchored_matter_version INTEGER NOT NULL CHECK (anchored_matter_version >= 1),
        official_state_version INTEGER NULL CHECK (official_state_version IS NULL OR official_state_version >= 1),
        original_proposal_json TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(original_proposal_json)),
        reviewed_result_json TEXT NULL CHECK (reviewed_result_json IS NULL OR json_valid(reviewed_result_json)),
        changes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changes_json)),
        accepted_change_ids_json TEXT NULL CHECK (accepted_change_ids_json IS NULL OR json_valid(accepted_change_ids_json)),
        citations_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(citations_json)),
        confidence REAL NULL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        agent_run_id INTEGER NULL,
        is_stale INTEGER NOT NULL DEFAULT 0 CHECK (is_stale IN (0, 1)),
        stale_at INTEGER NULL,
        stale_reason TEXT NULL,
        created_by_kind TEXT NOT NULL CHECK (created_by_kind {sql_check_clause(MatterActorKind)}),
        created_by_id TEXT NULL,
        created_at INTEGER NOT NULL,
        reviewed_at INTEGER NULL,
        reviewed_by_kind TEXT NULL CHECK (reviewed_by_kind IS NULL OR reviewed_by_kind {sql_check_clause(MatterActorKind)}),
        reviewed_by_id TEXT NULL,
        accepted_at INTEGER NULL,
        rejected_at INTEGER NULL,
        review_reason TEXT NULL
    )""",
)

MATTER_INDEX_DDLS = (
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_public_id ON matter(public_id)",
    "CREATE INDEX IF NOT EXISTS idx_matter_live_status ON matter(status, priority, due_at) WHERE deleted_at IS NULL AND archived_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_attention ON matter(next_attention_at) WHERE deleted_at IS NULL AND next_attention_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_archived ON matter(archived_at DESC) WHERE deleted_at IS NULL AND archived_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_trash ON matter(deleted_at DESC) WHERE deleted_at IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_updated ON matter(updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_live ON matter_item(matter_id, kind, position, id) WHERE deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_action_status ON matter_item(matter_id, status, due_at) WHERE kind='action' AND deleted_at IS NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_item_source ON matter_item(source_resource_id) WHERE source_resource_id IS NOT NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS uq_matter_event_dedupe ON matter_event(dedupe_key)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_timeline ON matter_event(matter_id, happened_at DESC, id DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_kind ON matter_event(matter_id, kind, happened_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_event_resource ON matter_event(resource_id, happened_at DESC) WHERE resource_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_review ON matter_update(matter_id, review_status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_range ON matter_update(matter_id, from_event_id, to_event_id)",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_run ON matter_update(agent_run_id) WHERE agent_run_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_matter_update_stale ON matter_update(matter_id, is_stale, created_at DESC) WHERE review_status='pending'",
)


# ==================== kos_ingest_log DDL 单源 (v41, issue #59) ====================
# 🔴 唯一权威 DDL —— 三个消费方共用, 改列/索引只动这里:
#   ① SyncStore._init_database_impl (v41 起版本化建表, 无条件幂等 —— 主路径;
#      D2: schema 与 MAILAGENT_KOS_INGEST_ENABLED 解耦, 开关翻转时 DB 版本一致);
#   ② src/kos/bulk_ingest.py KOSBulkIngester._ensure_log_table (幂等双保险,
#      bulk 可对任意 --db-path 独立跑, 那个库未必被 SyncStore 迁移过);
#   ③ src/kos/ingest_log.py 台账读写 (假设 schema 已就位, 不自建)。
# import 方向必须是 kos → mail (bulk_ingest 已依赖 src.repository → src.mail.*),
# sync_store 反向 import src.kos 会拖进 producer/client (httpx) 依赖链。
#
# status 值域 (跨 lane 契约, 见 .trellis/tasks/07-25-kos-issue-59-llm-dashboard/prd.md R1):
#   pushed  — put_page 成功
#   failed  — 瞬时失败, 等待重试扫描 (next_retry_at 排程)
#   dead    — 超重试上限 / 永久类错误码 (需人工介入, 手动 bulk --retry-failed 可捞)
#   skipped — priority floor / 未标注 / 未配置 / dry-run 过滤 (与失败区分)
#   pending — 等 LLM 标签就位后由重试扫描首推 (issue #64 Lane A deferred first-push,
#             分钟级瞬态; retry_count 在此状态下 = 已检查轮数)
KOS_INGEST_LOG_TABLE_DDL = """
    CREATE TABLE IF NOT EXISTS kos_ingest_log (
        internal_id INTEGER PRIMARY KEY,
        slug TEXT,
        status TEXT,
        chunks INTEGER,
        error TEXT,
        pushed_at REAL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at REAL,
        error_code TEXT,
        source TEXT
    )
"""
# 老库该表可能已被 bulk_ingest 惰性建成 6 列旧形状 → ALTER 补列 (PRAGMA 判断后幂等)。
KOS_INGEST_LOG_RETRY_COLUMNS = {
    "retry_count": "INTEGER NOT NULL DEFAULT 0",
    "next_retry_at": "REAL",
    "error_code": "TEXT",
    "source": "TEXT",
}
# 重试扫描的调度索引 (status='failed' AND next_retry_at <= now)。
KOS_INGEST_LOG_INDEX_DDL = (
    "CREATE INDEX IF NOT EXISTS idx_kos_ingest_retry "
    "ON kos_ingest_log(status, next_retry_at) WHERE status='failed'"
)


def ensure_kos_ingest_log_schema(cursor) -> None:
    """kos_ingest_log 建表 + 补列 + 建索引, 全幂等 (v41 migration 与 bulk 双入口共用)。

    顺序敏感: 索引引用 next_retry_at, 必须先补列再建索引 (老库旧形状缺该列时
    先建索引会 no such column)。
    """
    cursor.execute(KOS_INGEST_LOG_TABLE_DDL)
    cols = {row[1] for row in cursor.execute("PRAGMA table_info(kos_ingest_log)").fetchall()}
    for _col, _typ in KOS_INGEST_LOG_RETRY_COLUMNS.items():
        if _col not in cols:
            cursor.execute(f"ALTER TABLE kos_ingest_log ADD COLUMN {_col} {_typ}")
            logger.info(f"kos_ingest_log schema: +{_col}")
    cursor.execute(KOS_INGEST_LOG_INDEX_DDL)


class UpdateAfterFetchResult(Enum):
    """``update_after_fetch`` 的结果三态（2026-07-14 幽灵行事故后引入）。

    老实现返回 bool 且三个调用点都不看返回值 —— message_id 撞 UNIQUE 被静默吞掉,
    是幽灵行永久卡死的病根之一。调用方必须区分 DUPLICATE(中止本封) 与 FAILED。

    OK: 元数据已写入。
    DUPLICATE: 目标 message_id 已被另一条 **已 synced** 的行(真身)占用 → 当前行是
        重复行(幽灵行), 已被 **物理删除**(CASCADE 清 body/attachment/outbox, 见
        _resolve_message_id_conflict)。调用方必须中止本封邮件的后续同步(行已不存在)。
    FAILED: 写入失败 —— DB 错误, 或 message_id 撞上一条 **未** synced 的行(无法判定
        谁是真身 → 按铁律谁都不动, 留人工处置)。调用方不得静默吞掉。
    """

    OK = 'ok'
    DUPLICATE = 'duplicate'
    FAILED = 'failed'


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
    """把 date_received 归一成 ISO 8601 (UTC 偏移) 字符串.

    输入支持:
    - 已是 ISO with tz: ``2026-05-22T14:30:00+08:00`` → ``2026-05-22T06:30:00+00:00``
    - ISO naive: ``2026-01-27T23:01:25`` → 按系统本地 tz 解释后转 UTC
    - space-separated naive (mail.app SQLite radar 用 ``datetime(ts, 'unixepoch',
      'localtime')`` 输出, 是**系统本地 tz** naive): ``2026-05-19 04:23:53`` →
      按本地 tz (含 DST) 解释后转 UTC
    - RFC 822 (旧 davmail 兜底): ``Fri, 22 May 2026 14:30:00 +0800`` → ISO 8601 UTC
    - 空 / 解析失败: 原样返回 (上层别 break)

    Sprint 16 cutover: ``_local_tz()`` 动态拿系统 tz 而非硬编码 ``+08:00`` —
    上一版本 hard-code 北京时区导致 PDT 用户的 5148 行被标错 tz.

    07-07 排序 tz 归一: 统一 ``astimezone(utc)`` — 排序全链路是词法字符串比较
    (SQL TEXT ORDER BY + localeCompare), 保留原始/本地偏移会让 ``10:54+08:00``
    字典序压过 ``05:58+00:00``。davmail 侧 ``_normalize_date_iso`` 同口径; 本函数
    是 AppleScript fallback 写入路径, 不同改会在应急回切时重新混入非 UTC 偏移行。
    """
    if not value:
        return value
    s = value.strip()
    if not s:
        return value
    local_tz = _local_tz()
    # 已是 ISO with tz (T 加 +HH:MM / -HH:MM / Z) → 同一绝对时刻, 偏移表示归一 UTC
    if "T" in s and (s.endswith("Z") or "+" in s[10:] or "-" in s[10:]):
        try:
            return datetime.fromisoformat(s).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
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
            return dt.astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            pass
    # space-separated: 2026-05-19 04:23:53
    if " " in s and len(s) >= 19 and s[10] == " ":
        try:
            dt = datetime.fromisoformat(s.replace(" ", "T", 1))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=local_tz)
                dt = dt.astimezone(local_tz)
            return dt.astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError):
            pass
    # RFC 822 fallback (e.g. davmail 早期 path / 万一漏掉 normalize)
    try:
        dt = parsedate_to_datetime(s)
        if dt is None:
            return value
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_tz)
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return value


class SyncStoreMigrationError(RuntimeError):
    """数据库迁移真失败 / 版本不兼容 (E0-WP3 迁移守卫)。

    抛出场景:
    1. ALTER/索引迁移块的 except 分支复查发现目标对象仍缺失 (真失败, 非「列已存在」)
       —— 中断 _init_database, **不写 db_version**, 下次启动自动重试;
    2. 降级守卫: 库里的 db_version > 代码 DB_VERSION (库来自更新版本的 app),
       拒绝启动防旧代码静默降级新库。
    调用方 (src/service.py EmailNotionSyncApp.__init__) 捕获后 fail-fast 退出。
    """


def _migration_guard_columns(cursor, table: str, required_cols, label: str, err: Exception) -> None:
    """迁移 ALTER 块 except 分支的吞错修正 (E0-WP3)。

    历史 pattern: ``except sqlite3.OperationalError → logger.warning("skipped")``。
    因为 try 里已有 PRAGMA 预检挡掉「列已存在」, except 抓到的只会是真失败
    (disk I/O / malformed / locked …) —— 但旧代码吞掉后 db_version 照样前进, 永不重试。

    这里用 PRAGMA 复查目标列: 仍缺失 → raise SyncStoreMigrationError (中断迁移,
    version 不前进); 全部在位 → 维持旧行为 no-op warning (防御性保留, 理论上不可达)。

    注意: raise 沿栈展开时由 _init_database 外层兜底 close 连接 (事务内未 commit
    的部分随 close ROLLBACK); 版本写入在函数末尾从未执行, 下次启动以旧 version
    重跑 (各迁移块幂等, 重试安全)。
    """
    try:
        existing = {r[1] for r in cursor.execute(f"PRAGMA table_info({table})").fetchall()}
    except sqlite3.Error:
        existing = set()
    missing = sorted(set(required_cols) - existing)
    if missing:
        logger.error(
            f"{label}: ALTER 真失败, 目标列仍缺失 {missing} — 中断迁移, "
            f"db_version 不前进, 下次启动重试 ({err})"
        )
        raise SyncStoreMigrationError(
            f"{label}: columns still missing {missing} after migration failure: {err}"
        ) from err
    logger.warning(f"{label}: OperationalError 但目标列已全部在位, 按已迁移跳过 ({err})")


def _migration_guard_index(cursor, index_name: str, label: str, err: Exception) -> None:
    """迁移「建索引」块 except 分支的吞错修正 (E0-WP3), 语义同 _migration_guard_columns。

    复查 sqlite_master: 索引仍缺失 → raise (真失败, version 不前进); 已在位 → no-op warning。
    """
    try:
        row = cursor.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name=?", (index_name,)
        ).fetchone()
    except sqlite3.Error:
        row = None
    if row is None:
        logger.error(
            f"{label}: 迁移真失败, 索引 {index_name} 仍缺失 — 中断迁移, "
            f"db_version 不前进, 下次启动重试 ({err})"
        )
        raise SyncStoreMigrationError(
            f"{label}: index {index_name} still missing after migration failure: {err}"
        ) from err
    logger.warning(f"{label}: OperationalError 但索引 {index_name} 已在位, 按已迁移跳过 ({err})")


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
    in_reply_to: Optional[str]  # v40：直接父邮件 message_id（无尖括号），KOS Thread 链接用
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
    #                详见 frontend/archive/2026-05/SPRINT-IMMERSIVE-TRANSLATE-HANDOFF.md.
    # v13 (Sprint 16 dual-backend, 2026-05): email_metadata 加 imap_uidvalidity / imap_uid /
    #                backend_origin 三列, 支持 DavMail backend (IMAP) 与 AppleScript backend
    #                共存. backend_origin='applescript' → internal_id = Mail.app ROWID (<10^9);
    #                backend_origin='davmail' → internal_id = sync_state['davmail_next_internal_id']
    #                自增 (起点 1_000_000_000, 永不与 ROWID 冲突). 通过 allocate_davmail_internal_id()
    #                atomic 分配. 详见 plan §"主键 / 邮件标识策略" 方案 D +
    #                docs/archive/2026-05/dual-backend-architecture-handoff.md.
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
    # v24 (T7 CJK trigram, 2026-06): 新增并行 contentful FTS5 表 email_body_fts_trigram
    #                (tokenize='trigram') + 4 个 trigger (insert/delete/update on email_body
    #                + meta_update on email_metadata) + 幂等回填。主表 email_body_fts
    #                (porter unicode61) 不动 → 英文零回归。trigram 表给中文子串搜索:
    #                CJK >=3 字走 MATCH, =2 字走 trigram 表 LIKE 兜底 (MATCH <3 字符无召回)。
    #                灰度开关 SEARCH_TRIGRAM_ENABLED 默认 False — flag=False 时搜索仍走主表
    #                unicode61 + smart_query_transform (逐字节零回归), flag=True 才启用 CJK 路由。
    #                幂等: CREATE ... IF NOT EXISTS + 回填 WHERE NOT EXISTS, 重跑不重复/不报错。
    #                回滚: 关 flag 即回 unicode 路径; 彻底回退见下方 v24 迁移块注释 (DROP 4 trigger
    #                + DROP email_body_fts_trigram, 主表不动)。
    # v25 (T8 收件人全文化, 2026-06): 新增并行 contentful FTS5 表 email_recipient_fts
    #                (to_addr, cc_addr, sender_name; tokenize='porter unicode61
    #                remove_diacritics 2') + 3 个 trigger (insert / update_of /
    #                delete on email_metadata) + 幂等回填。数据源是 email_metadata 三列 (与
    #                body_fts 来自 email_body 不同, 故 trigger 直接挂 email_metadata)。
    #                新增 to~:/cc~:/from~: 三个显式 FTS 列语法才查这张表 (裸词搜索一行不碰它,
    #                天然零回归 —— ②保守语义)。主表 email_body_fts 不动。无 flag (纯新增 opt-in 语法)。
    #                幂等: CREATE ... IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填
    #                WHERE NOT EXISTS (current_version < 25 gate)。
    #                回滚 (彻底回退 v25): 三个新语法只在 parser 显式列名出现时生效, 不影响裸词;
    #                必要时:
    #                  DROP TRIGGER IF EXISTS email_recipient_fts_insert;
    #                  DROP TRIGGER IF EXISTS email_recipient_fts_update;
    #                  DROP TRIGGER IF EXISTS email_recipient_fts_delete;
    #                  DROP TABLE IF EXISTS email_recipient_fts;
    #                主表 email_body_fts / email_body_fts_trigram 不动 → 回滚低风险。
    # v26 (agentic 搜索 = 特化 Custom Agent, 2026-06): 复用 report_agent 表 (type 多态),
    #                INSERT OR IGNORE 播种一行 type='search' 的搜索 agent (id='email_search_agent',
    #                enabled=1, model/prompt NULL → 运行时回退默认, tools_json='["email_search_fulltext"]')。
    #                **无 DDL** —— model/prompt/tools_json 列 v18 起就有。幂等: INSERT OR IGNORE
    #                重跑不重复; 无 version gate, 靠 INSERT OR IGNORE 幂等 (与既有 report-agent seed 同模式)。
    #                回滚 (回退 v26): DELETE FROM report_agent WHERE id='email_search_agent';
    #                必要时降 db_version 即可 (无表结构变更, 删行无副作用)。
    # v27 (AI 邮件预处理 Custom Agent, 2026-07, issue #31/#32 增量2): report_agent 加
    #                context_docs_json 列 (JSON 数组 of profile-doc 名, 如 ["soul","user"]) +
    #                INSERT OR IGNORE 播种一行 type='preprocess' 的预处理 agent
    #                (id='email_preprocess_agent')。persona 复用 prompt 列、文档勾选存新列；
    #                开关/模型走全局 env (LLM_AGENT_ENABLED/LLM_MODEL), 运行时对 persona/docs
    #                NULL-safe 叠加 (不填=字节级回退现状)。ALTER 必须先于 seed (seed 引用新列)。
    #                幂等: ALTER 前 PRAGMA 检查 + INSERT OR IGNORE。
    #                回滚 (回退 v27): DELETE FROM report_agent WHERE id='email_preprocess_agent';
    #                context_docs_json 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    # v28 (删月报默认 seed, 2026-07, dogfood 反馈 #9): 删除 monthly_email_digest 默认行
    #                (仅 enabled=0 且 prompt IS NULL 的未改默认态; 客制化用户行保留)。
    #                v19 seed 块移除 monthly tuple (新库不再播种月报)。
    #                回滚 (回退 v28): 月报行已删无法自动恢复; 需手动 INSERT 或降 db_version。
    # v29 (预处理行级 fallback 拆分, 2026-07, dogfood R2 反馈 #2): report_agent 加
    #                fallback_models_json 列 (JSON 数组 of 模型名)。NULL = 跟随全局
    #                LLM_FALLBACK_MODELS (老用户升级零感知)、'[]' = 显式不设兜底、
    #                数组 = 预处理专用 fallback 链。无 seed 变更 (种子行留 NULL=跟随全局)。
    #                幂等: ALTER 前 PRAGMA 检查 (同 v27 context_docs_json 模式)。
    #                回滚 (回退 v29): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    # v30 (Custom Agent 内核 S4 W1, 2026-07, flag MAILAGENT_CUSTOM_AGENTS_ENABLED 默认关):
    #                report_agent 加 trigger_json (判别式 cron|email_filter) / tool_policy_json
    #                (D6 allowed_tools 交集收窄) / budget_json。当前只执行 runs/day + runtime；
    #                存量 max_steps 字段为向后兼容保留但忽略。
    #                三列 (TEXT NULL, 无 seed —— type='custom' 行只由 owner 创建, W1 不播种)。
    #                async_jobs 加 claim_token / spec_claimed_at 两列 (D2 fresh-spawn CAS one-shot;
    #                W1 只建列, 端点在 W2)。全 additive TEXT NULL, 对既有行/调用零影响。
    #                幂等: ALTER 前 PRAGMA 检查 (同 v27/v29 模式)。
    #                回滚 (回退 v30): 五列可留 (旧代码无害, 全 NULL) 或手动 DROP; 必要时降 db_version。
    # v31 (项目周报 sync 迁入 custom agent 框架, S5 W5a, 2026-07): report_agent 播种单例
    #                type='project_progress' 行 (id='project_progress_sync')。**无 DDL** —— 复用
    #                v30 的 trigger_json 列存触发配置 (email_filter 词汇: subject_pattern/sender_pattern,
    #                但 project_progress 走 ProjectProgressDetector 子串-sender 匹配, 非 matcher 正则)。
    #                enabled/trigger 从 env (PROJECT_PROGRESS_AUTO_SYNC_ENABLED / _SUBJECT_PATTERN /
    #                _SENDER) 播种一次, 之后行权威 (Settings 可改); 总闸仍是 env PROJECT_PROGRESS_SYNC_ENABLED。
    #                执行不进 async_jobs / gateway —— new_watcher hook 直调确定性 runner (P1: 框架不容纳
    #                非 LLM 执行体, 项目周报只把触发配置搬进行, 执行仍 Python 直调)。
    #                幂等: INSERT OR IGNORE (旧库已有则跳过、不覆盖用户改过的 enabled/trigger)。
    #                回滚 (回退 v31): DELETE FROM report_agent WHERE id='project_progress_sync'; 必要时降 db_version。
    # v32 (issue #19 产品化, 2026-07): report_agent 加 mark_read_after_processing INTEGER。
    #                仅 type='preprocess' 使用：1 = AI 预处理完成后自动标已读，0 = 保持当前
    #                未读状态。NULL / 缺列按 1 解释，升级迁移同时把 preprocess 行 NULL 回填 1，
    #                保持既有行为零变化。幂等: ALTER 前 PRAGMA 检查 + UPDATE ... IS NULL。
    #                回滚 (回退 v32): 列可留（旧代码无害）或手动 DROP；必要时降 db_version。
    # v33 (issue #12, 2026-07): email_metadata 加 snippet TEXT，正文前 100 字符去规范化。
    #                升级时从 email_body.body_markdown 一次性回填；后续正文提交事务同步刷新，
    #                让列表查询彻底不 JOIN / 不读取 email_body blob。幂等: ALTER 前 PRAGMA
    #                检查 + 仅回填 snippet IS NULL 行。SQLite substr(TEXT, 1, 100) 按字符截断。
    #                回滚 (回退 v33): 列可留（旧代码无害）或手动 DROP；必要时降 db_version。
    # v34 (日历 epic 阶段 2.1 P1-3, 2026-07): 新增 email_meeting 映射表 (internal_id PK →
    #                ical_uid + method/recurrence_id/sequence/is_recurring)。邮件 .ics 的 uid
    #                此前只进 Notion + recurring_series (仅周期会议), raw MIME 不持久化、.ics
    #                附件被 reader skip → 无法事后解析, 邮件↔日历互跳 (按 ical_uid join
    #                calendar_event) 必须落存储。写入方: new_watcher 会议检测 hook (每封含
    #                invite 的新邮件) + recurring_invite.replay_one (手动 replay 顺路补写)。
    #                升级回填: 从 recurring_series (series_uid + last_seen_message_id join
    #                email_metadata.message_id) best-effort 回填, method 记 NULL (series 行
    #                的 last_seen 可能是 REQUEST 或 CANCEL, 不可考)。存量非周期邀请不可回填。
    #                幂等: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE 回填。
    #                回滚 (回退 v34): DROP TABLE email_meeting; 必要时降 db_version。
    # v35 (日历 epic 5.1 #10 tzid 半步, 2026-07): calendar_event 加 tzid TEXT NULL —— DTSTART 的
    #                TZID 参数归一 Olson 名 (DavMail 别名如 Asia/Beijing→Asia/Shanghai, 见
    #                calendar_sync/_common.normalize_tzid)。NULL = 裸 Z/floating/全天 (现状 UTC 语义);
    #                非空 = 双展开器 (Python expander / TS calendar-read) 按该时区墙钟展开 (DST 边界
    #                occurrence 本地时刻不变), 写路径 (caldav_writer F1/F2) 以其决定 override 的
    #                TZID 输出与 split UNTIL 的本地日界。无历史回填: NULL 行为 = 修复前语义, 下轮
    #                全量 CalDAV sync 重新 upsert 自然补齐。
    #                回滚 (回退 v35): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    # v36 (compose epic D1 草稿线程 linkage, 2026-07): email_metadata 加 3 列 (全可空,
    #                仅 mailbox='草稿箱' 行使用): draft_source_internal_id INTEGER (原邮件行
    #                internal_id, 反查得不到则 NULL) / draft_in_reply_to TEXT (原邮件
    #                Message-ID, 去尖括号) / draft_references TEXT (空格分隔 msg-id 链,
    #                含尖括号)。写入方: mail_write._mirror_draft_locally (compose 即时落库)
    #                + davmail_backend.reconcile_drafts (对账自愈, 覆盖 webhook 等一切草稿
    #                来源)。消费方: _prepare_draft 的 source_draft_id 复用 (从草稿发送时恢复
    #                In-Reply-To/References/thread_id, 修 Bug A 丢线程)。无历史回填: 存量
    #                草稿行 NULL = 修复前语义 (发送不带 threading), reconcile 只对新增行生效。
    #                回滚 (回退 v36): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
    # v37 (首启缺表修复, 2026-07): llm_processing 纳入 SyncStore 版本化建表。此前该表
    #                只由 LLMProcessingStore._ensure_schema() 惰性创建 (LLM_AGENT_ENABLED
    #                默认 false → 普通用户永不实例化), 而前端 email:listEnriched 无条件
    #                LEFT JOIN llm_processing → 全新库首启即 `no such table` 崩邮件列表。
    #                v37 起表 + 两索引 (idx_llm_status / idx_llm_retry partial) 由
    #                _init_database_impl 无条件 CREATE IF NOT EXISTS (新/旧库均生效,
    #                幂等, 无数据回填); DDL 单源 = 模块级 LLM_PROCESSING_TABLE_DDL /
    #                LLM_PROCESSING_INDEX_DDLS, LLMProcessingStore._ensure_schema 引用
    #                同常量作幂等双保险。bump 版本号用于前端 backend_lifecycle.ts
    #                (EXPECTED_DB_VERSION=37 + REQUIRED_TABLES 含 llm_processing) 就绪
    #                门控可依赖「>=37 ⇒ 表已建」。
    #                回滚 (回退 v37): 表可留 (旧代码无害); 必要时降 db_version。
    # v38 (task 07-22 预处理参考上下文源迁行存储, 2026-07): report_agent 加 context_source
    #                TEXT。仅 type='preprocess' 使用：'standing_docs' | 'notion_context' 二选一
    #                （分类 system prompt 只注入一种参考背景）。此前该二选一落在 env
    #                LLM_PREPROCESS_CONTEXT_SOURCE (重启生效); 迁行后**保存即生效**, 对齐
    #                model/fallback/context_docs 的行级热读 house style。升级 seed (一次性,
    #                行落地后行权威, env 键降级为首次 seed 默认): env LLM_PREPROCESS_CONTEXT_SOURCE
    #                显式合法值 → 写入行; 否则按 LLM_CONTEXT_PAGE_ID 非空 → 'notion_context',
    #                空 → 'standing_docs' (与旧 _resolve_context_source 继承规则逐字一致 → 升级
    #                前后注入形态零变化)。幂等: ALTER 前 PRAGMA 检查 + 仅回填 context_source IS
    #                NULL 的 preprocess 行。回滚 (回退 v38): 列可留（旧代码按 NULL→继承派生, 无害）
    #                或手动 DROP; 必要时降 db_version。
    # v39 (task 07-22-1 附件 trigram 并行表, 2026-07): 新增 contentful FTS5 表
    #                email_attachment_fts_trigram(filename, text_content, tokenize='trigram'),
    #                rowid=attachment_id。镜像 v24 body trigram 方案②: 主表 email_attachment_fts
    #                (unicode61, 仅 text_content) 不动 → 英文/已有附件搜索零回归; 新表解决①附件正文
    #                中文非前缀子串 + ②文件名可搜 (中/英子串, 主表不索引 filename)。trigger 挂
    #                email_attachment_text (与主表同源同 status gate: 仅 extracted+非空入索引),
    #                filename 由子查询从 email_attachment 取。**本 PR 只建表/回填/触发器, 不接检索
    #                路由 (PR4 才接)**。幂等: CREATE IF NOT EXISTS + 3 trigger + 回填 WHERE NOT
    #                EXISTS (current_version < 39 gate)。回滚 (回退 v39): DROP 3 trigger + DROP 表,
    #                主表不动 (纯 schema 未接路径, 删即回退); 必要时降 db_version。
    # v40 (2026-07-23): email_metadata +in_reply_to (nullable TEXT, 存储无尖括号, 同 message_id
    #                惯例) —— 直接父邮件 message_id (In-Reply-To 头), KOS payload Thread 链接反查用。
    #                davmail/applescript 两条解析路径落库; 老行 NULL (forward-only, 无 backfill)。
    #                回滚 (回退 v40): 列可留 (旧代码无害, 全 NULL) 或手动 DROP; 必要时降 db_version。
    # v41 (issue #59 KOS 入库可靠性, 2026-07): kos_ingest_log 从 bulk_ingest 惰性建表升格为
    #                版本化正式表 (镜像 v37 llm_processing 模式)。+4 列 retry_count NOT NULL
    #                DEFAULT 0 / next_retry_at REAL / error_code TEXT / source TEXT
    #                ('producer'|'bulk'), status 值域扩为 pushed/failed/dead/skipped, 调度索引
    #                idx_kos_ingest_retry(status, next_retry_at) WHERE status='failed'。
    #                D2: 无条件建表 (schema 与 MAILAGENT_KOS_INGEST_ENABLED 解耦, "字节级
    #                inert" 只约束运行时行为不发请求/不写行, 不约束 schema 存在性)。
    #                幂等: DDL 单源 = 模块级 KOS_INGEST_LOG_TABLE_DDL / _RETRY_COLUMNS /
    #                _INDEX_DDL + ensure_kos_ingest_log_schema() (bulk _ensure_log_table 引用
    #                同函数); 老库该表可能已被 bulk 惰性建成 6 列旧形状 → PRAGMA 判断后
    #                ALTER 补列。无数据回填 (forward-only, 历史空洞仍由手动 bulk_ingest 补)。
    #                回滚 (回退 v41): 表/列可留 (旧代码只写老 6 列, 无害); 必要时降 db_version。
    # v42 (custom-agent epic W4, 2026-07): report_agent +avatar_json (nullable TEXT)。空值由前端
    #                按 agent_id 确定性派生 shape/palette/variant；显式 JSON 保存用户在 custom
    #                agent 编辑器选择的身份。纯展示元数据，不改变内置 agent 行为。
    # v43 (harness optimization P2, 2026-08): report_agent +description TEXT。NULL/空 = 未设置；
    #                wire 写侧 strip 并限制 1000 字符，读侧原样投影。additive ALTER，无回填。
    #                回滚 (回退 v43): 列可留（旧代码无害）；必要时降 db_version。
    DB_VERSION = 44  # v44: Matter aggregate base tables

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
        """初始化数据库表结构（v3 架构）

        E0-WP3: 迁移真失败 / 降级守卫会从 _init_database_impl 中 raise —— 这里兜底
        关闭连接 (未 commit 的事务随 close 自动 ROLLBACK), 防止异常 traceback 持有
        frame 导致连接 (及其写锁) 悬挂, 随后把异常原样上抛给调用方 fail-fast。
        """
        conn = self._get_connection()
        try:
            self._init_database_impl(conn)
        except BaseException:
            try:
                conn.close()
            except Exception:
                pass
            raise

    def _init_database_impl(self, conn):
        """_init_database 的实际建表 + 迁移体 (拆出以便异常路径统一释放连接)。"""
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

        # E0-WP3 降级守卫: 库版本比代码新 → 拒绝启动 (防旧版 app 打开新库后
        # 把 db_version 静默降回、或按旧语义误写新 schema)。前端 backend_lifecycle.ts
        # 的 EXPECTED_DB_VERSION 门控是 `>=` 容错 (不会拦更新的库), Python 侧在这里
        # fail-fast 是有意行为 —— 两者不冲突 (TS 照常开窗, serve 拒起并留明确日志)。
        if current_version > self.DB_VERSION:
            # raise 由 _init_database 外层兜底 close 连接 (ROLLBACK), 这里不重复 close
            raise SyncStoreMigrationError(
                f"数据库 db_version={current_version} 高于本版本支持上限 "
                f"{self.DB_VERSION} —— 该数据库来自更新版本的 MailAgent。"
                f"请升级 App, 或从 backups/ 恢复与当前版本匹配的数据库备份 "
                f"(拒绝启动以防旧代码降级新库)。"
            )

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
                backend_origin TEXT DEFAULT 'applescript',
                snippet TEXT,
                draft_source_internal_id INTEGER,
                draft_in_reply_to TEXT,
                draft_references TEXT,
                in_reply_to TEXT
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
        # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §4.1
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
        # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §4.2
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
        # 详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §3.3 + docs/archive/2026-05/phase2-handoff-to-phase3.md §5.1
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
        # NS-5: 主表 email_body_fts 历史隐患 —— subject/sender 改在 email_metadata 上时
        # 主表 FTS 不更新 → 按 subject/sender 搜可能命中陈旧值。补 meta_update trigger
        # (与 email_body_fts_trigram_meta_update 对齐)。无条件 CREATE IF NOT EXISTS,
        # 每次 init 幂等创建, 无需 bump DB_VERSION。仅当该 internal_id 已有 body 行时才
        # re-sync (无 body → 无 FTS 行)。不做全量回填 (既有 stale 行罕见且 pre-existing,
        # 不值 7 万行 re-sync)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_meta_update
            AFTER UPDATE OF subject, sender ON email_metadata
            WHEN EXISTS (SELECT 1 FROM email_body WHERE internal_id = NEW.internal_id)
            BEGIN
                DELETE FROM email_body_fts WHERE rowid = NEW.internal_id;
                INSERT INTO email_body_fts(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(b.body_markdown, ''),
                       COALESCE(NEW.subject, ''),
                       COALESCE(NEW.sender, '')
                  FROM email_body b WHERE b.internal_id = NEW.internal_id;
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
            # E0-WP3: PRAGMA 预检已挡「列已存在」, 这里只会是真失败 → 复查, 缺列即中断
            _migration_guard_columns(
                cursor, "email_metadata", {"is_pinned", "pinned_at"}, "v8 migration", e
            )

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
            _migration_guard_columns(
                cursor, "email_metadata", {"is_important"}, "v9 migration", e
            )

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
            _migration_guard_columns(
                cursor,
                "email_metadata",
                {"imap_uidvalidity", "imap_uid", "backend_origin", "processing_status"},
                "v13 migration",
                e,
            )

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
            _migration_guard_columns(
                cursor, "email_metadata", {"ai_priority", "ai_action"}, "v14 migration", e
            )

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
        #   - 'email_ics': 预留枚举, 从未实现写入 (meeting_sync 只写 Notion +
        #     recurring_series; 详见 calendar-ops.md)
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
                tzid TEXT,  -- v35: DTSTART TZID 归一 Olson 名 (NULL=裸 Z/floating/全天); 末列对齐 ALTER 追加位置
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

        # ==================== v34: email_meeting 邮件↔日历 ical_uid 映射 ====================
        # 一封会议邀请邮件 ↔ 它携带的 vEvent UID (RFC 5545)。消费方按 ical_uid join
        # calendar_event (idx_calendar_event_uid) 实现双向互跳:
        #   方向 A: 邮件 internal_id → uid → 日历 master 行 (「查看日程」)
        #   方向 B: ical_uid → 来源邀请邮件 (drawer 反查, 多封时优先最新 METHOD:REQUEST)
        # PK=internal_id (icalendar_parser 单 invite 语义, 一封邮件最多一条);
        # method NULL = v34 回填行 (recurring_series.last_seen 不可考 REQUEST/CANCEL)。
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS email_meeting (
                internal_id INTEGER PRIMARY KEY,
                ical_uid TEXT NOT NULL,
                method TEXT,
                recurrence_id TEXT,
                sequence INTEGER NOT NULL DEFAULT 0,
                is_recurring INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                FOREIGN KEY (internal_id) REFERENCES email_metadata(internal_id) ON DELETE CASCADE
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_email_meeting_uid
            ON email_meeting(ical_uid)
        """)

        # ==================== v37: llm_processing (LLM 分类处理记账) ====================
        # 历史缺陷 (首启缺表事故): 该表原本只由 LLMProcessingStore._ensure_schema()
        # 惰性创建 (LLM_AGENT_ENABLED=false 时永不实例化), 而前端 email:listEnriched
        # 无条件 LEFT JOIN llm_processing → 全新 userData 首启邮件列表整页崩。
        # v37 起纳入版本化建表 (新/旧库均 IF NOT EXISTS 幂等); DDL 单源 = 模块级
        # LLM_PROCESSING_TABLE_DDL / LLM_PROCESSING_INDEX_DDLS (store.py 引用同常量)。
        cursor.execute(LLM_PROCESSING_TABLE_DDL)
        for _llm_ddl in LLM_PROCESSING_INDEX_DDLS:
            cursor.execute(_llm_ddl)

        # ==================== v16: 附件文本索引 (PR-2b, Sprint 19 M2) ====================
        # 把 PDF / docx / pptx / xlsx 附件文本抽出 → FTS5 索引, 让 chat agent /
        # LLM tool 跨附件检索 ('合同条款里 redis timeout 提到过吗').
        # 跟 email_body_fts (Phase 3, v5 schema) 平行: contentful FTS5 +
        # 3 trigger 自动 sync, 但走单独表 email_attachment_text + email_attachment_fts.
        # extraction 由长驻 attachment_text worker 异步消费 (src/mail/
        # attachment_text_worker.py tick_loop, service.py 注册; CLI
        # `mailagent attachment extract` 共享同一消费逻辑), 不阻塞主 sync.
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

        # === v39: email_attachment_fts_trigram (附件正文/文件名 CJK+子串搜索, 并行 trigram 表) ===
        # 设计来源: .trellis/tasks/07-22-1-trigram-cjk-trigram PR3 (镜像上面 v24 email_body_fts_trigram
        # 方案②)。主表 email_attachment_fts (porter unicode61, 仅 text_content) 不动 → 英文/已有附件
        # 搜索逐字节零回归; 这里新增并行 contentful FTS5 表用 tokenize='trigram' 解决:
        #   ① 附件正文中文非前缀子串 (unicode61 把连续 CJK 串当单一 token, '固件' 漏掉 '固件升级');
        #   ② 附件文件名可搜 (中/英子串 —— 主表根本不索引 filename)。
        # 实测硬约束: trigram MATCH <3 个 Unicode 字符无召回 (2 字中文靠 trigram 表 LIKE 兜底, 与
        # email_body_fts_trigram 一致)。**本 PR 只建表/回填/触发器闭环, 不接任何检索路由 (PR4 才接)**。
        #
        # contentful (非 contentless): 与 email_body_fts_trigram 一致, 存原文副本支持 2 字 LIKE 兜底
        # + snippet/排名。rowid = attachment_id, 与 email_attachment / email_attachment_text 互查。
        #
        # 数据源: filename 在 email_attachment 列、text_content 在 email_attachment_text 列。3 个
        # trigger 挂 email_attachment_text (与主表 email_attachment_fts 完全同源同 status gate: 仅
        # status='extracted' AND text_content IS NOT NULL 入索引), filename 由子查询从 email_attachment
        # 取 (附件行先于其 text 落地 → 子查询恒解析到)。filename 在 email_attachment 创建后不可变
        # (代码仅 UPDATE notion_file_id/notion_block_id, 从不改 filename) → 无需 filename meta_update
        # trigger (对齐主表保守语义, 不新增维护面)。
        #
        # 级联删除: email_metadata DELETE → email_attachment CASCADE → email_attachment_text CASCADE
        # → 本表 delete trigger 触发清理 FTS。实测 (SQLite 3.53.1, recursive_triggers 默认 off) FK
        # CASCADE 删 email_attachment_text 会触发其 AFTER DELETE trigger, INSERT OR REPLACE 再抽取
        # 也保持单行 —— 与主表 email_attachment_fts 用同一机制 (见其 v16 注记), PR3 迁移测试有 cascade
        # + 再抽取 parity case 锁死。
        #
        # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填 WHERE NOT EXISTS
        # (current_version < 39 gate, 重跑不重复插)。
        #
        # 回滚 (彻底回退 v39): 本表纯 schema 不接任何检索路径, 直接删即可:
        #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_insert;
        #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_update;
        #   DROP TRIGGER IF EXISTS email_attachment_fts_trigram_delete;
        #   DROP TABLE IF EXISTS email_attachment_fts_trigram;
        # 主表 email_attachment_fts 不动 → 回滚零风险 (附件搜索继续走 unicode 主表)。
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS email_attachment_fts_trigram USING fts5(
                filename,
                text_content,
                tokenize='trigram'
            )
        """)
        # INSERT trigger: 只在 status='extracted' 且 text_content 非空时入 FTS (同主表 WHEN 门)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_insert
            AFTER INSERT ON email_attachment_text
            WHEN NEW.status = 'extracted' AND NEW.text_content IS NOT NULL
            BEGIN
                INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
                SELECT NEW.attachment_id,
                       COALESCE((SELECT filename FROM email_attachment WHERE id = NEW.attachment_id), ''),
                       NEW.text_content;
            END
        """)
        # UPDATE trigger: 先删 + 重插, 防 status 翻转 (failed → extracted) 漏入索引 (同主表)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_update
            AFTER UPDATE ON email_attachment_text
            BEGIN
                DELETE FROM email_attachment_fts_trigram WHERE rowid = OLD.attachment_id;
                INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
                SELECT NEW.attachment_id,
                       COALESCE((SELECT filename FROM email_attachment WHERE id = NEW.attachment_id), ''),
                       NEW.text_content
                WHERE NEW.status = 'extracted' AND NEW.text_content IS NOT NULL;
            END
        """)
        # DELETE trigger: CASCADE 链路 (email_metadata DELETE → email_attachment CASCADE →
        # email_attachment_text CASCADE → 这里触发清理 FTS)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_attachment_fts_trigram_delete
            AFTER DELETE ON email_attachment_text
            BEGIN
                DELETE FROM email_attachment_fts_trigram WHERE rowid = OLD.attachment_id;
            END
        """)
        # 首次回填: 把已 extracted 的附件文本 (含 filename join) 推入 trigram FTS (幂等, WHERE NOT
        # EXISTS 防重; pending/failed/unsupported 行不索引, 与主表 email_attachment_fts 一致)。
        if current_version < 39:
            cursor.execute("""
                INSERT INTO email_attachment_fts_trigram(rowid, filename, text_content)
                SELECT t.attachment_id,
                       COALESCE(a.filename, ''),
                       t.text_content
                  FROM email_attachment_text t
                  JOIN email_attachment a ON a.id = t.attachment_id
                 WHERE t.status = 'extracted'
                   AND t.text_content IS NOT NULL
                   AND NOT EXISTS (
                       SELECT 1 FROM email_attachment_fts_trigram WHERE rowid = t.attachment_id
                   )
            """)
            reindexed = cursor.rowcount or 0
            if reindexed:
                logger.info(
                    f"v39 attachment trigram FTS5 reindex: {reindexed} extracted attachment "
                    f"texts indexed (email_attachment_fts_trigram)"
                )

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
                updated_at REAL,
                context_docs_json TEXT,        -- v27: preprocess 用 JSON 数组 of profile-doc 名（NULL=默认 soul+user）
                fallback_models_json TEXT,     -- v29: preprocess 行级 fallback 链 JSON 数组（NULL=跟随全局 LLM_FALLBACK_MODELS）
                trigger_json TEXT,             -- v30: custom agent 触发判别式（{"v":1,"kind":"cron"|"email_filter",...}；NULL=非事件型，既有三 type 不用）
                tool_policy_json TEXT,         -- v30: custom agent 工具收窄（{"v":1,"allowed_tools":[...]}；NULL=不额外收窄）
                budget_json TEXT,              -- v30: custom agent 预算（runs/day + runtime；存量 max_steps 宽容忽略；NULL=全默认）
                mark_read_after_processing INTEGER, -- v32: preprocess 处理后自动标已读（NULL=默认 true）
                context_source TEXT,           -- v38: preprocess 参考上下文源 'standing_docs'|'notion_context'（NULL=按 LLM_CONTEXT_PAGE_ID 继承派生）
                avatar_json TEXT,              -- v42: 可选头像 shape/palette/variant JSON；NULL=按 agent id 派生
                description TEXT               -- v43: 可选 agent 描述；NULL=未设置
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
                finished_at REAL,
                claim_token TEXT,                        -- v30 (S4 D2): agent_run fresh-spawn 能力令牌 (worker 认领时生成)
                spec_claimed_at REAL                     -- v30 (S4 D2): spec pull CAS one-shot marker (NULL=未拉取; 防双 drain)
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
                _migration_guard_columns(
                    cursor,
                    "report_agent",
                    {"trigger_mode", "timezone", "body_full_max", "body_full_priorities"},
                    "v19 migration",
                    e,
                )

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
            # monthly_email_digest 已从默认 seed 中删除 (v28, dogfood #9): 用户未改默认态由迁移块删除
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
                # E0-WP3: dedup/建索引真失败被吞会让 outbox 原子 UPSERT 的
                # ON CONFLICT 目标索引缺失 (运行时写路径全挂) → 复查, 缺即中断
                _migration_guard_index(cursor, "ux_outbox_pending_intent", "v20 migration", e)

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

        # === v24: email_body_fts_trigram (T7 CJK 中文子串搜索, 并行 trigram 表) ===
        # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md 方案②。
        # 主表 email_body_fts (porter unicode61) 不动 → 英文零回归; 这里新增并行 contentful
        # FTS5 表用 tokenize='trigram' 解决中文非前缀子串搜索 (unicode61 把连续 CJK 串当单一
        # token, '产品' 漏掉 '产品评审')。实测硬约束: trigram MATCH <3 个 Unicode 字符无召回
        # (2 字中文必须走 trigram 表 LIKE 兜底; 见研究报告实跑表)。
        #
        # contentful (非 contentless): 因为 2 字中文要靠 LIKE 兜底, 而 contentless 无法读列值,
        # LIKE 不可用 → 必须存原文副本。索引比 unicode61 大 (~2-3 倍), 7 万行可接受。
        # rowid = internal_id, 与 email_body / email_metadata 互查。
        #
        # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS (对新库 init 也建表) + 4 trigger IF NOT EXISTS
        # + 回填 WHERE NOT EXISTS (current_version < 24 gate, 重跑不重复插)。
        #
        # 回滚 (彻底回退 v24): 先关 SEARCH_TRIGRAM_ENABLED flag (查询立即回 unicode 路径), 必要时:
        #   DROP TRIGGER IF EXISTS email_body_fts_trigram_insert;
        #   DROP TRIGGER IF EXISTS email_body_fts_trigram_delete;
        #   DROP TRIGGER IF EXISTS email_body_fts_trigram_update;
        #   DROP TRIGGER IF EXISTS email_body_fts_trigram_meta_update;
        #   DROP TABLE IF EXISTS email_body_fts_trigram;
        # 主表 email_body_fts 不动 → 回滚低风险, 英文/已有路径不受影响。
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS email_body_fts_trigram USING fts5(
                body_markdown,
                subject,
                sender,
                tokenize='trigram'
            )
        """)
        # insert/update/delete on email_body: 与主表 email_body_fts trigger 1:1 镜像
        # (subject/sender 从 email_metadata join 取, 双写流程 metadata 先 commit)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_insert
            AFTER INSERT ON email_body BEGIN
                INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(NEW.body_markdown, ''),
                       COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                       COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_delete
            AFTER DELETE ON email_body BEGIN
                DELETE FROM email_body_fts_trigram WHERE rowid = OLD.internal_id;
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_update
            AFTER UPDATE ON email_body BEGIN
                DELETE FROM email_body_fts_trigram WHERE rowid = OLD.internal_id;
                INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(NEW.body_markdown, ''),
                       COALESCE((SELECT subject FROM email_metadata WHERE internal_id = NEW.internal_id), ''),
                       COALESCE((SELECT sender  FROM email_metadata WHERE internal_id = NEW.internal_id), '');
            END
        """)
        # meta_update: 主表 email_body_fts 的历史隐患 (subject/sender 后改 → FTS stale) 在
        # trigram 表一并修。仅当该 internal_id 已有 body 行时才 re-sync (无 body → 无 FTS 行)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_body_fts_trigram_meta_update
            AFTER UPDATE OF subject, sender ON email_metadata
            WHEN EXISTS (SELECT 1 FROM email_body WHERE internal_id = NEW.internal_id)
            BEGIN
                DELETE FROM email_body_fts_trigram WHERE rowid = NEW.internal_id;
                INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
                SELECT NEW.internal_id,
                       COALESCE(b.body_markdown, ''),
                       COALESCE(NEW.subject, ''),
                       COALESCE(NEW.sender, '')
                  FROM email_body b WHERE b.internal_id = NEW.internal_id;
            END
        """)
        # 首次回填: 把已有 email_body 行推入 trigram FTS (幂等, WHERE NOT EXISTS 防重)。
        # 大库 7 万行可能耗时, 带计数日志 (参考 v5 reindex 风格)。
        if current_version < 24:
            cursor.execute("""
                INSERT INTO email_body_fts_trigram(rowid, body_markdown, subject, sender)
                SELECT b.internal_id,
                       COALESCE(b.body_markdown, ''),
                       COALESCE(m.subject, ''),
                       COALESCE(m.sender, '')
                  FROM email_body b
                  JOIN email_metadata m ON m.internal_id = b.internal_id
                 WHERE NOT EXISTS (
                       SELECT 1 FROM email_body_fts_trigram WHERE rowid = b.internal_id
                 )
            """)
            reindexed = cursor.rowcount or 0
            if reindexed:
                logger.info(
                    f"v24 trigram FTS5 reindex: {reindexed} email_body rows indexed "
                    f"(email_body_fts_trigram)"
                )

        # === v25: email_recipient_fts (T8 收件人全文化, 并行 contentful FTS5 表) ===
        # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings 方案②保守。
        # 主表 email_body_fts (body/subject/sender) 不动 → 裸词搜索逐字节零回归
        # (裸词天然不碰收件人列, 正是②保守语义)。这里新增并行 contentful FTS5 表索引
        # email_metadata 的 to_addr / cc_addr / sender_name 三列, 仅由新增的显式 FTS 列
        # 语法 to~:/cc~:/from~: 查询。无 flag (纯新增 opt-in 语法, 不改任何现有行为)。
        #
        # 数据源是 email_metadata (to_addr/cc_addr/sender_name 都在 email_metadata 列),
        # 与 body_fts (来自 email_body) 不同 → trigger 直接挂 email_metadata:
        #   - AFTER INSERT: 新邮件行写入 → 同步进 recipient_fts。
        #   - AFTER UPDATE OF to_addr,cc_addr,sender_name: 仅这三列变更才 DELETE+INSERT 重同步。
        #   - AFTER DELETE: 邮件行删除 → 清 recipient_fts。
        # contentful (非 contentless): 与 body_fts/trigram 表一致, 自带数据副本支持 snippet/排名。
        # rowid = internal_id, 与 email_metadata 互查。
        #
        # 幂等: CREATE VIRTUAL TABLE IF NOT EXISTS + 3 trigger IF NOT EXISTS + 回填
        # WHERE NOT EXISTS (current_version < 25 gate, 重跑不重复插)。
        #
        # 回滚 (彻底回退 v25): 三个新语法只在 parser 显式列名出现时生效, 不影响裸词; 必要时:
        #   DROP TRIGGER IF EXISTS email_recipient_fts_insert;
        #   DROP TRIGGER IF EXISTS email_recipient_fts_update;
        #   DROP TRIGGER IF EXISTS email_recipient_fts_delete;
        #   DROP TABLE IF EXISTS email_recipient_fts;
        # 主表 email_body_fts / email_body_fts_trigram 不动 → 回滚低风险。
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS email_recipient_fts USING fts5(
                to_addr,
                cc_addr,
                sender_name,
                tokenize='porter unicode61 remove_diacritics 2'
            )
        """)
        # insert/update_of/delete on email_metadata (数据源直接是 email_metadata 三列)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_recipient_fts_insert
            AFTER INSERT ON email_metadata BEGIN
                INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
                VALUES (NEW.internal_id,
                        COALESCE(NEW.to_addr, ''),
                        COALESCE(NEW.cc_addr, ''),
                        COALESCE(NEW.sender_name, ''));
            END
        """)
        # 仅 to_addr/cc_addr/sender_name 三列变更才重同步 (其余列更新不触发, 省开销)。
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_recipient_fts_update
            AFTER UPDATE OF to_addr, cc_addr, sender_name ON email_metadata BEGIN
                DELETE FROM email_recipient_fts WHERE rowid = OLD.internal_id;
                INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
                VALUES (NEW.internal_id,
                        COALESCE(NEW.to_addr, ''),
                        COALESCE(NEW.cc_addr, ''),
                        COALESCE(NEW.sender_name, ''));
            END
        """)
        cursor.execute("""
            CREATE TRIGGER IF NOT EXISTS email_recipient_fts_delete
            AFTER DELETE ON email_metadata BEGIN
                DELETE FROM email_recipient_fts WHERE rowid = OLD.internal_id;
            END
        """)
        # 首次回填: 把已有 email_metadata 行推入 recipient FTS (幂等, WHERE NOT EXISTS 防重)。
        # 大库 7 万行可能耗时, 带计数日志 (参考 v24 reindex 风格)。
        if current_version < 25:
            cursor.execute("""
                INSERT INTO email_recipient_fts(rowid, to_addr, cc_addr, sender_name)
                SELECT m.internal_id,
                       COALESCE(m.to_addr, ''),
                       COALESCE(m.cc_addr, ''),
                       COALESCE(m.sender_name, '')
                  FROM email_metadata m
                 WHERE NOT EXISTS (
                       SELECT 1 FROM email_recipient_fts WHERE rowid = m.internal_id
                 )
            """)
            reindexed = cursor.rowcount or 0
            if reindexed:
                logger.info(
                    f"v25 recipient FTS5 reindex: {reindexed} email_metadata rows "
                    f"indexed (email_recipient_fts)"
                )

        # === v26: agentic 搜索 = 特化 Custom Agent (复用 report_agent 表, 无 DDL) ===
        # 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/agentic-search-impl-plan.md §3.3。
        # 把"搜索"做成一个特化 Custom Agent: 复用 report_agent 表的 type 多态 + model/prompt/
        # tools_json 列 (v18 起全在), 播种一行 type='search' 的搜索 agent。无新表/新列 → 纯 seed。
        #
        # 种子语义: id='email_search_agent', type='search', enabled=1, model=NULL (运行时回退
        # getLlmModel), prompt=NULL (运行时回退内置默认搜索 prompt), tools_json 给 MVP 唯一工具
        # email_search_fulltext (已含 DSL+FTS+中文 trigram+收件人 T5-T8), title='邮件搜索'。
        # report 专属列 (schedule/window/kos_enrich/…) 留 NULL/DEFAULT, search agent 不需要。
        #
        # 幂等: INSERT OR IGNORE (id PK 冲突即跳过), 重跑无副作用; 旧库已有此行 → 跳过, 不覆盖
        # 用户改过的 model/prompt/tools。
        #
        # 回滚 (回退 v26): DELETE FROM report_agent WHERE id='email_search_agent'; 必要时降
        # db_version。无表结构变更, 删行无副作用 (主表/其他 agent 不动)。
        cursor.execute(
            "INSERT OR IGNORE INTO report_agent "
            "(id, type, enabled, title, model, prompt, tools_json, updated_at) "
            "VALUES ('email_search_agent', 'search', 1, '邮件搜索', NULL, NULL, ?, ?)",
            ('["email_search_fulltext"]', time.time()),
        )

        # === v27: AI 邮件预处理 = 特化 Custom Agent (复用 report_agent 表) + context_docs_json 列 ===
        # issue #31/#32 Part2 增量2。把"AI 邮件分类/预处理"做成 Agents 页第三种 Custom Agent
        # (type='preprocess')：persona 复用 prompt 列、文档勾选存新列 context_docs_json (JSON 数组
        # of profile-doc 名, 如 ["soul","user"])。开关/模型仍走全局 env (LLM_AGENT_ENABLED/
        # LLM_MODEL)，运行时对 persona/docs 做 NULL-safe 叠加 (不填=字节级回退现状)。
        # ① ALTER 补 context_docs_json 列 (**必须在下面 seed 前**, seed 引用它)；新库 CREATE 已含 →
        #    PRAGMA 检查跳过。旧库 (v18-v26) 补列, 已存在则 no-op。
        if current_version < 27:
            try:
                _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                if "context_docs_json" not in _pa_cols:
                    cursor.execute("ALTER TABLE report_agent ADD COLUMN context_docs_json TEXT")
                    logger.info("v27 migration: report_agent +context_docs_json")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent", {"context_docs_json"}, "v27 migration", e
                )
        # ② 播种 type='preprocess' 行。幂等 (INSERT OR IGNORE), 旧库已有则跳过、不覆盖用户改过的
        #    prompt/docs。enabled=0/model=NULL 是占位 (预处理开关/模型走全局 env, 非本行);
        #    context_docs_json 默认 ["soul","user"] = 对齐 build_task_identity_context 默认 → 卡片
        #    未动时行为字节一致。worker.py 调度器只跑 type=='report', 天然不碰本行。
        #    回滚 (回退 v27): DELETE FROM report_agent WHERE id='email_preprocess_agent'。
        cursor.execute(
            "INSERT OR IGNORE INTO report_agent "
            "(id, type, enabled, title, model, prompt, tools_json, context_docs_json, updated_at) "
            "VALUES ('email_preprocess_agent', 'preprocess', 0, 'AI 邮件预处理', NULL, NULL, NULL, ?, ?)",
            ('["soul", "user"]', time.time()),
        )

        # === v28: 删 monthly_email_digest 默认 seed 行 (dogfood 反馈 #9) ===
        # 仅删未被用户改动过的默认态行（enabled=0 AND prompt IS NULL）, 保客制化。
        # 新库: v19 seed 块已不播种月报, 本迁移是对已存在旧库的清理; 幂等 (无行则 DELETE 零影响)。
        # 回滚 (回退 v28): 月报行已删不自动恢复; 手动 INSERT 或降 db_version。
        if current_version < 28:
            cursor.execute(
                "DELETE FROM report_agent "
                "WHERE id = 'monthly_email_digest' AND enabled = 0 AND prompt IS NULL"
            )
            logger.info("v28 migration: monthly_email_digest default row removed")

        # === v29: report_agent 加 fallback_models_json 列 (dogfood R2 反馈 #2) ===
        # 预处理 fallback 从全局 env (LLM_FALLBACK_MODELS) 拆出行级列: NULL = 跟随全局
        # (老用户升级零感知)、'[]' = 显式不设兜底、JSON 数组 = 预处理专用链。无 seed 变更。
        # 新库 CREATE 已含 → PRAGMA 检查跳过; 旧库 (v18-v28) 补列, 已存在则 no-op。
        # 回滚 (回退 v29): 列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
        if current_version < 29:
            try:
                _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                if "fallback_models_json" not in _pa_cols:
                    cursor.execute("ALTER TABLE report_agent ADD COLUMN fallback_models_json TEXT")
                    logger.info("v29 migration: report_agent +fallback_models_json")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent", {"fallback_models_json"}, "v29 migration", e
                )

        # === v30: Custom Agent 内核 S4 W1 —— report_agent 加 trigger/tool_policy/budget 三列 +
        # async_jobs 加 claim_token/spec_claimed_at 两列 (S4 fresh-spawn CAS)。全 additive TEXT NULL,
        # 旧库对既有行/调用零影响 (NULL = 非事件型 / 不收窄 / 全默认 / 未拉取)。新库 CREATE 已含 →
        # PRAGMA 检查跳过; 旧库 (v18-v29) 补列, 已存在则 no-op。无 seed (type='custom' 行由 owner 创建)。
        # 回滚 (回退 v30): 五列可留 (旧代码无害) 或手动 DROP; 必要时降 db_version。
        if current_version < 30:
            try:
                _ra_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                for _c in ("trigger_json", "tool_policy_json", "budget_json"):
                    if _c not in _ra_cols:
                        cursor.execute(f"ALTER TABLE report_agent ADD COLUMN {_c} TEXT")
                logger.info("v30 migration: report_agent +trigger_json/tool_policy_json/budget_json")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent",
                    {"trigger_json", "tool_policy_json", "budget_json"}, "v30 migration", e,
                )
            try:
                _aj_cols = {r[1] for r in cursor.execute("PRAGMA table_info(async_jobs)").fetchall()}
                for _c, _t in (("claim_token", "TEXT"), ("spec_claimed_at", "REAL")):
                    if _c not in _aj_cols:
                        cursor.execute(f"ALTER TABLE async_jobs ADD COLUMN {_c} {_t}")
                logger.info("v30 migration: async_jobs +claim_token/spec_claimed_at")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "async_jobs",
                    {"claim_token", "spec_claimed_at"}, "v30 migration", e,
                )

        # === v31: 项目周报 sync 迁入 custom agent 框架 —— 播种 type='project_progress' 单例行 ===
        # S5 W5a（P2 拍板）。把"项目周报邮件 → 触发确定性 xlsx→Notion sync"做成 Agents 页第四种专型
        # 行（type='project_progress'，id='project_progress_sync'）：**无 DDL**（复用 v30 trigger_json 列）。
        # 触发配置（sender/subject）与 enabled 从 env 播种一次 → 之后 Settings 抽屉可改（行权威）；总闸仍
        # 是 env PROJECT_PROGRESS_SYNC_ENABLED。**执行不进 async_jobs / gateway** —— runner 逐字不变，
        # new_watcher hook 仍直调（P1：框架不容纳非 LLM 执行体，项目周报只把触发配置搬进行）。
        #
        # trigger_json 用 email_filter 词汇（subject_pattern/sender_pattern），但 project_progress 走
        # ProjectProgressDetector（子串-sender + 正则-subject），**非** AgentEmailMatcher（正则-sender）—— 逐字
        # 保持子串语义（行为等价）。sender 是 email 子串，作 email_filter regex 校验也能编译（drawer 保存
        # 时经 validate_agent_config_patch），运行时仍子串匹配。env 全空 → 空 pattern（detector 永不匹配 =
        # 现状"全空永不匹配"）。
        #
        # env 值经 pydantic settings 读（serve-api **不** load_dotenv —— 直读 os.environ 会读空，
        # 迁移可能在 serve-api 进程先跑；settings 在两个进程都从 env_file / os.environ 正确填充）。
        # 幂等: INSERT OR IGNORE（旧库已有则跳过、不覆盖用户改过的 enabled/trigger）。
        # 回滚 (回退 v31): DELETE FROM report_agent WHERE id='project_progress_sync'。
        if current_version < 31:
            try:
                from src.config import config as _settings
                _pp_enabled = 1 if getattr(_settings, "project_progress_auto_sync_enabled", False) else 0
                _pp_subject = getattr(_settings, "project_progress_subject_pattern", "") or ""
                _pp_sender = getattr(_settings, "project_progress_sender", "") or ""
            except Exception as e:  # noqa: BLE001 — config 不可得（裸测试环境）→ 安全默认（禁用 + 空触发）
                logger.debug(f"v31 migration: settings unavailable, seed with safe defaults: {e}")
                _pp_enabled, _pp_subject, _pp_sender = 0, "", ""
            _pp_trigger = json.dumps(
                {
                    "v": 1,
                    "kind": "email_filter",
                    "subject_pattern": _pp_subject,
                    "sender_pattern": _pp_sender,
                },
                ensure_ascii=False,
            )
            cursor.execute(
                "INSERT OR IGNORE INTO report_agent "
                "(id, type, enabled, title, model, prompt, tools_json, trigger_json, updated_at) "
                "VALUES ('project_progress_sync', 'project_progress', ?, '项目周报同步', "
                "NULL, NULL, NULL, ?, ?)",
                (_pp_enabled, _pp_trigger, time.time()),
            )
            logger.info(
                f"v31 migration: project_progress_sync seeded "
                f"(enabled={_pp_enabled}, subject={_pp_subject!r}, sender={_pp_sender!r})"
            )

        # === v32: preprocess 行级「处理后自动标已读」开关 ===
        # 新库 CREATE 已含 → PRAGMA 跳过；旧库补 INTEGER 列。NULL 语义仍是默认 true，
        # 但对固定 preprocess 行显式回填 1，便于 Settings 读写与数据审计。UPDATE 幂等。
        if current_version < 32:
            try:
                _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                if "mark_read_after_processing" not in _pa_cols:
                    cursor.execute(
                        "ALTER TABLE report_agent ADD COLUMN mark_read_after_processing INTEGER"
                    )
                    logger.info("v32 migration: report_agent +mark_read_after_processing")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor,
                    "report_agent",
                    {"mark_read_after_processing"},
                    "v32 migration",
                    e,
                )
            cursor.execute(
                "UPDATE report_agent SET mark_read_after_processing = 1 "
                "WHERE id = 'email_preprocess_agent' "
                "AND mark_read_after_processing IS NULL"
            )
            logger.info("v32 migration: preprocess mark_read_after_processing defaulted to 1")

        # === v33: email_metadata.snippet 去规范化正文预览 ===
        if current_version < 33:
            try:
                cursor.execute("PRAGMA table_info(email_metadata)")
                columns = {row[1] for row in cursor.fetchall()}
                if "snippet" not in columns:
                    cursor.execute("ALTER TABLE email_metadata ADD COLUMN snippet TEXT")
                    logger.info("v33 migration: email_metadata +snippet")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "email_metadata", {"snippet"}, "v33 migration", e,
                )
            cursor.execute("""
                UPDATE email_metadata
                   SET snippet = (
                       SELECT substr(b.body_markdown, 1, 100)
                         FROM email_body b
                        WHERE b.internal_id = email_metadata.internal_id
                   )
                 WHERE snippet IS NULL
                   AND EXISTS (
                       SELECT 1 FROM email_body b
                        WHERE b.internal_id = email_metadata.internal_id
                   )
            """)
            logger.info("v33 migration: email_metadata.snippet backfilled")

        # === v34: email_meeting 回填 (recurring_series → email_meeting best-effort) ===
        # 表本身由上面 CREATE TABLE IF NOT EXISTS 建 (新/旧库均生效)。这里只做存量
        # 回填: 每个 recurring_series 的 last_seen_message_id 对应邮件写一条映射行,
        # method=NULL (series 行的 last_seen 可能是 REQUEST 或 CANCEL, 不可考),
        # is_recurring=1。存量非周期邀请无 uid 可回填 (raw MIME 未存)。
        if current_version < 34:
            # 数据回填是 best-effort (映射缺失 = 查询面 404, 可经 replay 路径补),
            # 不同于 schema 建表 (fail-loud): 异常降级 warning 不中断迁移链。
            try:
                cursor.execute("""
                    INSERT OR IGNORE INTO email_meeting (
                        internal_id, ical_uid, method, recurrence_id,
                        sequence, is_recurring, created_at, updated_at
                    )
                    SELECT em.internal_id, rs.series_uid, NULL, NULL,
                           COALESCE(rs.last_sequence, 0), 1, ?, ?
                    FROM recurring_series rs
                    JOIN email_metadata em ON em.message_id = rs.last_seen_message_id
                    WHERE rs.last_seen_message_id IS NOT NULL
                """, (time.time(), time.time()))
                logger.info(
                    f"v34 migration: email_meeting backfilled from recurring_series "
                    f"({cursor.rowcount} rows)"
                )
            except sqlite3.Error as e:
                logger.warning(f"v34 migration: email_meeting backfill skipped: {e}")

        # === v35: calendar_event.tzid (#10 tzid 半步) ===
        # 旧库补列 (新库 CREATE 已含 → PRAGMA 跳过)。无数据回填: NULL = 修复前
        # UTC 语义, 下轮全量 CalDAV sync 重新 upsert 自然带上 tzid。
        if current_version < 35:
            try:
                _ce_cols = {r[1] for r in cursor.execute("PRAGMA table_info(calendar_event)").fetchall()}
                if "tzid" not in _ce_cols:
                    cursor.execute("ALTER TABLE calendar_event ADD COLUMN tzid TEXT")
                    logger.info("v35 migration: calendar_event +tzid")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "calendar_event", {"tzid"}, "v35 migration", e,
                )

        # === v36: email_metadata 草稿线程 linkage 3 列 (compose Bug A) ===
        # 旧库补列 (新库 CREATE 已含 → PRAGMA 跳过)。无数据回填: 存量草稿行 NULL =
        # 修复前语义 (发送不带 threading), 新草稿由 mirror/reconcile 写入。
        if current_version < 36:
            _draft_cols = {
                "draft_source_internal_id": "INTEGER",
                "draft_in_reply_to": "TEXT",
                "draft_references": "TEXT",
            }
            try:
                cursor.execute("PRAGMA table_info(email_metadata)")
                _em_cols = {row[1] for row in cursor.fetchall()}
                for _col, _typ in _draft_cols.items():
                    if _col not in _em_cols:
                        cursor.execute(
                            f"ALTER TABLE email_metadata ADD COLUMN {_col} {_typ}"
                        )
                        logger.info(f"v36 migration: email_metadata +{_col}")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "email_metadata", set(_draft_cols), "v36 migration", e,
                )

        # === v37: llm_processing 纳入版本化建表 (首启缺表修复) ===
        # 表 + 两索引由上面的 v37 段无条件 CREATE ... IF NOT EXISTS 建 (新/旧库均
        # 生效, 幂等), 无数据回填 → 无需 current_version gate (镜像 v22 marker-only
        # + v34 建表模式)。bump 版本号 = 对外承诺「db_version>=37 ⇒ llm_processing
        # 已建」, 供前端 backend_lifecycle.ts 就绪门控 + admin health REQUIRED_TABLES。

        # === v38: preprocess 参考上下文源迁 report_agent 行存储 (task 07-22) ===
        # 新库 CREATE 已含 context_source → PRAGMA 跳过 ALTER；旧库补 TEXT 列。seed 一次性
        # 回填 preprocess 行 (行落地后行权威, env 键降级为首次 seed 默认——镜像 v31
        # project_progress trigger 行内热读先例): env LLM_PREPROCESS_CONTEXT_SOURCE 显式合法值
        # → 写入行; 否则按 LLM_CONTEXT_PAGE_ID 非空 → 'notion_context', 空 → 'standing_docs'
        # (与旧 _resolve_context_source 继承规则逐字一致 → 升级前后注入形态零变化)。
        # env 值经 pydantic settings 读 (serve-api 不 load_dotenv, 但 settings 在两进程都从
        # env_file / os.environ 正确填充, 同 v31 先例)。幂等: ALTER 前 PRAGMA 检查 + 仅回填
        # context_source IS NULL 的固定 preprocess 行 (不覆盖用户改过的值)。
        if current_version < 38:
            try:
                _pa_cols = {r[1] for r in cursor.execute("PRAGMA table_info(report_agent)").fetchall()}
                if "context_source" not in _pa_cols:
                    cursor.execute("ALTER TABLE report_agent ADD COLUMN context_source TEXT")
                    logger.info("v38 migration: report_agent +context_source")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent", {"context_source"}, "v38 migration", e,
                )
            try:
                from src.config import config as _settings
                _raw_src = (getattr(_settings, "llm_preprocess_context_source", "") or "").strip().lower()
                _page_id = (getattr(_settings, "llm_context_page_id", "") or "").strip()
            except Exception as e:  # noqa: BLE001 — config 不可得 (裸测试环境) → 安全继承 (无 env → standing_docs)
                logger.debug(f"v38 migration: settings unavailable, seed via inheritance defaults: {e}")
                _raw_src, _page_id = "", ""
            if _raw_src in ("standing_docs", "notion_context"):
                _seed_src = _raw_src
            else:
                _seed_src = "notion_context" if _page_id else "standing_docs"
            cursor.execute(
                "UPDATE report_agent SET context_source = ? "
                "WHERE id = 'email_preprocess_agent' AND context_source IS NULL",
                (_seed_src,),
            )
            logger.info(f"v38 migration: preprocess context_source seeded to {_seed_src!r}")

        # === v40: email_metadata.in_reply_to (KOS Thread 链接反查) ===
        # 新库 CREATE 已含 in_reply_to → PRAGMA 跳过 ALTER；旧库补 nullable TEXT 列。
        # 无数据回填: 存量行 NULL = 修复前语义 (In-Reply-To 解析后即丢弃), 新邮件由
        # reader/davmail 两条解析路径 + _persist_email_metadata_after_parse 落库
        # (forward-only, 无 backfill re-push)。
        if current_version < 40:
            try:
                cursor.execute("PRAGMA table_info(email_metadata)")
                _em_cols = {row[1] for row in cursor.fetchall()}
                if "in_reply_to" not in _em_cols:
                    cursor.execute("ALTER TABLE email_metadata ADD COLUMN in_reply_to TEXT")
                    logger.info("v40 migration: email_metadata +in_reply_to")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "email_metadata", {"in_reply_to"}, "v40 migration", e,
                )

        # === v41: kos_ingest_log 升格正式表 (issue #59) ===
        # 无条件幂等 (镜像 v37 llm_processing / v22 marker 模式, 无 current_version gate):
        # CREATE IF NOT EXISTS 对新库直接建全形状; 老库若已被 bulk_ingest 惰性建成 6 列
        # 旧形状, PRAGMA 判断后 ALTER 补 4 列; 最后建调度索引 (依赖 next_retry_at,
        # 顺序在补列之后)。D2: 不受 MAILAGENT_KOS_INGEST_ENABLED 影响。
        try:
            ensure_kos_ingest_log_schema(cursor)
        except sqlite3.OperationalError as e:
            # 双重复查: ensure 内建表→补列→建索引三步任一真失败都必须让迁移中断
            # (只查列会吞掉「列全在位但索引没建成」的失败形态)。
            _migration_guard_columns(
                cursor, "kos_ingest_log", set(KOS_INGEST_LOG_RETRY_COLUMNS),
                "v41 migration", e,
            )
            _migration_guard_index(cursor, "idx_kos_ingest_retry", "v41 migration", e)
        # 一次性: 老 bulk 时代遗留的 failed 行 next_retry_at=NULL → 永远不满足重试
        # 扫描的 due 判据 (next_retry_at <= now), 会以"永久积压"形态挂在 Dashboard 上。
        # 给它们排一次立即到期, 让重试 worker 自动收编 (成功→pushed / 仍失败→按退避
        # 重排或转 dead)。gate 在 <41: 41 之后所有 failed 行都由 record_failure 写,
        # 恒带 next_retry_at。
        if current_version < 41:
            _stale = cursor.execute(
                "UPDATE kos_ingest_log SET next_retry_at = ? "
                "WHERE status = 'failed' AND next_retry_at IS NULL",
                (time.time(),),
            ).rowcount
            if _stale:
                logger.info(
                    f"v41 migration: scheduled {_stale} legacy failed "
                    f"kos_ingest_log row(s) for retry"
                )
            # 🔴 ALTER ADD COLUMN 后必须显式回填 (本仓 ALTER+seed 教训): 存量行
            # (生产实测 7471 行) 全是 bulk 写的 —— producer 在 v41 之前从不记账,
            # 所以 source IS NULL ⇒ 'bulk' 是精确回填, 不是猜测。
            _src = cursor.execute(
                "UPDATE kos_ingest_log SET source = 'bulk' WHERE source IS NULL"
            ).rowcount
            if _src:
                logger.info(
                    f"v41 migration: backfilled source='bulk' for {_src} "
                    f"pre-existing kos_ingest_log row(s)"
                )

        # === v42: report_agent avatar identity ===
        # 新库 CREATE 已含列；旧库 additive ALTER。NULL 保持确定性默认，不回填 240 种组合。
        if current_version < 42:
            try:
                cursor.execute("PRAGMA table_info(report_agent)")
                _agent_cols = {row[1] for row in cursor.fetchall()}
                if "avatar_json" not in _agent_cols:
                    cursor.execute("ALTER TABLE report_agent ADD COLUMN avatar_json TEXT")
                    logger.info("v42 migration: report_agent +avatar_json")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent", {"avatar_json"}, "v42 migration", e,
                )

        # === v43: report_agent description ===
        if current_version < 43:
            try:
                cursor.execute("PRAGMA table_info(report_agent)")
                _agent_cols = {row[1] for row in cursor.fetchall()}
                if "description" not in _agent_cols:
                    cursor.execute("ALTER TABLE report_agent ADD COLUMN description TEXT")
                    logger.info("v43 migration: report_agent +description")
            except sqlite3.OperationalError as e:
                _migration_guard_columns(
                    cursor, "report_agent", {"description"}, "v43 migration", e,
                )

        # === v44: Matter aggregate base tables (P1) ===
        if current_version < 44:
            try:
                for ddl in MATTER_TABLE_DDLS:
                    cursor.execute(ddl)
                for ddl in MATTER_INDEX_DDLS:
                    cursor.execute(ddl)
            except sqlite3.OperationalError as e:
                required = {"matter_seq", "matter", "matter_item", "matter_event", "matter_update"}
                present = {
                    row[0]
                    for row in cursor.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                missing = sorted(required - present)
                if missing:
                    raise SyncStoreMigrationError(
                        f"v44 migration: tables still missing {missing}: {e}"
                    ) from e
                raise

        # 更新数据库版本 —— E0-WP3: 只有**全部迁移成功**才会执行到这里。任何迁移块
        # 真失败都会 raise (见 _migration_guard_columns/_migration_guard_index),
        # 沿栈中断本函数 → 本 INSERT 与末尾 commit 都不执行, version 停在旧值 →
        # 下次启动以旧 version 重跑迁移 (各块 PRAGMA/IF NOT EXISTS 幂等, 已落地的
        # 半程不碍重试; 事务内未 commit 的部分随连接回收 ROLLBACK)。
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

    def has_last_max_row_id(self) -> bool:
        """marker 键是否已持久化（区分「真·首次运行」与「合法持久化的 0」, finding F1）。

        get_last_max_row_id() 对「键缺失」和「存了 '0'」都返回 0，无法区分。new_watcher
        首次运行判定必须用本方法——键存在即恢复（哪怕值是 0）：否则 applescript 空邮箱
        baseline 0 重启后被误判首次 → 重定基线 → 停机期间到达的首封邮件被静默跳过。
        """
        return self.get_state('last_max_row_id') is not None

    def clear_last_max_row_id(self) -> bool:
        """删除 marker 键（issue #34 reset：强制上层走 first-run baseline）。

        不能用 set_last_max_row_id(0)：F1 修复后「键存在即恢复」会把 reset 写的 0 当合法
        baseline 恢复 → 跨 backend 沿用外来 id 空间 → 重演 silent-loss/deadlock。删键后
        has_last_max_row_id() 返回 False，上层在当前 backend 重定基线。
        """
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("DELETE FROM sync_state WHERE key = 'last_max_row_id'")
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to clear last_max_row_id: {e}")
                conn.rollback()
                return False

    def reconcile_marker_backend(self, current_backend: str) -> str:
        """issue #34: 防跨 backend 复用 last_max_row_id（不同 id 空间）。

        last_max_row_id 在 applescript 是 Mail.app ROWID、在 davmail 是 IMAP UID，
        两个空间量级/含义都不同。切 backend 时若沿用旧 marker，get_new_emails 会发
        ``UID {外来marker+1}:*``，命中 silent-loss（跳过整段未取区间 → 丢数据）或
        deadlock（超时重刷巨量 → 卡死）。启动时调用一次，按需把 marker 归一到当前 backend。

        用 sync_state KV（key='marker_backend'）记录「当前 marker 属于哪个 backend」，
        复用现有通用 KV 表，无需 schema 变更 / DB_VERSION bump。

        Returns 采取的动作:
          'first'  — 尚无 marker（真·首次运行）；上层 baseline 分支会盖 owner。
          'adopt'  — 本 guard 首次部署遇到既有 marker：认领为当前 backend、不重置
                     （不扰动存量稳态用户）。
          'noop'   — marker 已属当前 backend，无需动。
          'reset'  — marker 属于别的 backend（外来 id 空间）→ 删键，强制上层走 first-run
                     baseline，在新空间重新定基线（只向前，不回捞历史 gap）。
        """
        marker_backend = self.get_state('marker_backend')
        if self.get_state('last_max_row_id') is None:
            # 真·首次运行：无 marker（键缺失）。合法持久化的 '0'（空邮箱 baseline）不再
            # 短路成 'first'——否则跨 backend 的 '0' marker 会绕过下面的归属校验，被上层
            # 「键存在即恢复」(finding F1) 当合法 baseline 恢复 → 重演 #34 id-space 混用。
            return 'first'
        if marker_backend is None:
            # 本 guard 首次部署遇到既有 marker（升级前写的、无归属记录）。**不能盲目认领**当前
            # backend（reporter 场景：升级拿到 fix + 同时切 davmail，盲目 adopt 会把 applescript 的
            # marker 当 davmail 用 → 重演 silent-loss/deadlock）。按 email_metadata 推断归属
            # （codex HIGH + 复审 NEW-ISSUE）：
            #   ① 当前 backend 有既有行 → marker 可信属它 → adopt；
            #   ② 当前 backend 零行但有别的 backend 的行 → 检测到切换 → reset（marker 属外来 id 空间）；
            #   ③ email_metadata 全空 → marker 是孤立 baseline（从别的 backend 切来必留其行，空表即
            #      无切换证据；如全新 davmail 首跑 baseline 了 UIDNEXT 但零邮件入库）→ adopt，不 reset
            #      （否则会误跳过停机期间到达的邮件，codex 复审 NEW-ISSUE）。
            if self._has_rows_for_backend(current_backend):
                self.set_state('marker_backend', current_backend)
                return 'adopt'
            if self._has_any_email_rows():
                self.clear_last_max_row_id()
                self.set_state('marker_backend', current_backend)
                return 'reset'
            self.set_state('marker_backend', current_backend)
            return 'adopt'
        if marker_backend == current_backend:
            return 'noop'
        self.clear_last_max_row_id()
        self.set_state('marker_backend', current_backend)
        return 'reset'

    def _has_rows_for_backend(self, backend: str) -> bool:
        """email_metadata 是否有该 backend 写入的行（judge marker 归属用，codex HIGH）。

        探测失败（DB 错，近乎不可能）→ 保守返回 True（认领、不重置），避免因瞬时错误
        误 reset 掉稳态用户离线期间到达的邮件（reset 只向前定基线、不回捞）。
        """
        try:
            with self._connection() as conn:
                row = conn.execute(
                    "SELECT 1 FROM email_metadata WHERE backend_origin = ? LIMIT 1",
                    (backend,),
                ).fetchone()
                return row is not None
        except sqlite3.Error as e:
            logger.warning(f"[marker-guard] backend_origin 探测失败: {e}; 保守视作有行(adopt)")
            return True

    def _has_any_email_rows(self) -> bool:
        """email_metadata 是否有任何行（区分「空表孤立 baseline」与「切换」，codex 复审 NEW-ISSUE）。

        探测失败 → 保守返回 True（配合上层：当前 backend 零行 + 探测失败 → reset；但探测失败
        近乎不可能，且真·空表下 _has_rows_for_backend 也会走同一 conn，实践中不触发）。
        """
        try:
            with self._connection() as conn:
                row = conn.execute("SELECT 1 FROM email_metadata LIMIT 1").fetchone()
                return row is not None
        except sqlite3.Error as e:
            logger.warning(f"[marker-guard] email_metadata 空表探测失败: {e}; 保守视作有行")
            return True

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

    def update_after_fetch(
        self, internal_id: int, data: Dict[str, Any]
    ) -> UpdateAfterFetchResult:
        """AppleScript 获取成功后更新元数据

        用于 v3 架构：AppleScript 获取成功后，用准确的数据刷新 SyncStore。

        ## message_id UNIQUE 冲突 = 「当前行是重复行」（2026-07-14 幽灵行事故）

        ``email_metadata.message_id`` 是 ``TEXT UNIQUE`` **列约束**（走 sqlite_autoindex,
        在 sqlite_master 里 grep index 的 sql 看不到它）。老实现把 message_id /
        thread_id / subject / sender 拼成一条 UPDATE 直接执行 —— message_id 撞上既有
        行 → **整条 UPDATE 回滚** → 连 sender 都没写进去 → 下游 create_email_page_
        from_sqlite 读 SQLite 拿到 sender='' → Notion 400 → 重试 → 而每轮重试在 400
        之前会先把附件重传一遍（实测 image001_2.png → image001_3.png 后缀递增）。

        冲突不是"写失败重试就好": 语义上等价于「这封邮件已存在, 当前行是重复行」。
        判定对齐 _save_email_v3 的 cross-backend merge guard —— 写之前先按 message_id
        SELECT 真身, 而不是撞了再收拾。

        🔴 铁律: 只有真身 **存在且已 synced** 才认定当前行是重复行 → 物理删除幽灵行
        （CASCADE 清 body/attachment/outbox, 不进 pending/retry 队列, 不污染死信告警）。
        真身未 synced = 无法判定谁是真身 → 谁都不动, 返回 FAILED 留人工处置。宁可留一行
        垃圾, 不能吞一封真邮件。

        Args:
            internal_id: 邮件内部 ID
            data: 要更新的字段（message_id, subject, sender, date_received, thread_id 等）

        Returns:
            UpdateAfterFetchResult —— 调用方必须区分 DUPLICATE（中止本封, 勿再
            mark_failed 把它拉回重试队列）与 FAILED（不得静默吞掉）。
        """
        if not data:
            return UpdateAfterFetchResult.OK

        now = time.time()

        # 构建 SET 子句
        allowed_fields = {
            'message_id', 'thread_id', 'subject', 'sender', 'sender_name',
            'to_addr', 'cc_addr', 'date_received', 'is_read', 'is_flagged',
            'sync_status', 'sync_error',
            'is_important',  # v9 — 邮件原生重要性（reader._parse_importance 提取）
            'in_reply_to',   # v40 — 直接父邮件 message_id（KOS Thread 链接反查）
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
            return UpdateAfterFetchResult.OK

        set_parts.append("updated_at = ?")
        values.append(now)
        values.append(internal_id)

        new_message_id = data.get('message_id')

        with self._connection() as conn:
            cursor = conn.cursor()

            try:
                # === message_id UNIQUE 冲突 guard（对齐 _save_email_v3 的 cross-backend
                # merge: 写之前先 SELECT 真身）===
                # 仅 message_id 非空时检查（None 不触发 UNIQUE 约束, 是 v3 pending 邮件）。
                if new_message_id:
                    owner = cursor.execute(
                        "SELECT internal_id, sync_status, notion_page_id "
                        "FROM email_metadata WHERE message_id = ?",
                        (new_message_id,),
                    ).fetchone()
                    if owner is not None and owner['internal_id'] != internal_id:
                        return self._resolve_message_id_conflict(
                            conn, cursor, internal_id, new_message_id, owner
                        )

                query = f"""
                    UPDATE email_metadata
                    SET {', '.join(set_parts)}
                    WHERE internal_id = ?
                """
                cursor.execute(query, values)
                conn.commit()
                logger.debug(f"Updated email after fetch: internal_id={internal_id}")
                return UpdateAfterFetchResult.OK

            except sqlite3.Error as e:
                logger.error(f"Failed to update after fetch: {e}")
                conn.rollback()
                return UpdateAfterFetchResult.FAILED

    def _resolve_message_id_conflict(
        self,
        conn: sqlite3.Connection,
        cursor: sqlite3.Cursor,
        internal_id: int,
        message_id: str,
        owner: sqlite3.Row,
    ) -> UpdateAfterFetchResult:
        """update_after_fetch 撞 message_id UNIQUE 时的判定 + 终结。

        判据见 update_after_fetch 文档: 真身已 synced 才敢认定当前行是重复行。
        两个分支都留下可事后追溯"是哪两行撞了"的日志。

        DUPLICATE 分支物理删除幽灵行（Fable review 2026-07-15）: 标 skipped 会留三条
        尾巴 —— 列表默认不按 sync_status 过滤(幽灵行与真身并排重复显示)、email_body
        双写在库致 FTS5 双命中、skipped 不进死信面板故需求 3 的删除按钮够不到。改为
        DELETE 靠 _get_connection 的 foreign_keys=ON CASCADE 一并清 body/attachment/
        outbox。判据已严到确证是垃圾行 → 与 owner 2026-07-15 手动清 10 行(同走
        delete_email_full)一致。**只删幽灵行**, 真身零触碰。
        """
        owner_iid = owner['internal_id']
        owner_status = owner['sync_status']

        if owner_status != 'synced':
            # 真身未 synced → 两行都可能是真邮件 → 不可判定 → 谁都不动, 留人工处置。
            logger.error(
                f"[sync_store] update_after_fetch message_id conflict: "
                f"message_id={message_id[:60]!r} owned by internal_id={owner_iid} "
                f"(sync_status={owner_status!r} — not synced, cannot tell which row is "
                f"real); refusing to touch either row, internal_id={internal_id} left "
                f"for manual triage"
            )
            return UpdateAfterFetchResult.FAILED

        # 真身存在且已 synced → 当前行是重复行（幽灵行）→ 物理删除。
        # 只删幽灵行(WHERE internal_id = 当前行): 真身那一行零触碰。
        # foreign_keys=ON (_get_connection 开) → CASCADE 清 body/attachment/outbox。
        cursor.execute(
            "DELETE FROM email_metadata WHERE internal_id = ?",
            (internal_id,),
        )
        conn.commit()
        logger.warning(
            f"[sync_store] duplicate row resolved: message_id={message_id[:60]!r} "
            f"already at internal_id={owner_iid} (sync_status='synced', "
            f"notion_page_id={owner['notion_page_id']!r}); physically deleted "
            f"duplicate internal_id={internal_id} (CASCADE body/attachment/outbox) "
            f"— no further retry"
        )
        return UpdateAfterFetchResult.DUPLICATE

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

    def update_notion_page_id(self, internal_id: int, notion_page_id: str) -> bool:
        """窄回写：只 UPDATE notion_page_id + updated_at，不动其它列。

        区别于 ``mark_synced_v3``（会一并 SET notion_thread_id / sync_status /
        清 retry 态）。resync ``--replace-existing`` 建新页 + archive 老页后回写用：
        DB 若不更新 notion_page_id 会指向已 archived 死页，后续 flag fanout 打死页。

        Returns:
            是否有行被更新
        """
        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET notion_page_id = ?,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (notion_page_id, now, internal_id))
                conn.commit()
                return cursor.rowcount > 0
            except sqlite3.Error as e:
                logger.error(f"Failed to update notion_page_id for internal_id={internal_id}: {e}")
                conn.rollback()
                return False

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

    def mark_synced_local(self, internal_id: int) -> bool:
        """标记为已同步（本地-only，无 Notion 页）。

        草稿箱等仅入本地 SQLite（不进 Notion）的邮件用：sync_status='synced' 但
        notion_page_id 保持 NULL。SSE 同 mark_synced_v3 发 email.synced 让前端
        刷新列表/badge。
        """
        now = time.time()
        ok = False
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute("""
                    UPDATE email_metadata
                    SET sync_status = 'synced',
                        sync_error = NULL,
                        next_retry_at = NULL,
                        updated_at = ?
                    WHERE internal_id = ?
                """, (now, internal_id))
                conn.commit()
                logger.debug(f"Marked synced (local-only): internal_id={internal_id}")
                ok = True
            except sqlite3.Error as e:
                logger.error(f"Failed to mark synced local: {e}")
                conn.rollback()
                ok = False

        if ok:
            try:
                from src.events.publisher import safe_publish
                safe_publish(
                    "email.synced",
                    internal_id=internal_id,
                    data={"local_only": True},
                    source="new_watcher",
                )
            except Exception:
                pass
        return ok

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

    def update_draft_linkage(
        self,
        internal_id: int,
        *,
        draft_in_reply_to: Optional[str],
        draft_references: Optional[str],
        draft_source_internal_id: Optional[int],
        thread_id: Optional[str] = None,
        overwrite_thread_id: bool = False,
    ) -> bool:
        """草稿行 linkage 懒自愈回写 (compose 优化 epic, codex finding 1)。

        v36 迁移前的存量草稿行 draft_* 三列全 NULL 且 reconcile 永不回填 —— 消费端
        (MailWriteService._heal_draft_linkage) 从 davmail 取草稿 MIME 头解析出
        linkage 后调本方法落列。draft_* 三列按参数直写; ``thread_id`` 默认走
        COALESCE 只填空。``overwrite_thread_id=True`` (自愈回写, codex 批次2
        finding 6) 直写覆盖 —— healed 头派生的 root 为权威, 存量行的 RFC2047 碎片
        等坏 thread_id 不再被 COALESCE 保留。

        Returns: True=更新成功; False=SQL 错误 (调用方仅 warning, 自愈是 best-effort)。
        """
        thread_sql = (
            "thread_id = ?" if overwrite_thread_id
            else "thread_id = COALESCE(thread_id, ?)"
        )
        with self._connection() as conn:
            try:
                conn.execute(
                    "UPDATE email_metadata SET draft_in_reply_to = ?, "
                    "draft_references = ?, draft_source_internal_id = ?, "
                    f"{thread_sql}, updated_at = ? "
                    "WHERE internal_id = ?",
                    (
                        draft_in_reply_to,
                        draft_references,
                        draft_source_internal_id,
                        thread_id,
                        time.time(),
                        internal_id,
                    ),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to update draft linkage for {internal_id}: {e}")
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
                    if status == 'fetch_failed' and is_sent_mailbox(mailbox):
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
                        "notion_thread_id, thread_id, backend_origin, mailbox "
                        "FROM email_metadata WHERE message_id = ?",
                        (message_id,),
                    ).fetchone()
                    if existing is not None and existing['internal_id'] != internal_id:
                        # 跨 backend 切换产生的 dup. UPDATE 老 row 的 davmail 字段,
                        # 保留同步状态.
                        old_iid = existing['internal_id']
                        old_origin = existing['backend_origin']
                        new_origin = email.get('backend_origin', 'applescript')
                        new_mailbox = email.get('mailbox')
                        # Draft→Sent 提升: 外部 (OWA/Outlook) 从草稿发送的邮件, 发送后
                        # Draft 跨文件夹移到 Sent (Message-ID 不变), Sent 副本经 msgid
                        # 合并进原草稿行。若只更 imap_uid 而保留 mailbox='草稿箱', 同一
                        # poll cycle 的 reconcile_drafts 会把它当"消失草稿"删除 → 已发
                        # 邮件本地记录被销毁 (纯本地丢失, 服务端 Sent 完好)。既有行是
                        # 草稿、新副本来自 Sent → 归一提升 mailbox='发件箱' 阻断删除, 并
                        # 置 pending + 清重试态, 让它像其它发件箱邮件重取正文 + 进 Notion。
                        # 显式 gate 在 SENT_MAILBOX_LABELS (而非"任意非草稿"): 避免同 msgid
                        # 副本先从非 Sent 文件夹进入时误提升到错误 mailbox (codex review)。
                        promote_sent = bool(
                            existing['mailbox'] in DRAFT_MAILBOX_LABELS
                            and new_mailbox in SENT_MAILBOX_LABELS
                        )
                        logger.info(
                            f"[sync_store] cross-backend merge: message_id={message_id[:40]!r} "
                            f"already at internal_id={old_iid} (origin={old_origin!r}); "
                            f"merging new internal_id={internal_id} (origin={new_origin!r}) "
                            + (
                                f"— promote 草稿箱→{SENT_CANONICAL_LABEL} + re-sync (sent from draft)"
                                if promote_sent
                                else "— keep notion_page_id/sync_status, update imap_uid"
                            )
                        )
                        # 提升 SET 片段全是常量字面量 (归一 label='发件箱' + 置 pending +
                        # 清同步/重试态), 无占位符、无注入面 → params 两分支完全一致。
                        promote_set = (
                            ", mailbox = '发件箱', sync_status = 'pending', "
                            "sync_error = NULL, retry_count = 0, next_retry_at = NULL"
                            if promote_sent else ""
                        )
                        cursor.execute(
                            f"""UPDATE email_metadata
                               SET imap_uid = COALESCE(?, imap_uid),
                                   imap_uidvalidity = COALESCE(?, imap_uidvalidity),
                                   thread_id = COALESCE(thread_id, ?),
                                   sender_name = COALESCE(NULLIF(sender_name, ''), ?),
                                   to_addr = COALESCE(NULLIF(to_addr, ''), ?),
                                   cc_addr = COALESCE(NULLIF(cc_addr, ''), ?){promote_set},
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
                     draft_source_internal_id, draft_in_reply_to, draft_references,
                     in_reply_to,
                     created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                            ?, ?, ?,
                            ?, ?, ?,
                            ?,
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
                    email.get('draft_source_internal_id'),
                    email.get('draft_in_reply_to'),
                    email.get('draft_references'),
                    email.get('in_reply_to'),
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

    def get_processing_statuses(self, internal_ids: List[int]) -> Dict[int, str]:
        """批量读 processing_status（只含非空行，不过滤 sync_status）。

        供 MailWriteService.set_flags 的「置旗复活已完成邮件」不变量判断用：
        EmailMetadataRecord 不含 processing_status，这里补一个最小只读面。
        """
        if not internal_ids:
            return {}

        result: Dict[int, str] = {}
        with self._connection() as conn:
            cursor = conn.cursor()
            batch_size = 500
            for i in range(0, len(internal_ids), batch_size):
                batch = internal_ids[i:i + batch_size]
                placeholders = ','.join('?' * len(batch))
                cursor.execute(f"""
                    SELECT internal_id, processing_status
                    FROM email_metadata
                    WHERE internal_id IN ({placeholders})
                      AND processing_status IS NOT NULL
                """, batch)
                for row in cursor.fetchall():
                    result[row[0]] = row[1]
        return result

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

    def mark_read_if_unread_on_conn(
        self,
        conn: sqlite3.Connection,
        internal_id: int,
        expected_updated_at: Optional[float],
    ) -> bool:
        """CAS 置已读: **仅当该行仍是未读、且 updated_at 与快照一致时**把 is_read 翻
        True, 返回是否真的改到。

        借用调用方的连接与事务 (issue #58 入向已读回收把「校验 + 本地镜像 + outbox
        入队」放进同一个 BEGIN IMMEDIATE), 故这里**不 commit**。

        🔴 为什么不是无条件 UPDATE: 服务器 FLAGS 复核到写库之间用户可能刚把这封标成
        未读 —— 无条件写会把用户显式的「标为未读」吞掉, 且本功能单向 (只做未读→已读),
        后续周期**不会**自愈。
        🔴 为什么 ``is_read = 0`` 还不够、要连 ``updated_at`` 一起比: 用户标未读会把
        本地写回 is_read=0 (值与快照相同), 只比 is_read 看不出"这中间发生过一次写"。
        大批量收敛时队尾邮件距快照可达数秒, 足够「用户标未读 + outbox intent 派发完成
        (于是 has_pending 也归 false)」跑完 —— 那一封就会被静默改回已读。updated_at
        是那次写留下的唯一痕迹。rowcount==0 = 期间被动过 → 调用方放弃该封, 下轮重判
        (保守失败: 顶多晚一个周期收敛, 绝不覆盖用户操作)。旗标 / processing_status
        一概不碰。
        """
        cursor = conn.execute(
            """
            UPDATE email_metadata
               SET is_read = 1, updated_at = ?
             WHERE internal_id = ? AND is_read = 0 AND updated_at IS ?
            """,
            (time.time(), internal_id, expected_updated_at),
        )
        return cursor.rowcount > 0

    def get_inbox_unread_for_read_reconcile(
        self, mailbox: str = INBOX_LABEL
    ) -> List[Dict[str, Any]]:
        """入向已读回收 (issue #58) 专用: 取某 mailbox 下本地未读行的
        internal_id + imap_uid + imap_uidvalidity + updated_at。

        只读、无副作用。davmail 入向 read-reconcile 用它做**候选集**来源 (本地未读 ∧
        不在服务器 UNSEEN 集 → 候选, 再经定向 FETCH FLAGS 复核才收敛)。imap_uid /
        imap_uidvalidity 为 NULL 的行 (AppleScript 路径) 由上层 uidvalidity 一致性
        闸自然过滤。updated_at 供提交时的 CAS 比对 (见 mark_read_if_unread_on_conn:
        本轮期间被写过的行一律放弃)。不返 is_flagged: 收敛只动 is_read, 不做全量置态。

        mailbox 按 `filter_labels_for_mailbox` 展开成变体集 IN 查 (内建 canonical
        禁止 `= ?` 精确匹配, 见 CLAUDE.md mailbox 语义单源纪律)。
        """
        predicate, params = sql_in_predicate(
            "mailbox", filter_labels_for_mailbox(mailbox)
        )
        with self._connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                f"""
                SELECT internal_id, imap_uid, imap_uidvalidity, updated_at
                FROM email_metadata
                WHERE is_read = 0 AND {predicate}
                """,
                params,
            )
            return [
                {
                    "internal_id": row["internal_id"],
                    "imap_uid": row["imap_uid"],
                    "imap_uidvalidity": row["imap_uidvalidity"],
                    "updated_at": row["updated_at"],
                }
                for row in cursor.fetchall()
            ]

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
    # v34: email_meeting (邮件 ↔ 日历 ical_uid 映射)
    # ============================================================

    def upsert_email_meeting(
        self,
        internal_id: int,
        *,
        ical_uid: str,
        method: Optional[str] = None,
        recurrence_id: Optional[str] = None,
        sequence: int = 0,
        is_recurring: bool = False,
    ) -> bool:
        """写入/更新一封邮件的会议 uid 映射行 (PK=internal_id, upsert)。

        new_watcher 会议检测 hook / recurring_invite.replay_one 调用。
        失败仅记 error 不抛 (映射是旁路增强, 不阻断主 sync 流程)。
        """
        if not ical_uid:
            return False
        now = time.time()
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    """
                    INSERT INTO email_meeting (
                        internal_id, ical_uid, method, recurrence_id,
                        sequence, is_recurring, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (internal_id) DO UPDATE SET
                        ical_uid      = excluded.ical_uid,
                        method        = excluded.method,
                        recurrence_id = excluded.recurrence_id,
                        sequence      = excluded.sequence,
                        is_recurring  = excluded.is_recurring,
                        updated_at    = excluded.updated_at
                    """,
                    (
                        internal_id, ical_uid, method, recurrence_id,
                        int(sequence or 0), int(bool(is_recurring)), now, now,
                    ),
                )
                conn.commit()
                return True
            except sqlite3.Error as e:
                logger.error(f"Failed to upsert_email_meeting {internal_id}: {e}")
                conn.rollback()
                return False

    def get_email_meeting(self, internal_id: int) -> Optional[Dict[str, Any]]:
        """读取一封邮件的会议 uid 映射行。"""
        with self._connection() as conn:
            cursor = conn.cursor()
            try:
                cursor.execute(
                    "SELECT * FROM email_meeting WHERE internal_id = ?",
                    (internal_id,),
                )
                row = cursor.fetchone()
                return dict(row) if row else None
            except sqlite3.Error as e:
                logger.error(f"Failed to get_email_meeting {internal_id}: {e}")
                return None

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

    def was_island_notified(
        self,
        *,
        event_type: str,
        internal_id: Optional[int] = None,
        session_key: Optional[str] = None,
        within_sec: float = 300.0,
    ) -> bool:
        """契约 §9-2: 是否在 ``within_sec`` 内已**成功**派发过同 (event_type, 邮件) envelope.

        dedup 持久化去重源：查 island_dispatch 表最近成功 (``dispatched_ok=1``) 派发行。
        跨进程重启有效（``island_dispatch._dedup_seen`` 内存重启即丢，这里从 SQLite 恢复）。
        按 ``internal_id`` 优先匹配（系统事件无 internal_id 时退回 ``session_key``）。
        查不到 / 出错 → ``False``（放行，fail-open：不因去重 bug 丢通知）。
        """
        if internal_id is None and not session_key:
            return False
        since = time.time() - max(within_sec, 0.0)
        try:
            with self._connection() as conn:
                cursor = conn.cursor()
                if internal_id is not None:
                    cursor.execute(
                        """
                        SELECT 1 FROM island_dispatch
                         WHERE event_type = ? AND internal_id = ?
                           AND dispatched_ok = 1 AND sent_at > ?
                         LIMIT 1
                        """,
                        (event_type, int(internal_id), since),
                    )
                else:
                    cursor.execute(
                        """
                        SELECT 1 FROM island_dispatch
                         WHERE event_type = ? AND session_key = ?
                           AND dispatched_ok = 1 AND sent_at > ?
                         LIMIT 1
                        """,
                        (event_type, session_key, since),
                    )
                return cursor.fetchone() is not None
        except sqlite3.Error as e:
            logger.debug(f"was_island_notified query failed: {e}")
            return False

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
