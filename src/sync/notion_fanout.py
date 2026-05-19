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

        Returns:
            (success, detail)
            - (True, 'done') — Notion API 写成功
            - (True, 'noop_idempotent') — payload 与 current state 一致
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

        current_read = bool(record.get("is_read", False))
        current_flagged = bool(record.get("is_flagged", False))

        target_read = bool(payload["is_read"]) if "is_read" in payload else current_read
        target_flagged = (
            bool(payload["is_flagged"]) if "is_flagged" in payload else current_flagged
        )
        target_processing_status = payload.get("processing_status", "")

        # 只 processing_status 变化也算 work, 不要 idempotent skip
        flag_unchanged = (
            target_read == current_read and target_flagged == current_flagged
        )
        if flag_unchanged and not target_processing_status:
            logger.debug(
                f"[notion-fanout] noop idempotent: internal_id={internal_id} "
                f"page_id={notion_page_id}"
            )
            return (True, "noop_idempotent")

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
        return (True, "done")
