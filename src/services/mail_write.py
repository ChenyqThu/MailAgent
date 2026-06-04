"""MailWriteService —— transport-neutral 邮件写操作 (A2: set_flags + resync)。

把「编排 + 守卫」从 CLI 命令体下沉到这里, 让 CLI (typer) 与 serve-api (FastAPI)
各自退化成「解析 → 调 service → 格式化」的薄壳, 不再 fork CLI 跨传输复用
(见 plan cli-streamed-brook.md §A2 / docs/backend-service-migration-matrix.md)。

两类方法:
  - ``plan_flags`` / ``plan_resync``: dry-run 纯预览, **不过** auth/pm2、**不写**任何东西,
    CLI 与 serve-api 共用 (RFC: dry-run 跳过写鉴权)。
  - ``set_flags`` / ``resync``: 执行路径, 入口过 ``require_write_auth(actor)`` +
    ``check_pm2_conflict(allow_concurrent)``, 再调领域类 (NotionSync / SyncStore /
    OutboxRepository, 一行不改)。

返回的 ``@dataclass`` 字段与现 CLI ``emit`` 的 ``data`` 形状**逐字段对齐** (parity
golden 锚定: tests/cli/test_service_parity.py)。方法同步; serve-api 经
``asyncio.to_thread`` 调用 —— ``resync`` 内部用 ``asyncio.run`` 起独立 loop, 在 worker
线程里不与 uvicorn 的 event loop 相撞 (``create_email_page_from_sqlite`` 是 async)。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional

from src.services.errors import ServiceNotFoundError
from src.services.guards import Actor, check_pm2_conflict, require_write_auth
from src.sync.outbox import OutboxRepository

if TYPE_CHECKING:
    from src.services.context import ServiceDeps


# outbox source 标签: 历史上 CLI 直写 + serve-api fork CLI 都落 'cli'; 这里保留以维持
# parity (echo prevention 只特判 source='notion_webhook', 其余 source 仅审计用)。
# 前端写收编 (D1) 时再按传输区分 source。
_OUTBOX_SOURCE = "cli"


@dataclass
class FlagResult:
    """``set_flags`` 执行结果 —— 对齐 ``email_flag`` emit 的 data (dry_run=False 分支)。

    ``not_found`` 恒为 list; CLI 适配器仅在非空时把它放进 emit 的 data
    (保持「空时不出现 not_found 键」的历史形状)。
    """

    updated_ids: list[int]
    payload: dict[str, Any]
    outbox_entries: list[dict[str, Any]]
    not_found: list[int]


@dataclass
class ResyncResult:
    """``resync`` 执行结果 —— 对齐 ``_resync_single`` emit 的 data (dry_run=False 分支)。"""

    internal_id: int
    old_page_id: Optional[str]
    new_page_id: Optional[str]
    archived_page_id: Optional[str]
    action: str


class MailWriteService:
    """邮件写操作的应用服务 (A2 范围: flag / resync)。

    ``ctx`` 是 ``ServiceDeps`` (CliContext 或 ServiceContext 均满足) —— service 只读
    ``email_repo`` / ``sync_store`` / ``notion_sync``, outbox 从 ``sync_store.db_path``
    现取 (与历史 CLI ``OutboxRepository(cli_config.sync_store_db_path)`` 同库)。
    """

    def __init__(self, ctx: "ServiceDeps") -> None:
        self._ctx = ctx

    # ------------------------------------------------------------
    # flags (Sprint 15 SSoT inversion: 写 SQLite intent + outbox 双 target)
    # ------------------------------------------------------------

    @staticmethod
    def _flag_payloads(
        is_read: Optional[bool],
        is_flagged: Optional[bool],
        processing_status: Optional[str],
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """构造 (notion payload, mailapp payload)。

        notion payload 含全部给定字段; mailapp 只读 ``is_read`` / ``is_flagged``
        (MailAppFanout 不认 processing_status)。``None`` 字段不进 payload。
        """
        payload: dict[str, Any] = {}
        if is_read is not None:
            payload["is_read"] = is_read
        if is_flagged is not None:
            payload["is_flagged"] = is_flagged
        if processing_status is not None:
            payload["processing_status"] = processing_status
        mailapp_payload = {
            k: v for k, v in payload.items() if k in ("is_read", "is_flagged")
        }
        return payload, mailapp_payload

    def plan_flags(
        self,
        internal_ids: list[int],
        *,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        processing_status: Optional[str] = None,
    ) -> dict[str, Any]:
        """dry-run 预览 (无 auth/pm2/写)。形状 = ``email_flag`` 的 dry-run 分支。"""
        payload, mailapp_payload = self._flag_payloads(
            is_read, is_flagged, processing_status
        )
        ids = list(internal_ids)
        return {
            "dry_run": True,
            "internal_ids": ids,
            "payload": payload,
            "would_enqueue": [
                {
                    "internal_id": iid,
                    "mailapp_payload": mailapp_payload,
                    "notion_payload": payload,
                }
                for iid in ids
            ],
        }

    def set_flags(
        self,
        internal_ids: list[int],
        *,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        processing_status: Optional[str] = None,
        actor: Actor,
        allow_concurrent: bool = False,
    ) -> FlagResult:
        """写 flag/processing_status intent 到 SQLite (echo prevention) + outbox 双 target。

        搬自 ``src/cli/commands/email.py::email_flag`` 行 1331-1393 (行为保持)。逐封:
        get_metadata → 缺失记 not_found; 否则 ``update_local_flags`` (立即镜像) +
        outbox enqueue (mailapp 仅当有 mailapp_payload + notion)。
        """
        require_write_auth(actor)
        check_pm2_conflict(allow_concurrent=allow_concurrent)

        payload, mailapp_payload = self._flag_payloads(
            is_read, is_flagged, processing_status
        )
        repo = self._ctx.email_repo
        sync_store = self._ctx.sync_store
        outbox = OutboxRepository(str(sync_store.db_path))

        updated: list[int] = []
        outbox_entries: list[dict[str, Any]] = []
        not_found: list[int] = []
        for iid in internal_ids:
            meta = repo.get_metadata(iid)
            if meta is None:
                not_found.append(iid)
                continue

            # 立即 update_local_flags 做 echo prevention; None 字段沿用当前 meta 值。
            new_read = bool(is_read) if is_read is not None else bool(meta.is_read)
            new_flagged = (
                bool(is_flagged) if is_flagged is not None else bool(meta.is_flagged)
            )
            sync_store.update_local_flags(
                iid, new_read, new_flagged, processing_status=processing_status
            )

            oid_mailapp = (
                outbox.enqueue(
                    internal_id=iid,
                    op_type="flag_sync",
                    target="mailapp",
                    payload=mailapp_payload,
                    source=_OUTBOX_SOURCE,
                )
                if mailapp_payload
                else None
            )
            oid_notion = outbox.enqueue(
                internal_id=iid,
                op_type="flag_sync",
                target="notion",
                payload=payload,
                source=_OUTBOX_SOURCE,
            )
            updated.append(iid)
            outbox_entries.append(
                {
                    "internal_id": iid,
                    "mailapp_outbox_id": oid_mailapp,
                    "notion_outbox_id": oid_notion,
                }
            )

        return FlagResult(
            updated_ids=updated,
            payload=payload,
            outbox_entries=outbox_entries,
            not_found=not_found,
        )

    # ------------------------------------------------------------
    # resync (SQLite SSoT → Notion 重传)
    # ------------------------------------------------------------

    def plan_resync(
        self,
        internal_id: int,
        *,
        replace_existing: bool = False,
        skip_parent_lookup: bool = False,
    ) -> dict[str, Any]:
        """dry-run 预览。meta 不存在 → ``ServiceNotFoundError``。形状 = ``_resync_single`` dry-run。"""
        meta = self._ctx.email_repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )
        return {
            "internal_id": internal_id,
            "subject": meta.subject,
            "current_page_id": meta.notion_page_id,
            "action": "replace" if replace_existing else "create_or_skip",
            "would_replace": replace_existing,
            "skip_parent_lookup": skip_parent_lookup,
            "dry_run": True,
        }

    def resync(
        self,
        internal_id: int,
        *,
        replace_existing: bool = False,
        skip_parent_lookup: bool = False,
        actor: Actor,
        allow_concurrent: bool = False,
    ) -> ResyncResult:
        """重传单封到 Notion。搬自 ``_resync_single`` 行 758-807 (行为保持)。

        ``create_email_page_from_sqlite`` 是 async —— 同步方法内用 ``asyncio.run`` 起独立
        loop (serve-api 经 ``asyncio.to_thread`` 调本方法, loop 落在 worker 线程, 不撞
        uvicorn loop)。正文未双写抛 ``ValueError`` → 转 ``ServiceNotFoundError`` + 回填 hint。
        """
        require_write_auth(actor)
        check_pm2_conflict(allow_concurrent=allow_concurrent)

        repo = self._ctx.email_repo
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise ServiceNotFoundError(
                f"Email metadata not found for internal_id={internal_id}"
            )

        try:
            result = asyncio.run(
                self._ctx.notion_sync.create_email_page_from_sqlite(
                    internal_id,
                    repo=repo,
                    sync_store=self._ctx.sync_store,
                    replace_existing=replace_existing,
                    skip_parent_lookup=skip_parent_lookup,
                )
            )
        except ValueError as e:
            raise ServiceNotFoundError(
                str(e),
                hint="Phase 1 之前的邮件正文未双写; 跑 `mailagent backfill body "
                "--internal-ids <id>` 回填后再 resync",
            ) from e

        return ResyncResult(
            internal_id=internal_id,
            old_page_id=result.existing_page_id or meta.notion_page_id,
            new_page_id=result.page_id,
            archived_page_id=result.archived_page_id,
            action=result.action,
        )
