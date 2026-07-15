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
    """admin 写操作的应用服务 (dead-letter retry / delete / cleanup)。

    ``ctx`` 是 ``ServiceDeps`` —— 经 ``ctx.config.sync_store_db_path`` 直连 SQLite,
    与 CLI 命令体 (src/cli/commands/admin.py) 用同一张 ``email_metadata`` 表、同一套
    SQL (逐字段对齐, 仅错误类型改用 Service* 体系)。``delete_dead_letter`` 例外:
    经 ``ctx.email_repo`` 走 ``delete_email_full`` (要 CASCADE + 附件目录清理)。
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

    def delete_dead_letter(self, internal_id: int, *, actor: Actor) -> dict[str, Any]:
        """彻底删除单封 dead_letter 邮件 (人工确认邮件已处置后清条目)。

        ``cleanup_dead_letter`` 是**按时间批量**清理; 这里是「人工确认某条后单独清掉」
        (admin 面板每行的删除按钮)。

        走 ``EmailRepository.delete_email_full_if_status`` 而非裸 ``DELETE FROM
        email_metadata``: repo 的连接开了 ``PRAGMA foreign_keys=ON``, 删主行才会 CASCADE
        掉 email_body / email_attachment / email_outbox 并清本地附件目录; sqlite3 默认
        foreign_keys=OFF, 裸 DELETE 会留一堆孤儿行。

        **只删 dead_letter 行**: 行不存在 → ``ServiceInvalidArgError`` (与 retry 一致);
        行存在但不是 dead_letter → 同样拒绝 —— 这个入口的语义是「清死信队列条目」,
        不是通用删邮件, 拒掉能挡住「误删一封正常邮件」。

        TOCTOU: 下面的 SELECT(连接 A)只用于友好报错, **实际删除**走带 dead_letter 谓词的
        ``delete_email_full_if_status``(把状态判定并入删除事务的 WHERE) —— 若并发 admin 面
        在 SELECT 与删除之间把该行 retry 成 pending/synced, 谓词删除 rowcount==0 → 拒删,
        不会误删一封刚复活的真邮件。
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
            finally:
                conn.close()
        except sqlite3.Error as exc:
            raise ServiceSchemaError(f"dead-letter delete lookup failed: {exc}") from exc

        if cur is None:
            raise ServiceInvalidArgError(
                f"internal_id={internal_id} not found in email_metadata"
            )
        status = cur[0]
        if status != "dead_letter":
            raise ServiceInvalidArgError(
                f"internal_id={internal_id} is sync_status={status!r}, not dead_letter",
                hint="only dead_letter rows can be deleted through this endpoint",
            )

        # CASCADE (body / attachment / outbox) + 本地附件目录一并清。谓词删除消除 TOCTOU:
        # 窗口内被并发 retry 成非 dead_letter → rowcount==0 → 拒删(不误伤复活的真邮件)。
        deleted = self._ctx.email_repo.delete_email_full_if_status(
            internal_id, "dead_letter"
        )
        if not deleted:
            raise ServiceInvalidArgError(
                f"internal_id={internal_id} is no longer dead_letter "
                f"(status changed concurrently); refused to delete",
                hint="the row was retried/resynced between check and delete",
            )

        return {
            "internal_id": internal_id,
            "old_status": status,
            "deleted": True,
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
