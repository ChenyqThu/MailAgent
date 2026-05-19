"""MailAppFanout — outbox → Mail.app AppleScript 派发器.

每条 outbox 行（target='mailapp'）执行:
  1. 读 sync_store 当前 is_read / is_flagged
  2. Idempotency check: payload 中指定的字段 == current state → 直接 OK
  3. 否则调 AppleScript set is_read / set is_flagged
  4. 成功后 update_local_flags 同步 SQLite (echo prevention)

AppleScript 是 subprocess blocking (~1s)，在 asyncio.to_thread 中执行避免阻塞
其他 fanout（特别是 NotionFanout 也是网络阻塞）。

详见 SPRINT15-HANDOFF.md §3.3-§3.4 + plan Stage 1.3。
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional, Tuple

from loguru import logger

from src.sync.outbox import OutboxEntry


class MailAppFanout:
    """outbox(target='mailapp') 执行器."""

    def __init__(self, *, sync_store, arm):
        """
        Args:
            sync_store: SyncStore 实例（共享 mail-sync 主进程的同一个）
            arm: AppleScriptArm 实例
        """
        self.sync_store = sync_store
        self.arm = arm

    async def execute(self, entry: OutboxEntry) -> Tuple[bool, str]:
        """执行一条 mailapp outbox.

        Returns:
            (success, detail)
            - (True, 'done') — AppleScript 写成功 + sync_store 更新
            - (True, 'noop_idempotent') — payload 与 current state 一致, 跳过
            - (True, 'noop_email_missing') — sync_store 找不到 internal_id, 跳过
              (邮件被删后 outbox 仍有残留 → CASCADE 一般会清, 此处兜底)
            - (False, error_message)
        """
        internal_id = entry.internal_id
        payload = entry.payload or {}

        record = self.sync_store.get(internal_id)
        if record is None:
            return (True, "noop_email_missing")

        current_read = bool(record.get("is_read", False))
        current_flagged = bool(record.get("is_flagged", False))
        mailbox = record.get("mailbox")

        target_read = bool(payload["is_read"]) if "is_read" in payload else current_read
        target_flagged = (
            bool(payload["is_flagged"]) if "is_flagged" in payload else current_flagged
        )

        if target_read == current_read and target_flagged == current_flagged:
            # 状态已经一致，无需调 AppleScript
            logger.debug(
                f"[mailapp-fanout] noop idempotent: internal_id={internal_id} "
                f"read={target_read} flagged={target_flagged}"
            )
            return (True, "noop_idempotent")

        # 调 AppleScript（blocking subprocess） — 包到 to_thread 不阻塞 event loop
        errors = []
        ok = True

        if target_read != current_read:
            success = await asyncio.to_thread(
                self.arm.mark_as_read_by_id, internal_id, target_read, mailbox
            )
            if not success:
                ok = False
                errors.append(f"mark_as_read_by_id failed (target={target_read})")

        if target_flagged != current_flagged:
            success = await asyncio.to_thread(
                self.arm.set_flag_by_id, internal_id, target_flagged, mailbox
            )
            if not success:
                ok = False
                errors.append(f"set_flag_by_id failed (target={target_flagged})")

        if not ok:
            return (False, "; ".join(errors))

        # echo prevention：同步 SQLite 当前 state 防止下次 SQLite radar 误检
        try:
            self.sync_store.update_local_flags(internal_id, target_read, target_flagged)
        except Exception as e:
            # 不致命，至少 AppleScript 写成功了
            logger.warning(
                f"[mailapp-fanout] update_local_flags failed internal_id={internal_id}: {e}"
            )

        logger.info(
            f"[mailapp-fanout] applied internal_id={internal_id} "
            f"read={target_read} flagged={target_flagged} "
            f"(was read={current_read} flagged={current_flagged})"
        )
        return (True, "done")
