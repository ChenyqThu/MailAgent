"""AdminService —— transport-neutral admin 写操作 (E2-C: dead-letter retry/cleanup)。

把 ``mailagent admin dead-letter retry`` / ``admin cleanup-deadletter`` 的业务逻辑从
CLI 命令体下沉到这里, 让 serve-api 不再 fork CLI 跨传输复用 (见
docs/plans/architecture-review-2026-07/e2-subtraction-sprint.md §2)。

两个操作都是**单条原子 SQL 语句**(单行 UPDATE / 单条 DELETE), 不是 CLI 长任务那种
多 unit 批量迭代, 故不挂 ``src/sync/job_runners.py`` 的 ``LongTaskContext`` /
``drive_units``(那是为 resync/backfill 这类需要 checkpoint/熔断/进度的多 unit 批量
任务设计的, 用在单语句写操作上是过度设计)。

serve-api 路由此前恒对这两个写端点注入 ``--allow-concurrent`` 跳过 PM2 冲突检测
(web 侧调用时 mail-sync 常在线), 故本 service 同样不做 PM2 检测 —— 只保留
``require_write_auth(actor)`` 鉴权闸。
"""

from __future__ import annotations

import sqlite3
import time
from typing import TYPE_CHECKING, Any

from src.services.errors import ServiceInvalidArgError, ServiceSchemaError
from src.services.guards import Actor, require_write_auth

if TYPE_CHECKING:
    from src.services.context import ServiceDeps


class AdminService:
    """admin 写操作的应用服务 (E2-C 范围: dead-letter retry / cleanup)。

    ``ctx`` 是 ``ServiceDeps`` —— 经 ``ctx.config.sync_store_db_path`` 直连 SQLite,
    与 CLI 命令体 (src/cli/commands/admin.py) 用同一张 ``email_metadata`` 表、同一套
    SQL (逐字段对齐, 仅错误类型改用 Service* 体系)。
    """

    def __init__(self, ctx: "ServiceDeps") -> None:
        self._ctx = ctx

    def retry_dead_letter(self, internal_id: int, *, actor: Actor) -> dict[str, Any]:
        """把单封 dead_letter 邮件重置为 pending (下次 poll 重跑)。

        搬自 ``admin_dead_letter_retry`` (src/cli/commands/admin.py, SQL 逐字段对齐)。
        internal_id 不在 email_metadata → ``ServiceInvalidArgError`` (E_INVALID_ARG,
        与 CLI 一致 —— 视为调用方参数错误而非资源缺失, 保 HTTP 400 不变成 404)。
        """
        require_write_auth(actor)

        db_path = self._ctx.config.sync_store_db_path
        try:
            conn = sqlite3.connect(db_path, timeout=5.0)
            try:
                cur = conn.execute(
                    "SELECT sync_status FROM email_metadata WHERE internal_id = ?",
                    (internal_id,),
                ).fetchone()
                if cur is None:
                    raise ServiceInvalidArgError(
                        f"internal_id={internal_id} not found in email_metadata"
                    )
                old_status = cur[0]
                conn.execute(
                    "UPDATE email_metadata SET sync_status='pending', "
                    "retry_count=0, next_retry_at=NULL, sync_error=NULL, "
                    "updated_at=? WHERE internal_id = ?",
                    (time.time(), internal_id),
                )
                conn.commit()
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise ServiceSchemaError(f"retry update failed: {exc}") from exc

        return {
            "internal_id": internal_id,
            "old_status": old_status,
            "new_status": "pending",
        }

    def cleanup_dead_letter(
        self, *, older_than: int = 30, dry_run: bool = True, actor: Actor,
    ) -> dict[str, Any]:
        """清理超过 N 天的 dead_letter 记录 (单条原子 DELETE, 不存在"部分失败")。

        搬自 ``admin_cleanup_deadletter`` (src/cli/commands/admin.py)。路由层此前恒在
        dry_run=False 时补 ``--yes`` (从不允许"删除但不确认"这个中间态), 故这里不单独
        暴露 confirm 参数 —— dry_run=False 即真删, 与既有路由行为一致。
        """
        require_write_auth(actor)

        cutoff = time.time() - (older_than * 86400)
        db_path = self._ctx.config.sync_store_db_path
        try:
            conn = sqlite3.connect(db_path, timeout=5.0)
            try:
                cur = conn.execute(
                    "SELECT COUNT(*) FROM email_metadata "
                    "WHERE sync_status='dead_letter' AND updated_at < ?",
                    (cutoff,),
                ).fetchone()
                candidates = int(cur[0])
                deleted = 0
                if not dry_run and candidates > 0:
                    conn.execute(
                        "DELETE FROM email_metadata "
                        "WHERE sync_status='dead_letter' AND updated_at < ?",
                        (cutoff,),
                    )
                    deleted = candidates
                    conn.commit()
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise ServiceSchemaError(f"cleanup-deadletter failed: {exc}") from exc

        return {
            "action": "cleanup-deadletter",
            "older_than_days": older_than,
            "candidates": candidates,
            "deleted": deleted,
            "dry_run": dry_run,
            "mode": "inline",
            "ok": True,
        }
