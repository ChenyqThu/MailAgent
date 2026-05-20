"""NotionFanout — outbox → Notion pages.update 派发器.

每条 outbox 行（target='notion'）执行:
  1. 读 sync_store 拿 notion_page_id；NULL → noop（邮件还没同步到 Notion）
  2. Idempotency check（同 MailAppFanout）
  3. 调 NotionSync.update_email_flags(page_id, is_read, is_flagged, processing_status)
  4. Notion 429 由 client.py 内置 retry handle，fanout 层兜底重试

详见 SPRINT15-HANDOFF.md §3.3-§3.4 + plan Stage 1.3。
"""

from __future__ import annotations

from typing import Any, Optional, Tuple

from loguru import logger

from src.sync.outbox import OutboxEntry


class NotionFanout:
    """outbox(target='notion') 执行器."""

    def __init__(self, *, sync_store, notion_sync):
        """
        Args:
            sync_store: SyncStore 实例
            notion_sync: NotionSync facade（提供 update_email_flags）
        """
        self.sync_store = sync_store
        self.notion_sync = notion_sync

    async def execute(self, entry: OutboxEntry) -> Tuple[bool, str]:
        """执行一条 notion outbox.

        语义: payload 显式列出的 is_read/is_flagged/processing_status 才传给
        Notion API. Notion pages.update 是幂等的, 不用 SQLite cache 做
        short-circuit (Stage 1.4 后 CLI / handler 端已 update_local_flags 做
        echo prevention, SQLite cache 跟 payload 早就一致 — 一致 ≠ Notion 真实
        状态已同步).

        Returns:
            (success, detail)
            - (True, 'done') — Notion API 写成功
            - (True, 'noop_no_change') — payload 没 notion 关心的字段
            - (True, 'noop_email_missing') — sync_store 找不到 internal_id
            - (True, 'noop_no_page_id') — 邮件还没同步到 Notion (page_id NULL)
            - (False, error_message)
        """
        internal_id = entry.internal_id
        payload = entry.payload or {}

        record = self.sync_store.get(internal_id)
        if record is None:
            return (True, "noop_email_missing")

        notion_page_id = record.get("notion_page_id")
        if not notion_page_id:
            logger.debug(
                f"[notion-fanout] noop no_page_id internal_id={internal_id} "
                f"(邮件未同步到 Notion, 跳过)"
            )
            return (True, "noop_no_page_id")

        has_read = "is_read" in payload
        has_flagged = "is_flagged" in payload
        target_processing_status = payload.get("processing_status", "")

        if not (has_read or has_flagged or target_processing_status):
            return (True, "noop_no_change")

        # NotionSync.update_email_flags 要求 is_read + is_flagged 同时传 bool.
        # payload 没有的字段用 SQLite cache 兜底 (Stage 1.4 后 CLI 已 sync 同值,
        # 跟 payload 一致; 灰度期可能有轻微 stale 风险但 Notion 端被覆盖到的也
        # 仍是 mailagent 期望的最新 intent state)
        target_read = (
            bool(payload["is_read"]) if has_read else bool(record.get("is_read", False))
        )
        target_flagged = (
            bool(payload["is_flagged"]) if has_flagged
            else bool(record.get("is_flagged", False))
        )

        try:
            await self.notion_sync.update_email_flags(
                notion_page_id,
                is_read=target_read,
                is_flagged=target_flagged,
                processing_status=target_processing_status,
            )
        except Exception as e:
            return (False, f"notion update_email_flags failed: {e}")

        logger.info(
            f"[notion-fanout] applied internal_id={internal_id} "
            f"page_id={notion_page_id} read={target_read} "
            f"flagged={target_flagged} status={target_processing_status or '-'}"
        )

        # Sprint 16 — publish 让前端 SSE 路由 invalidate (含 processing_status,
        # 用于前端 done 状态 / Notion 镜像刷新).
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "email.flag_changed",
                internal_id=internal_id,
                data={
                    "target": "notion",
                    "is_read": target_read,
                    "is_flagged": target_flagged,
                    "processing_status": target_processing_status or None,
                    "outbox_source": entry.source,
                },
                source="notion_fanout",
            )
        except Exception:
            pass

        return (True, "done")
