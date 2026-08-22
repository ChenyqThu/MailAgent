"""KOS 入库台账 (kos_ingest_log) 读写 + 错误码分类 + 重试排程 + 健康指标 (issue #59)。

生产实测 (2026-07-24): 自部署 KOS 卡死 35 分钟, producer 推送全部失败且
fire-and-forget 直接丢弃 → 101 封邮件在 SQLite/Notion 正常但 KOS 永久空洞
(+69 条图谱边挂不上)。本模块把「不阻塞」和「不补偿」拆开: 主流程仍绝不被
KOS 拖垮, 但每次成功/跳过/失败都落台账, 瞬时失败进重试队列由
new_watcher._run_kos_retry_cycle 低频补偿。

Schema (单源 = src/mail/sync_store.py KOS_INGEST_LOG_TABLE_DDL, v41 migration 建):
    internal_id PK / slug / status(pushed|failed|dead|skipped) / chunks / error /
    pushed_at(最后记录时间, 沿 bulk 既有语义: 非 pushed 行也写) /
    retry_count(已消耗重试次数, 首次失败=0) / next_retry_at / error_code / source

sync_state 指标键 (kos.* 前缀, 镜像 davmail.* 先例, 不 bump DB_VERSION)。
🔴 跨 lane 契约: 键名 canonical = 本模块 STATE_* 常量, 读侧 (src/kos/stats.py)
必须 import 这些常量而非手抄 (CLAUDE.md「跨语言手抄常量必建一致性闸」):
    kos.last_success_at              — 最近一次成功推送, ISO 字符串
                                       (对齐 davmail_properties synced_at 先例)
    kos.health.status                — 'ok' | 'error' (最近一次探活; 缺失=从未探活)
    kos.health.checked_at            — 最近一次探活时间, ISO 字符串
    kos.health.error                 — 最近一次探活失败原因 ('' = ok)
    kos.health.consecutive_failures  — 连续探活失败次数, 整数字符串 (恢复归 0)

所有函数都是**同步阻塞** sqlite3 —— 调用方 (producer / new_watcher) 必须
``asyncio.to_thread`` 出去, 且写台账失败只 warning 不上抛 (fire-and-forget 纪律)。
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime
from typing import Optional

from loguru import logger

from src.notify.center import NotifyCenter

# ---- 错误码分类 (PRD §2.2 / D3) ---------------------------------------------
# 永久类: 直接终态 dead, 不占重试预算 (重试 100 次也不会好: 配置/凭据/协议问题)。
# E_KOS_HTTP 按 status 二分: 5xx 瞬时 / 4xx 永久; 拿不到 status 保守按永久
# (避免对 4xx 无限重试烧预算, D3 拍板)。
# 不在两个集合里的 code (E_KOS_TOOL_ERROR / E_KOS_UNEXPECTED / 未来新增) 按瞬时:
# 重试有界 (max_attempts 后转 dead), 真永久的最多白试几次自行落 dead;
# 反过来把瞬时误判成永久 = 永久空洞, 正是 #59 要修的事。
PERMANENT_ERROR_CODES = frozenset({
    "E_KOS_NOT_CONFIGURED",
    "E_KOS_UNAUTHORIZED",
    "E_KOS_TOKEN_INVALID",
    "E_KOS_PARSE",
    "E_KOS_RPC",
})
TRANSIENT_ERROR_CODES = frozenset({
    "E_KOS_NETWORK",
    "E_KOS_TOKEN_NETWORK",
    "E_KOS_TOKEN_HTTP",
    "E_KOS_RATE_LIMIT",
    "E_KOS_HEALTH",
})

# 指数退避表 (秒): 1min / 5min / 15min / 1h / 6h。retry_count 超表长复用末档。
BACKOFF_SCHEDULE_SEC = (60, 300, 900, 3600, 21600)

# ---- 等标签延迟首推 (deferred first-push, issue #64 Lane A) -----------------
# 增量 hook 曾在 LLM hook (fire-and-forget) 之后立刻同步读 labels → 100% 读空
# (实测 83/83 封平均早读 911s): floor 恒按 normal 放行、页面无 AI 标签、
# KOS_REQUIRE_LABELED 一开即全 skipped。修法 = 会跑 LLM 的邮件先落 status='pending'
# 行排队, 由 6c 重试扫描在 llm_processing 终态 (success/gave_up) 后首推。
# retry_count 在 pending 行上复用为「已检查轮数」(行转 failed 后按失败重试计数重算)。
DEFER_CHECK_INTERVAL_SEC = 60  # 每轮就绪检查间隔 (LLM 含队列积压平均 ~15min)
# 等待轮数上限 (≈1h 兜底): llm_processing 状态机正常必达终态 (6b 重试有界 →
# gave_up), 这道闸兜「LLM hook dispatch 自身失败 → 永远无行」的孤例
# (实测 internal_id=1000010856), 超限后无标签也推 —— 等标签绝不能把
# 「数据质量问题」变成「数据丢失问题」。
DEFER_MAX_CHECKS = 60

# ---- sync_state 键名 (跨 lane 契约) -----------------------------------------
STATE_LAST_SUCCESS_AT = "kos.last_success_at"
STATE_HEALTH_STATUS = "kos.health.status"
STATE_HEALTH_CHECKED_AT = "kos.health.checked_at"
STATE_HEALTH_ERROR = "kos.health.error"
STATE_HEALTH_CONSEC_FAILURES = "kos.health.consecutive_failures"

_ERROR_TEXT_CAP = 300  # error 列截断 (沿 bulk str(e)[:300] 既有口径)


def is_transient_error(code: Optional[str], status: Optional[int] = None) -> bool:
    """KOSError.code (+ HTTP status) → 是否值得进重试队列。"""
    if code == "E_KOS_HTTP":
        try:
            return status is not None and int(status) >= 500
        except (TypeError, ValueError):
            return False
    if code in PERMANENT_ERROR_CODES:
        return False
    return True


def _connect(db_path: str) -> sqlite3.Connection:
    # 短 busy timeout: 台账是补偿性记录, 别的 writer 持锁时宁可这次失败 (只
    # warning), 也不让 producer 的后台任务在锁上挂 30s。
    return sqlite3.connect(db_path, timeout=5)


def _set_states(conn: sqlite3.Connection, pairs: dict[str, str]) -> None:
    now = time.time()
    conn.executemany(
        "INSERT OR REPLACE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)",
        [(k, v, now) for k, v in pairs.items()],
    )


def record_pushed(
    db_path: str, internal_id: int, slug: str, chunks: int, source: str
) -> None:
    """put_page 成功 → status='pushed', 清空重试字段, 刷新 kos.last_success_at (ISO)。"""
    now = time.time()
    conn = _connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO kos_ingest_log
                (internal_id, slug, status, chunks, error, pushed_at,
                 retry_count, next_retry_at, error_code, source)
            VALUES (?, ?, 'pushed', ?, NULL, ?, 0, NULL, NULL, ?)
            ON CONFLICT(internal_id) DO UPDATE SET
                slug=excluded.slug, status='pushed', chunks=excluded.chunks,
                error=NULL, pushed_at=excluded.pushed_at,
                retry_count=0, next_retry_at=NULL, error_code=NULL,
                source=excluded.source
            """,
            (internal_id, slug, chunks, now, source),
        )
        _set_states(conn, {STATE_LAST_SUCCESS_AT: datetime.now().isoformat()})
        conn.commit()
    finally:
        conn.close()


def record_skipped(
    db_path: str, internal_id: int, slug: str, reason: str, source: str
) -> None:
    """过滤跳过 (floor / unlabeled / not_configured / dry_run) → status='skipped'。

    guard: 不覆盖 'pushed' (已入库的事实比"这次被过滤"强)。**有意覆盖** failed/dead:
    重试路径重判时 labels/配置已变、当前过滤条件下这封不再够格入库 → 收敛为
    skipped 退出重试队列 (bulk --retry-failed 仍可捞), 否则该行会被永远重扫。
    """
    conn = _connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO kos_ingest_log
                (internal_id, slug, status, chunks, error, pushed_at,
                 retry_count, next_retry_at, error_code, source)
            VALUES (?, ?, 'skipped', NULL, ?, ?, 0, NULL, NULL, ?)
            ON CONFLICT(internal_id) DO UPDATE SET
                slug=excluded.slug, status='skipped', chunks=NULL,
                error=excluded.error, pushed_at=excluded.pushed_at,
                retry_count=0, next_retry_at=NULL, error_code=NULL,
                source=excluded.source
            WHERE kos_ingest_log.status != 'pushed'
            """,
            (internal_id, slug, f"skip: {reason}", time.time(), source),
        )
        conn.commit()
    finally:
        conn.close()


def _max_attempts() -> int:
    """重试上限 (MAILAGENT_KOS_RETRY_MAX_ATTEMPTS)。settings 不可得 (裸测试环境) → 5。"""
    try:
        from src.config import config as settings

        return max(1, int(getattr(settings, "kos_retry_max_attempts", 5)))
    except Exception:  # noqa: BLE001
        return 5


def record_failure(
    db_path: str,
    internal_id: int,
    slug: str,
    error_code: str,
    error_msg: str,
    source: str,
    transient: bool,
    max_attempts: Optional[int] = None,
) -> str:
    """推送失败落台账, 返回落定的 status ('failed' | 'dead')。

    - 永久类 (transient=False) → 直接 'dead' (不占重试预算, 验收标准 4)。
    - 瞬时类首次失败 (无行 / 行不在 failed 态) → retry_count=0,
      next_retry_at = now + BACKOFF_SCHEDULE_SEC[0]。
    - 瞬时类重试再失败 (行已是 failed) → retry_count+1, 按表退避;
      达 max_attempts → 'dead' (验收标准 5)。
    """
    if max_attempts is None:
        max_attempts = _max_attempts()
    now = time.time()
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT status, retry_count FROM kos_ingest_log WHERE internal_id = ?",
            (internal_id,),
        ).fetchone()
        prev_failed = row is not None and row[0] == "failed"
        prev_count = int(row[1] or 0) if prev_failed else 0

        if not transient:
            new_status, new_count, next_at = "dead", prev_count, None
        elif prev_failed:
            new_count = prev_count + 1
            if new_count >= max_attempts:
                new_status, next_at = "dead", None
            else:
                new_status = "failed"
                next_at = now + BACKOFF_SCHEDULE_SEC[
                    min(new_count, len(BACKOFF_SCHEDULE_SEC) - 1)
                ]
        else:
            new_status, new_count = "failed", 0
            next_at = now + BACKOFF_SCHEDULE_SEC[0]

        conn.execute(
            """
            INSERT INTO kos_ingest_log
                (internal_id, slug, status, chunks, error, pushed_at,
                 retry_count, next_retry_at, error_code, source)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(internal_id) DO UPDATE SET
                slug=excluded.slug, status=excluded.status, chunks=NULL,
                error=excluded.error, pushed_at=excluded.pushed_at,
                retry_count=excluded.retry_count,
                next_retry_at=excluded.next_retry_at,
                error_code=excluded.error_code, source=excluded.source
            """,
            (internal_id, slug, new_status, (error_msg or "")[:_ERROR_TEXT_CAP],
             now, new_count, next_at, error_code, source),
        )
        conn.commit()
        if new_status == "dead":
            _notify_dead(db_path, internal_id=internal_id, slug=slug, error_code=error_code)
        return new_status
    finally:
        conn.close()


def _notify_dead(db_path: str, *, internal_id: int, slug: str, error_code: str) -> None:
    """推送放弃 (status='dead') → system/warn 聚合通知 (design §7「KOS 推送放弃 dead」行)。

    dedupe_key 固定为 kos_ingest:dead —— 每条新 dead 都计次到同一活跃行 (聚合计次,
    不逐条开行); 通知路径绝不影响台账写入 (design §3.3 同款纪律): 整段 try 吞 + warning。
    link 落 /settings?tab=integrations (frontend/src/shared/router-instance.tsx
    SETTINGS_TABS 含 'integrations'; KOS 能力面板挂在该 tab 下)。
    """
    try:
        NotifyCenter(db_path).publish(
            category="system",
            source="kos",
            severity="warn",
            title="KOS 推送放弃",
            body=f"internal_id={internal_id} slug={slug} 错误码：{error_code}",
            dedupe_key="kos_ingest:dead",
            payload={
                "link": {"type": "route", "to": "/settings", "search": {"tab": "integrations"}},
                "internal_id": internal_id,
                "error_code": error_code,
            },
        )
    except Exception as e:  # noqa: BLE001 — 通知路径绝不影响台账写入
        logger.warning(f"[kos-ingest-log] notify_center publish failed internal_id={internal_id}: {e}")


def due_retry_count(db_path: str, now: Optional[float] = None) -> int:
    """到期待重试行数 (status='failed' AND next_retry_at <= now)。"""
    if now is None:
        now = time.time()
    conn = _connect(db_path)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM kos_ingest_log "
            "WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?",
            (now,),
        ).fetchone()
        return int(row[0])
    finally:
        conn.close()


def claim_due_retries(
    db_path: str, limit: int, now: Optional[float] = None
) -> list[int]:
    """到期待重试的 internal_id, 按 next_retry_at 升序有界取 (单轮 chunk 上限)。

    无并发 claim 标记: 重试 worker 单实例 + _kos_retry_running 防重叠, 且
    put_page 覆盖写幂等 —— 偶发重复推无害。
    """
    if now is None:
        now = time.time()
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT internal_id FROM kos_ingest_log "
            "WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ? "
            "ORDER BY next_retry_at ASC LIMIT ?",
            (now, int(limit)),
        ).fetchall()
        return [int(r[0]) for r in rows]
    finally:
        conn.close()


def record_deferred(db_path: str, internal_id: int, slug: str, source: str) -> None:
    """会跑 LLM 的邮件入队等标签 → status='pending', 首查 DEFER_CHECK_INTERVAL_SEC 后。

    guard: 不覆盖 'pushed' (已入库的事实更强; 邮件 fetch 重试成功后 hook 会重触发)。
    覆盖其余状态 (pending 重置等待 / failed·dead·skipped 邮件重新同步了就重新判) ——
    镜像 record_skipped 的 guard 口径。
    """
    now = time.time()
    conn = _connect(db_path)
    try:
        conn.execute(
            """
            INSERT INTO kos_ingest_log
                (internal_id, slug, status, chunks, error, pushed_at,
                 retry_count, next_retry_at, error_code, source)
            VALUES (?, ?, 'pending', NULL, 'defer: await_llm_labels', ?, 0, ?, NULL, ?)
            ON CONFLICT(internal_id) DO UPDATE SET
                slug=excluded.slug, status='pending', chunks=NULL,
                error=excluded.error, pushed_at=excluded.pushed_at,
                retry_count=0, next_retry_at=excluded.next_retry_at,
                error_code=NULL, source=excluded.source
            WHERE kos_ingest_log.status != 'pushed'
            """,
            (internal_id, slug, now, now + DEFER_CHECK_INTERVAL_SEC, source),
        )
        conn.commit()
    finally:
        conn.close()


def claim_due_deferred(
    db_path: str, limit: int, now: Optional[float] = None
) -> list[tuple[int, int]]:
    """到期待检查的 deferred 行 → [(internal_id, 已检查轮数)], next_retry_at 升序有界。

    与 claim_due_retries 互不相扰 (status 值域不同)。无并发 claim 标记的理由同
    claim_due_retries: 重试 worker 单实例 + put_page 覆盖写幂等。partial index
    idx_kos_ingest_retry 只盖 failed —— pending 是分钟级瞬态、行数个位到两位数,
    全表扫 (万行级主键表) 亚毫秒, 不值得为它动表结构。
    """
    if now is None:
        now = time.time()
    conn = _connect(db_path)
    try:
        rows = conn.execute(
            "SELECT internal_id, retry_count FROM kos_ingest_log "
            "WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? "
            "ORDER BY next_retry_at ASC LIMIT ?",
            (now, int(limit)),
        ).fetchall()
        return [(int(r[0]), int(r[1] or 0)) for r in rows]
    finally:
        conn.close()


def bump_deferred(db_path: str, internal_id: int, now: Optional[float] = None) -> None:
    """标签未就位 → 检查轮数 +1, 下轮 DEFER_CHECK_INTERVAL_SEC 后再看 (只动 pending 行)。"""
    if now is None:
        now = time.time()
    conn = _connect(db_path)
    try:
        conn.execute(
            "UPDATE kos_ingest_log "
            "SET retry_count = retry_count + 1, next_retry_at = ?, pushed_at = ? "
            "WHERE internal_id = ? AND status = 'pending'",
            (now + DEFER_CHECK_INTERVAL_SEC, now, internal_id),
        )
        conn.commit()
    finally:
        conn.close()


def record_health(db_path: str, healthy: bool, error: str = "") -> bool:
    """探活结果落 sync_state (kos.health.*), 返回是否「刚恢复」(上轮 error → 本轮 ok)。

    「刚恢复」信号供重试消费端打一条可见的恢复日志 (R4)。时间戳 ISO (davmail 先例)。
    """
    conn = _connect(db_path)
    try:
        prev = conn.execute(
            "SELECT value FROM sync_state WHERE key = ?", (STATE_HEALTH_STATUS,)
        ).fetchone()
        prev_status = prev[0] if prev else None
        if healthy:
            consec = 0
        else:
            prev_c = conn.execute(
                "SELECT value FROM sync_state WHERE key = ?",
                (STATE_HEALTH_CONSEC_FAILURES,),
            ).fetchone()
            try:
                consec = int(prev_c[0]) + 1 if prev_c else 1
            except (TypeError, ValueError):
                consec = 1
        _set_states(conn, {
            STATE_HEALTH_STATUS: "ok" if healthy else "error",
            STATE_HEALTH_CHECKED_AT: datetime.now().isoformat(),
            STATE_HEALTH_ERROR: "" if healthy else (error or "")[:_ERROR_TEXT_CAP],
            STATE_HEALTH_CONSEC_FAILURES: str(consec),
        })
        conn.commit()
        return healthy and prev_status == "error"
    finally:
        conn.close()
