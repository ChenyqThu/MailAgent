"""admin 路由 — /api/admin/*。

读端点 (health / stats / dead-letter list / davmail-health / system-alerts) 经
``Depends(get_repository)`` 拿 EmailRepository 复用 _connect() 直查 SQLite
(meta.source='sqlite'), 镜像 ``mailagent admin health`` / ``admin stats``
(sync_store section) / ``admin dead-letter list`` 的查询。
写端点 (dead-letter retry / cleanup-dead-letter) E2-C 起经进程内 ``AdminService``
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


# admin health 的 schema 契约 — 与主仓 SyncStore 同步避免漂移。
# 镜像 src/cli/commands/admin.py 的 EXPECTED_DB_VERSION / REQUIRED_TABLES。
def _expected_db_version() -> int:
    from src.mail.sync_store import SyncStore

    return SyncStore.DB_VERSION


REQUIRED_TABLES = (
    "email_metadata",
    "email_body",
    "email_attachment",
    "email_body_fts",
    "cli_checkpoints",
    "v4_rollout_stats",
    "island_dispatch",
    "email_outbox",
)


def _parse_worker_rows(rows) -> dict:
    """sync_state 'worker.<name>.<field>' 行 → {name: {field: value}} (E4 WP1 心跳).

    supervise (src/utils/supervise.py) 在状态跃迁时写这些键; 镜像
    src/cli/commands/admin.py 同名 helper (本文件惯例: 平行实现不共享 import)。
    """
    workers: dict[str, dict] = {}
    for key, value in rows:
        rest = key[len("worker."):]
        if "." not in rest:
            continue
        name, field = rest.rsplit(".", 1)
        if field == "restart_count":
            try:
                value = int(value)
            except (TypeError, ValueError):
                pass
        workers.setdefault(name, {})[field] = value
    return workers


def _build_davmail_summary(state: dict) -> Optional[dict]:
    """davmail.* 键 → {token_age_days, imap_reachable, last_probe_at} 摘要 (E4 WP2).

    watchdog 从未 tick (非 davmail 模式) → None; token_age_days "-1" 哨兵 → None。
    """
    if not state.get("davmail.last_probe_at"):
        return None
    token_age_days: Optional[float] = None
    raw = state.get("davmail.token_age_days")
    if raw is not None:
        try:
            parsed = float(raw)
            token_age_days = None if parsed < 0 else parsed
        except (TypeError, ValueError):
            token_age_days = None
    return {
        "token_age_days": token_age_days,
        "imap_reachable": state.get("davmail.imap_reachable") == "1",
        "last_probe_at": state.get("davmail.last_probe_at"),
    }


def _mark_stale_workers(workers: dict, start_history_raw: Optional[str]) -> None:
    """E4 第二批 (D3): last_started_at 早于本次 boot 的 worker 条目加 stale=True.

    last_boot_at = max(sync_state['service.start_history']) (JSON 数组, epoch 秒,
    service._record_start_history 每次 start() 追加)。worker 心跳的 last_started_at
    是 ISO 8601 字符串 (supervise._utcnow_iso), fromisoformat→timestamp 转 epoch 后
    比较。**秒粒度对齐**: 心跳 ISO 是 timespec="seconds" 截断值而 boot 是带小数的
    time.time() —— worker 在 start() 后几 ms 内就启动, 直接 float 比较会把「boot
    同一秒启动」的 worker 几乎恒误标 stale (floor(T+ms) < T), 故 boot 也 floor 到
    整秒再比 (同秒 = 不 stale)。缺失 / parse 失败静默跳过 (health 绝不因此 500);
    不 stale **不写字段** (减少噪音)。镜像 src/cli/commands/admin.py 同名 helper
    (平行实现不共享 import)。
    """
    import json as _json
    from datetime import datetime as _datetime

    if not start_history_raw:
        return
    try:
        history = _json.loads(start_history_raw)
    except (ValueError, TypeError):
        return
    if not isinstance(history, list):
        return
    epochs = [float(t) for t in history if isinstance(t, (int, float))]
    if not epochs:
        return
    last_boot_sec = int(max(epochs))
    for w in workers.values():
        raw = w.get("last_started_at")
        if not isinstance(raw, str):
            continue
        try:
            started_at = _datetime.fromisoformat(raw).timestamp()
        except (ValueError, TypeError, OverflowError, OSError):
            continue
        if started_at < last_boot_sec:
            w["stale"] = True


def _compose_dynamic_health_notes(workers: dict, davmail_summary: Optional[dict]) -> list:
    """crashloop 停摆 / token 老化 → 提示行 (E4 WP1/WP2, 不影响 healthy 语义).

    与 CLI 面差异: CLI notes 还包含 E1 的静态 davmail watch note (那是 CLI-only
    设计, web 面历史上无 notes 字段, 这里只发动态行)。_TOKEN_WARN_DAYS 定义在
    下方 davmail-health 段 (模块级名, 调用期解析)。
    """
    notes: list = []
    for wname in sorted(workers):
        w = workers[wname]
        if w.get("status") == "crashloop_stopped":
            last_error = str(w.get("last_error") or "")[:120]
            notes.append(
                f"worker '{wname}' 已 crash-loop 停摆 (supervise 停止重启), "
                f"该功能不可用直到服务重启 — last_error: {last_error}"
            )
    if davmail_summary is not None:
        tad = davmail_summary.get("token_age_days")
        if tad is not None and tad >= _TOKEN_WARN_DAYS:
            notes.append(
                f"DavMail OAuth token 已 {tad:.1f} 天未刷新 (≥{_TOKEN_WARN_DAYS:.0f}d)；"
                "refresh_token 90 天有效期，接近时需重走 OAuth flow。"
            )
    return notes


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
    """邮件 sync_status 分布等运行统计 (镜像 ``mailagent admin stats`` 的 sync_store section)。

    返回 data = {sync_store: {total_emails, by_status, by_mailbox, failure_queue,
    last_max_row_id, last_sync_time, db_size_mb, db_size_bytes, _source}} (AdminStatsData
    / admin-stats.schema.json)。watcher / handlers / v4_rollout / outbox 等 section 不在
    本次范围 (前端 admin.stats 只刚需 sync_store 分布)。

    C6 (read endpoint must not mutate): **不再实例化 SyncStore** —— 其 __init__ 会跑
    _ensure_directory() + _init_database() (CREATE TABLE IF NOT EXISTS / 迁移 / 写
    db_version), 等于 GET 读端点改 schema 并与 mail-sync 争写锁。改为经 ``repo._connect()``
    (与其它读端点同源, 短命只读连接) 直查, 复刻 SyncStore.get_stats() 的纯 SELECT,
    不触发任何 DDL/migration。表缺失 (trimmed 库) → 与 get_stats 一致汇成 0, 不抛。
    """
    sync_store_section = _read_sync_store_section(repo)
    data = {"sync_store": sync_store_section}
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
# DavMailWatchdog 的阈值 (src/mail/davmail_watchdog.py _TOKEN_WARN_DAYS /
# _TOKEN_CRITICAL_DAYS)。level 在 watchdog 内 live 计算不落盘, 故镜像这两个常数 +
# _compute_overall_level 的规则, 用落盘的 davmail.* 值重算。若 watchdog 阈值变动,
# 这里需随之漂移 (无共享 import: watchdog 模块 import 期会拉 SyncStore/alert 重依赖,
# router 只需两个标量, 故就地复刻)。
_TOKEN_WARN_DAYS = 80.0
_TOKEN_CRITICAL_DAYS = 87.0


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
) -> str:
    """重算 overall level (镜像 davmail_watchdog._compute_overall_level)。"""
    if oauth_error_active:
        return "critical"
    if not imap_ok or not smtp_ok:
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

    if not enabled:
        level = "unknown"
    else:
        level = _compute_level(
            imap_ok=imap_ok,
            smtp_ok=smtp_ok,
            token_age_days=token_age_days,
            oauth_error_active=bool(last_oauth_error),
            throttle_burst=throttle_5min >= 3,
        )

    return {
        "enabled": enabled,
        "level": level,
        "last_probe_at": last_probe_at,
        "imap_reachable": imap_ok,
        "smtp_reachable": smtp_ok,
        "consecutive_imap_failures": _as_int("davmail.consecutive_imap_failures"),
        "consecutive_smtp_failures": _as_int("davmail.consecutive_smtp_failures"),
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
