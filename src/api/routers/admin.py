"""admin 路由 — /api/admin/*。

读端点 (health / stats / dead-letter list / davmail-health / system-alerts) 经
``Depends(get_repository)`` 拿 EmailRepository 复用 _connect() 直查 SQLite
(meta.source='sqlite'), 镜像 ``mailagent admin health`` / ``admin stats``
(sync_store section) / ``admin dead-letter list`` 的查询。
写端点 (dead-letter retry / dead-letter delete / cleanup-dead-letter) 经进程内 ``AdminService``
(``src/services/admin_service.py``, 不再 fork CLI), meta.source='cli'（历史沿用命名,
语义是「CLI 等价写语义」而非字面传输方式）。两端点均不做 PM2 冲突检测 —— 迁移前
路由恒对 CLI 传 ``--allow-concurrent`` 绕过该检测, service 层原样不设这道闸。

davmail-health / system-alerts **无 CLI** —— 直读 sync_state 的 ``davmail.*`` 键
(DavMailWatchdog 每 60s 落盘, src/mail/davmail_watchdog.py), level 在 watchdog 内是 live
计算不落盘, 故 router 用同一套阈值 (_compute_level) 重算。meta.source 仍是 'sqlite'。

契约: BACKEND-INTERFACES §2.4 + frontend admin.{health,stats,deadLetterList,
deadLetterRetry,cleanupDeadLetter,davmailHealth,systemAlerts} + admin-*.schema.json。

EXPECTED_DB_VERSION / REQUIRED_TABLES 从主仓 SyncStore import (不硬编码), 后续
ALTER TABLE 升版本时随主仓漂移, API 端不会漏改。
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository, get_service_ctx
from src.mail.davmail_watchdog import (
    LOGIN_FAIL_THRESHOLD as _watchdog_login_fail_threshold,
)
from src.services import admin_health as _health
from src.services import admin_stats as _admin_stats
from src.services.admin_service import AdminService
from src.services.errors import ServiceError
from src.services.guards import Actor

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _raise_from_service_error(exc: ServiceError) -> None:
    """in-process service 抛的 ServiceError → APIError (email/llm router 同名 helper 同构)。

    code 用 service 自报的 ``ServiceError.code`` (E_INVALID_ARG / E_SCHEMA_MISMATCH / ...),
    http_status 由 app.ERROR_CODE_TO_HTTP[code] 推导。``source='cli'`` 维持既有 wire 契约。
    """
    raise APIError(exc.code, exc.message, hint=exc.hint, source="cli") from exc


# admin health 的 schema 契约 — 与主仓 SyncStore 同步避免漂移 (CLI 侧同样 import
# SyncStore.DB_VERSION, 非手抄)。
def _expected_db_version() -> int:
    from src.mail.sync_store import SyncStore

    return SyncStore.DB_VERSION


# 🔴 issue #68: 必备表清单 + 四个 health 组装 helper 此前在本文件与
# src/cli/commands/admin.py 各持一份逐字副本 ("平行实现不共享 import" 的旧惯例),
# 现统一单源到 src/services/admin_health。两端**有意保留**的差异 (notes 静态段 /
# error 文案 redaction) 说明见该模块 docstring。
REQUIRED_TABLES = _health.REQUIRED_TABLES
_parse_worker_rows = _health.parse_worker_rows
_build_davmail_summary = _health.build_davmail_summary
_mark_stale_workers = _health.mark_stale_workers
_compose_dynamic_health_notes = _health.compose_dynamic_health_notes


# ============================================================
# GET /api/admin/health  (读, 直查 SQLite)
# ============================================================
@router.get("/health")
async def admin_health(
    request: Request,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """SQLite 连通性 + db_version + 必备表存在性检查 (镜像 ``mailagent admin health``)。

    返回 data = {db_accessible, db_version, db_version_expected, schema_ok,
    tables_present, tables_missing, healthy, error?} (AdminHealthData / admin-health.schema.json)。

    healthy=false 时仍返回 HTTP 200 + 完整诊断 (不当成 error envelope — 前端要读细节
    判断哪里不健康; 这与 CLI ``admin health`` exit 1 不同, web 侧 200 携带 healthy:false)。

    C9 (redact host layout): **不回显绝对 ``db_path``** —— host 文件布局是部署细节,
    诊断只需 bool/version/表名。``error`` 字段同样不带路径: 文件缺失 → 固定文案
    "database file not found"; 其它故障 → 仅异常类名 (异常消息可能含路径/连接串)。

    E4 WP1/WP2: 追加 ``workers`` (supervise 状态跃迁写的 sync_state 'worker.%' 键
    → 「进程活着但某 worker 死了」跨进程可见) + ``davmail`` 摘要 (token_age_days /
    imap_reachable, 读 watchdog 落盘的 davmail.* 键) + ``notes`` (crashloop 停摆 /
    token 老化提示行)。均为纯诊断字段, **不改 healthy 计算语义**。
    """
    db_path = str(repo.db_path)
    db_accessible = False
    db_version: Optional[int] = None
    tables_present: list[str] = []
    error_message: Optional[str] = None
    expected = _expected_db_version()
    workers: dict = {}
    davmail_summary: Optional[dict] = None

    try:
        if not Path(db_path).exists():
            # 不把 db_path 塞进异常 (会回显到 error) —— 用无路径哨兵。
            raise FileNotFoundError
        conn = sqlite3.connect(db_path, timeout=5.0)
        try:
            db_accessible = True
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='db_version'"
            ).fetchone()
            if row:
                try:
                    db_version = int(row[0])
                except (TypeError, ValueError):
                    db_version = None
            tables_present = [
                r[0]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                ).fetchall()
            ]

            # E4 WP1/WP2: worker 心跳 + davmail 摘要 (镜像 CLI admin health,
            # sync_state 缺失 / 查询失败 → 静默空值, 不影响 healthy)。
            try:
                worker_rows = conn.execute(
                    "SELECT key, value FROM sync_state WHERE key LIKE 'worker.%'"
                ).fetchall()
                workers = _parse_worker_rows(worker_rows)
                # E4 第二批 (D3): last_started_at 早于本次 boot → stale 标记。
                boot_row = conn.execute(
                    "SELECT value FROM sync_state WHERE key='service.start_history'"
                ).fetchone()
                _mark_stale_workers(workers, boot_row[0] if boot_row else None)
                davmail_rows = conn.execute(
                    "SELECT key, value FROM sync_state WHERE key IN "
                    "('davmail.last_probe_at', 'davmail.token_age_days', "
                    "'davmail.imap_reachable')"
                ).fetchall()
                davmail_summary = _build_davmail_summary(dict(davmail_rows))
            except sqlite3.Error:
                workers, davmail_summary = {}, None
        finally:
            conn.close()
    except FileNotFoundError:
        error_message = "database file not found"
    except Exception as exc:  # noqa: BLE001 — 任何 DB 故障都汇成诊断字段, 不抛
        # 只回异常类名: str(exc) 可能含绝对路径 / 连接串 (C9 redaction)。
        error_message = type(exc).__name__

    missing = [t for t in REQUIRED_TABLES if t not in tables_present]
    schema_ok = db_accessible and db_version == expected and not missing
    healthy = schema_ok

    data = {
        "db_accessible": db_accessible,
        "db_version": db_version,
        "db_version_expected": expected,
        "schema_ok": schema_ok,
        "tables_present": tables_present,
        "tables_missing": missing,
        "healthy": healthy,
        "workers": workers,
        "davmail": davmail_summary,
        "notes": _compose_dynamic_health_notes(workers, davmail_summary),
    }
    if error_message:
        data["error"] = error_message

    return success_envelope(data, request=request, source="sqlite")


def _read_sync_store_section(repo: "EmailRepository") -> dict:
    """纯只读复刻 SyncStore.get_stats() 的 sync_store 分布段 (C6: 不实例化 SyncStore)。

    经 ``repo._connect()`` 短命只读连接跑 SELECT —— email_metadata 计数 / 按 status /
    按 mailbox 分组 + sync_state 的 last_max_row_id / last_sync_time + 文件大小。
    绝不 CREATE/ALTER/迁移/写 db_version。表缺失 (trimmed 库) → sqlite3.Error 汇成 0,
    与 get_stats 的 ``except sqlite3.Error → SyncStoreStats()`` 兜底一致。
    """
    total_emails = 0
    by_status: dict[str, int] = {}
    by_mailbox: dict[str, int] = {}
    last_max_row_id: Optional[int] = None
    last_sync_time: Optional[str] = None

    conn = repo._connect()
    try:
        try:
            total_emails = conn.execute(
                "SELECT COUNT(*) FROM email_metadata"
            ).fetchone()[0]
            by_status = {
                r["sync_status"]: r["count"]
                for r in conn.execute(
                    "SELECT sync_status, COUNT(*) AS count "
                    "FROM email_metadata GROUP BY sync_status"
                ).fetchall()
            }
            by_mailbox = {
                r["mailbox"]: r["count"]
                for r in conn.execute(
                    "SELECT mailbox, COUNT(*) AS count "
                    "FROM email_metadata GROUP BY mailbox"
                ).fetchall()
            }
        except sqlite3.Error:
            # email_metadata 缺失 (trimmed 库) → 维持 0/{} (与 get_stats 兜底一致)。
            total_emails, by_status, by_mailbox = 0, {}, {}

        # sync_state 的两个游标键 (get_last_max_row_id / get_last_sync_time 等价)。
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='last_max_row_id'"
            ).fetchone()
            if row and row["value"] is not None:
                try:
                    last_max_row_id = int(row["value"])
                except (TypeError, ValueError):
                    last_max_row_id = None
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key='last_sync_time'"
            ).fetchone()
            last_sync_time = row["value"] if row else None
        except sqlite3.Error:
            last_max_row_id, last_sync_time = None, None
    finally:
        conn.close()

    failure_queue = by_status.get("fetch_failed", 0) + by_status.get("failed", 0)
    db_size_bytes = repo.db_path.stat().st_size if repo.db_path.exists() else 0

    return {
        "total_emails": total_emails,
        "by_status": by_status,
        "by_mailbox": by_mailbox,
        "failure_queue": failure_queue,
        "last_max_row_id": last_max_row_id,
        "last_sync_time": last_sync_time,
        "db_size_mb": round(db_size_bytes / 1024 / 1024, 2),
        "db_size_bytes": db_size_bytes,
        "_source": "live_query",
    }


# ============================================================
# GET /api/admin/stats  (读, 直查 SQLite)
# ============================================================
@router.get("/stats")
async def admin_stats(
    request: Request,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """邮件 sync_status 分布等运行统计 (镜像 ``mailagent admin stats``)。

    返回 data = {sync_store: {...}, v4_rollout: {...}, outbox: {...}} (AdminStatsData
    / admin-stats.schema.json)。watcher / handlers 两段 CLI 侧至今是
    ``not_implemented_in_pr2`` 占位, 无数据可给, 故本端点不发。

    v4_rollout / outbox 两段 (task 08-20-perf-dashboards) 与 CLI **同一个组装体**
    ``src.services.admin_stats`` —— 桌面看板已从 fork CLI 改走本端点, 少一段就是看板上
    少一块卡。

    C6 (read endpoint must not mutate): **不实例化 SyncStore** —— 其 __init__ 会跑
    _ensure_directory() + _init_database() (CREATE TABLE IF NOT EXISTS / 迁移 / 写
    db_version), 等于 GET 读端点改 schema 并与 mail-sync 争写锁。sync_store 段经
    ``repo._connect()`` (与其它读端点同源, 短命只读连接) 直查, 复刻 SyncStore.get_stats()
    的纯 SELECT; 另两段同样只跑 SELECT (admin_stats 模块自带只读约束)。表缺失
    (trimmed 库) → 汇成 0 / 结构化占位, 不抛。
    """
    data = {
        "sync_store": _read_sync_store_section(repo),
        "v4_rollout": _admin_stats.build_v4_rollout_section(repo.db_path),
        "outbox": _admin_stats.build_outbox_section(repo.db_path),
    }
    return success_envelope(data, request=request, source="sqlite")


# ============================================================
# GET /api/admin/dead-letter  (读, 直查 SQLite)
# ============================================================
@router.get("/dead-letter")
async def admin_dead_letter_list(
    request: Request,
    limit: int = 50,
    mailbox: Optional[str] = None,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """列出 sync_status='dead_letter' 的邮件 (镜像 ``mailagent admin dead-letter list``)。

    返回 data = list[DeadLetterItem], meta 追加 {count, limit}。
    每行包含 frontend DeadLetterItem 需要的富字段 (date_received / sync_status /
    sync_error) + CLI-native (last_error / updated_at), 一次 SELECT 全取。

    limit 限制 (0, 500]; 越界 → E_INVALID_ARG (400)。
    """
    if limit <= 0 or limit > 500:
        raise APIError(
            "E_INVALID_ARG",
            f"limit must be in (0, 500], got {limit}",
            hint="use 1..500",
            source="sqlite",
        )

    query = (
        "SELECT internal_id, subject, sender, mailbox, date_received, "
        "sync_status, retry_count, sync_error, updated_at "
        "FROM email_metadata WHERE sync_status='dead_letter'"
    )
    params: list = []
    if mailbox:
        query += " AND mailbox = ?"
        params.append(mailbox)
    query += " ORDER BY updated_at DESC LIMIT ?"
    params.append(limit)

    conn = repo._connect()
    rows: list[dict] = []
    try:
        for r in conn.execute(query, params).fetchall():
            rows.append({
                "internal_id": r["internal_id"],
                "subject": r["subject"],
                "sender": r["sender"],
                "mailbox": r["mailbox"],
                "date_received": r["date_received"],
                "sync_status": r["sync_status"],
                "retry_count": r["retry_count"],
                "sync_error": r["sync_error"],
                # CLI-native 别名, 兼容直接读 CLI list 形状的旧前端调用。
                "last_error": r["sync_error"],
                "updated_at": r["updated_at"],
            })
    finally:
        conn.close()

    return success_envelope(
        rows,
        request=request,
        source="sqlite",
        meta_extra={"count": len(rows), "limit": limit},
    )


# ============================================================
# POST /api/admin/dead-letter/{internal_id}/retry  (写, in-process AdminService)
# ============================================================
@router.post("/dead-letter/{internal_id}/retry")
async def admin_dead_letter_retry(
    internal_id: int,
    request: Request,
    _: None = Depends(verify_cf_access),
):
    """把单封 dead_letter 邮件重置为 pending (下次 poll 重跑)。

    镜像 ``mailagent admin dead-letter retry {id}`` (写命令), E2-C 起进程内直调
    ``AdminService`` 不再 fork CLI —— 与本文件其它 SQLite 端点同风格直接同步调用
    (单条 UPDATE, 耗时量级与 health/stats 等读端点相当, 不需要 asyncio.to_thread)。
    无 PM2 冲突检测: 迁移前路由恒对 CLI 传 ``--allow-concurrent`` 绕过该检测,
    service 层原样不设这道闸。

    data 透传 CLI 形状 {internal_id, old_status, new_status} (DeadLetterRetryResult)。
    internal_id 不存在 email_metadata → E_INVALID_ARG (400, 与 CLI 一致)。
    """
    svc = AdminService(get_service_ctx())
    try:
        data = svc.retry_dead_letter(
            internal_id,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ============================================================
# POST /api/admin/dead-letter/{internal_id}/delete  (写, in-process AdminService)
# ============================================================
@router.post("/dead-letter/{internal_id}/delete")
async def admin_dead_letter_delete(
    internal_id: int,
    request: Request,
    _: None = Depends(verify_cf_access),
):
    """彻底删除单封 dead_letter 邮件 (人工确认已处置后清条目)。

    镜像 ``mailagent admin dead-letter delete {id} --yes`` (写命令), 与 retry 同款
    进程内直调 ``AdminService``。不可逆 —— 二次确认由调用方 (admin 面板弹窗) 负责,
    HTTP 层不设 dry-run (retry/cleanup 的既有分工: 面板确认 → 端点直接执行)。

    data 形状 {internal_id, old_status, deleted} (DeadLetterDeleteResult)。
    internal_id 不存在 / 不是 dead_letter → E_INVALID_ARG (400)。
    """
    svc = AdminService(get_service_ctx())
    try:
        data = svc.delete_dead_letter(
            internal_id,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ============================================================
# POST /api/admin/cleanup-dead-letter  (写, in-process AdminService)
# ============================================================
@router.post("/cleanup-dead-letter")
async def admin_cleanup_dead_letter(
    request: Request,
    older_than: int = 30,
    dry_run: bool = True,
    _: None = Depends(verify_cf_access),
):
    """清理超过 N 天的 dead_letter 记录 (镜像 ``mailagent admin cleanup-deadletter``)。

    E2-C 起进程内直调 ``AdminService`` 不再 fork CLI。默认 ``dry_run=true`` (只数不删);
    真删需显式 ``dry_run=false`` (等价原 CLI ``--no-dry-run --yes`` —— 路由层此前从不
    允许"删除但不确认"的中间态, 故 service 同样无独立 confirm 参数)。无 PM2 冲突检测
    (与 retry 同理)。

    data 透传形状 {action, older_than_days, candidates, deleted, dry_run, mode, ok}
    (CleanupDeadLetterResult)。单条原子 DELETE 语句不存在"部分失败" —— 迁移前 CLI
    子进程退出码 6 (partial_failure → HTTP 207) 的分支随 fork 一并退役, 与
    docs/cli-schema/admin-cleanup.schema.json 现仅 documented [success, wrapper_error]
    的契约对齐 (该 schema 本就未定义 partial_failure 变体)。
    """
    svc = AdminService(get_service_ctx())
    try:
        data = svc.cleanup_dead_letter(
            older_than=older_than,
            dry_run=dry_run,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ============================================================
# davmail-health / system-alerts 共享: sync_state davmail.* 直读 + level 重算
# ============================================================
# DavMailWatchdog 的阈值。level 在 watchdog 内 live 计算不落盘, 故这里复刻
# _compute_overall_level 的**规则**, 用落盘的 davmail.* 值重算 —— 但**阈值本身
# 直接 import 真源** (issue #68: 旧注释「watchdog import 期会拉 SyncStore/alert
# 重依赖」已证伪, 那些 import 全在 TYPE_CHECKING 下)。
_TOKEN_WARN_DAYS = _health.TOKEN_WARN_DAYS
_TOKEN_CRITICAL_DAYS = _health.TOKEN_CRITICAL_DAYS
# F5: login 失败阈值改由 watchdog 每轮经 sync_state davmail.login_fail_threshold
# 传播 (生效值单源), 根治「四个健康读面各自硬编码 3, 设 DAVMAIL_LOGIN_FAIL_THRESHOLD
# 非默认值时判定漂移」。键缺失 (老数据 / watchdog 未升级) fallback 默认 3 (同样 import
# 真源, 不复刻字面量)。
_DEFAULT_LOGIN_FAIL_THRESHOLD = _watchdog_login_fail_threshold


def _login_fail_threshold(state: dict[str, str]) -> int:
    """当前生效的 login 失败阈值 (watchdog 落盘)；缺失 / 坏值 fallback 3。"""
    try:
        val = int(state.get("davmail.login_fail_threshold", ""))
        return val if val > 0 else _DEFAULT_LOGIN_FAIL_THRESHOLD
    except (TypeError, ValueError):
        return _DEFAULT_LOGIN_FAIL_THRESHOLD


def _read_davmail_state(repo: "EmailRepository") -> dict[str, str]:
    """读全部 ``davmail.*`` 键 + 独立的 ``davmail_uid_backfill_paused`` 键。

    gotcha #12: watchdog 的 health 键都以 ``davmail.`` 前缀落 sync_state, 但
    uid-backfill 暂停标志用的是 ``davmail_uid_backfill_paused`` (下划线, 无点 —— 与
    uid-mapper 共享), LIKE 'davmail.%' 抓不到, 故单独读。
    """
    conn = repo._connect()
    try:
        rows = conn.execute(
            "SELECT key, value FROM sync_state WHERE key LIKE 'davmail.%'"
        ).fetchall()
        state = {r["key"]: r["value"] for r in rows}
        extra = conn.execute(
            "SELECT value FROM sync_state WHERE key = 'davmail_uid_backfill_paused'"
        ).fetchone()
        if extra is not None:
            state["davmail_uid_backfill_paused"] = extra["value"]
    finally:
        conn.close()
    return state


def _compute_level(
    *,
    imap_ok: bool,
    smtp_ok: bool,
    token_age_days: Optional[float],
    oauth_error_active: bool,
    throttle_burst: bool,
    login_degraded: bool = False,
) -> str:
    """重算 overall level (镜像 davmail_watchdog._compute_overall_level)。"""
    if oauth_error_active:
        return "critical"
    if not imap_ok or not smtp_ok:
        return "critical"
    if login_degraded:
        # TCP 可达但 IMAP LOGIN 连续失败 = token 劣化 (能发不能收)
        return "critical"
    if token_age_days is not None and token_age_days >= _TOKEN_CRITICAL_DAYS:
        return "critical"
    if token_age_days is not None and token_age_days >= _TOKEN_WARN_DAYS:
        return "warning"
    if throttle_burst:
        return "warning"
    return "ok"


def _build_davmail_health(state: dict[str, str]) -> dict:
    """把落盘的 davmail.* 字符串值解析回 DavMailHealthData 形状 + 重算 level。

    ``enabled=false`` 当无 ``davmail.last_probe_at`` (watchdog 从未 tick → 非 davmail
    模式)。token_age_days 的 "-1" 哨兵 → None (watchdog 用它表示 token 文件不可读)。
    """
    last_probe_at = state.get("davmail.last_probe_at")
    enabled = bool(last_probe_at)

    def _as_int(key: str) -> int:
        try:
            return int(state.get(key, "0") or "0")
        except (TypeError, ValueError):
            return 0

    imap_ok = state.get("davmail.imap_reachable") == "1"
    smtp_ok = state.get("davmail.smtp_reachable") == "1"

    token_age_raw = state.get("davmail.token_age_days")
    token_age_days: Optional[float] = None
    if token_age_raw is not None:
        try:
            parsed = float(token_age_raw)
            token_age_days = None if parsed < 0 else parsed  # "-1" 哨兵 → None
        except (TypeError, ValueError):
            token_age_days = None

    token_mtime_iso = state.get("davmail.token_mtime_iso") or None
    last_oauth_error = state.get("davmail.last_oauth_error") or None
    last_oauth_error_at = state.get("davmail.last_oauth_error_at") or None
    throttle_5min = _as_int("davmail.throttle_events_5min")
    uid_backfill_paused = state.get("davmail_uid_backfill_paused") == "true"

    # L2a: '' = 该轮跳过 login 探测 (TCP 不可达/未注入 cfg/开关关) → None
    imap_login_raw = state.get("davmail.imap_login_ok")
    imap_login_ok = None if not imap_login_raw else imap_login_raw == "1"
    consecutive_login_failures = _as_int("davmail.consecutive_login_failures")
    login_fail_threshold = _login_fail_threshold(state)
    login_degraded = consecutive_login_failures >= login_fail_threshold

    if not enabled:
        level = "unknown"
    else:
        level = _compute_level(
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            token_age_days=token_age_days,
            oauth_error_active=bool(last_oauth_error),
            throttle_burst=throttle_5min >= 3,
            login_degraded=login_degraded,
        )

    # davmail.folderSizeLimit 同步状态 (src/mail/davmail_properties.py, 启动时落盘)。
    # 与 watchdog 无关 → 不受 enabled 影响: 即使 watchdog 还没 tick, Settings 面也要
    # 能说清这个设置到底写进 davmail.properties 没有。
    fsl_desired = state.get("davmail.folder_size_limit.desired")
    fsl_file = state.get("davmail.folder_size_limit.file_value")

    def _as_opt_int(raw: Optional[str]) -> Optional[int]:
        try:
            return int(raw) if raw else None
        except (TypeError, ValueError):
            return None

    return {
        "enabled": enabled,
        "level": level,
        "folder_size_limit_status": state.get("davmail.folder_size_limit.status") or None,
        "folder_size_limit_path": state.get("davmail.folder_size_limit.path") or None,
        "folder_size_limit_desired": _as_opt_int(fsl_desired),
        "folder_size_limit_file_value": _as_opt_int(fsl_file),
        "last_probe_at": last_probe_at,
        "imap_reachable": imap_ok,
        "smtp_reachable": smtp_ok,
        "consecutive_imap_failures": _as_int("davmail.consecutive_imap_failures"),
        "consecutive_smtp_failures": _as_int("davmail.consecutive_smtp_failures"),
        "imap_login_ok": imap_login_ok,
        "consecutive_login_failures": consecutive_login_failures,
        # issue #67 遗留②/#68: 阈值此前只用于本地 level 判定、从不外发 → web 面的
        # 「LOGIN 失败 ×N」缺分母, 用户看不出离 degraded 还有多远 (桌面 IPC 侧一直有
        # 该字段, 于是同一张卡在两个传输端信息量不同)。
        "login_fail_threshold": login_fail_threshold,
        "token_age_days": token_age_days,
        "token_mtime_iso": token_mtime_iso,
        "throttle_events_5min": throttle_5min,
        "last_oauth_error": last_oauth_error,
        "last_oauth_error_at": last_oauth_error_at,
        "uid_backfill_paused": uid_backfill_paused,
    }


# ============================================================
# GET /api/admin/davmail-health  (读, 直读 sync_state davmail.*)
# ============================================================
@router.get("/davmail-health")
async def admin_davmail_health(
    request: Request,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """DavMail 桥健康快照 (无 CLI — 直读 sync_state ``davmail.*`` 键)。

    DavMailWatchdog 每 60s 把 IMAP/SMTP 可达性 / token age / OAuth 错误 / throttle 落盘。
    ``enabled=false`` 时 (非 davmail 模式, watchdog 无 tick) level='unknown', 其余字段取
    默认。level 重算见 _compute_level (watchdog 阈值 80d warn / 87d critical)。

    返回 DavMailHealthData。meta.source='sqlite'。
    """
    state = _read_davmail_state(repo)
    data = _build_davmail_health(state)
    return success_envelope(data, request=request, source="sqlite")


# ============================================================
# GET /api/admin/system-alerts  (读, 直读 sync_state davmail.*)
# ============================================================
@router.get("/system-alerts")
async def admin_system_alerts(
    request: Request,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """当前活跃系统告警 (无 CLI — 由 davmail.* 状态合成)。

    本地后端唯一的持久化健康源是 DavMailWatchdog 落盘的 ``davmail.*`` 键; 无独立 alerts
    表。故从 davmail health 快照合成活跃告警: IMAP/SMTP 不可达 / OAuth 错误 → critical;
    token 临期 / throttle burst → warning。watchdog 未运行 (enabled=false) → 空列表
    (没有可信号源, 不臆造告警)。

    返回 SystemAlertsData {alerts, critical_count, warning_count, generated_at}。
    meta.source='sqlite'。
    """
    state = _read_davmail_state(repo)
    health = _build_davmail_health(state)
    alerts: list[dict] = []

    if health["enabled"]:
        probe_at = health["last_probe_at"]
        if not health["imap_reachable"]:
            alerts.append({
                "level": "critical", "source": "davmail",
                "title": "DavMail IMAP unreachable",
                "message": (
                    "IMAP probe (127.0.0.1:1143) failing; "
                    f"{health['consecutive_imap_failures']} consecutive failures."
                ),
                "ts": probe_at,
            })
        if not health["smtp_reachable"]:
            alerts.append({
                "level": "critical", "source": "davmail",
                "title": "DavMail SMTP unreachable",
                "message": (
                    "SMTP probe (127.0.0.1:1025) failing; "
                    f"{health['consecutive_smtp_failures']} consecutive failures."
                ),
                "ts": probe_at,
            })
        if health["consecutive_login_failures"] >= _login_fail_threshold(state):
            alerts.append({
                "level": "critical", "source": "davmail",
                "title": "DavMail IMAP LOGIN failing",
                "message": (
                    "IMAP port reachable but LOGIN failing "
                    f"({health['consecutive_login_failures']} consecutive failures) "
                    "— token degraded (can send, can't receive)."
                ),
                "ts": probe_at,
            })
        if health["last_oauth_error"]:
            alerts.append({
                "level": "critical", "source": "davmail",
                "title": "DavMail OAuth failure",
                "message": str(health["last_oauth_error"]),
                "ts": health["last_oauth_error_at"] or probe_at,
            })
        tad = health["token_age_days"]
        if tad is not None and tad >= _TOKEN_CRITICAL_DAYS:
            alerts.append({
                "level": "critical", "source": "davmail",
                "title": "DavMail token expiring",
                "message": f"OAuth token is {tad:.1f} days old (>= {_TOKEN_CRITICAL_DAYS:.0f}d critical).",
                "ts": probe_at,
            })
        elif tad is not None and tad >= _TOKEN_WARN_DAYS:
            alerts.append({
                "level": "warning", "source": "davmail",
                "title": "DavMail token aging",
                "message": f"OAuth token is {tad:.1f} days old (>= {_TOKEN_WARN_DAYS:.0f}d warning).",
                "ts": probe_at,
            })
        if health["throttle_events_5min"] >= 3:
            alerts.append({
                "level": "warning", "source": "davmail",
                "title": "DavMail EWS throttling",
                "message": (
                    f"{health['throttle_events_5min']} EWS throttle events in the last 5min; "
                    "uid-backfill auto-paused."
                ),
                "ts": probe_at,
            })

    critical_count = sum(1 for a in alerts if a["level"] == "critical")
    warning_count = sum(1 for a in alerts if a["level"] == "warning")
    data = {
        "alerts": alerts,
        "critical_count": critical_count,
        "warning_count": warning_count,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return success_envelope(data, request=request, source="sqlite")
