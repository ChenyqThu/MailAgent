"""MailAppFanout — outbox → 邮件后端 (Mail.app / DavMail) 派发器.

每条 outbox 行（target='mailapp'）执行:
  1. 读 sync_store 当前 is_read / is_flagged
  2. Idempotency check: payload 中指定的字段 == current state → 直接 OK
  3. 否则调 backend mark_as_read_by_id / set_flag_by_id
  4. 成功后 update_local_flags 同步 SQLite (echo prevention)

backend 写操作是 blocking IO (AppleScript subprocess ~1s / IMAP STORE)，经单线程
backend-io executor (run_backend_io) 执行：既避免阻塞其他 fanout（特别是 NotionFanout
也是网络阻塞），又与所有 backend 调用串行保序（AppleScript / 单条 IMAP 非并发安全）。

详见 SPRINT15-HANDOFF.md §3.3-§3.4 + plan Stage 1.3。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Tuple

from loguru import logger

from src.mail.backend.serial_executor import run_backend_io
from src.sync.outbox import OutboxEntry

if TYPE_CHECKING:
    from src.mail.backend.base import IMailBackend


class MailAppFanout:
    """outbox(target='mailapp') 执行器."""

    def __init__(self, *, sync_store, backend: "IMailBackend"):
        """
        Args:
            sync_store: SyncStore 实例（共享 mail-sync 主进程的同一个）
            backend: IMailBackend 实例（AppleScript / DavMail）
        """
        self.sync_store = sync_store
        self.backend = backend

    async def execute(self, entry: OutboxEntry) -> Tuple[bool, str]:
        """执行一条 mailapp outbox.

        语义: payload 显式列出的字段才调 AppleScript (字段没在 payload 里 = 不动).
        AppleScript set read status / set flagged status 本身幂等, 重复调无害,
        所以不再用 SQLite cache 做 short-circuit (Stage 1.4 后 CLI / handler 端
        会先 update_local_flags 做 echo prevention, 那是 SQLite cache 跟 payload
        早就一致 — 一致 ≠ Mail.app 真实状态已同步).

        Returns:
            (success, detail)
            - (True, 'done') — AppleScript 写成功 + sync_store 更新
            - (True, 'noop_no_change') — payload 没有任何 mailapp 关心的字段
            - (True, 'noop_email_missing') — sync_store 找不到 internal_id, 跳过
              (邮件被删后 outbox 仍有残留 → CASCADE 一般会清, 此处兜底)
            - (False, error_message)
        """
        internal_id = entry.internal_id
        payload = entry.payload or {}

        record = self.sync_store.get(internal_id)
        if record is None:
            return (True, "noop_email_missing")

        mailbox = record.get("mailbox")

        has_read = "is_read" in payload
        has_flagged = "is_flagged" in payload
        if not (has_read or has_flagged):
            return (True, "noop_no_change")

        target_read = bool(payload["is_read"]) if has_read else None
        target_flagged = bool(payload["is_flagged"]) if has_flagged else None

        # 调 backend（blocking IO） — 经单线程 backend-io executor 执行:
        # 既不阻塞 event loop, 又与其余所有 backend 调用 (new_watcher 的 fetch 等)
        # 串行保序。此前用默认 asyncio.to_thread (多线程池) + concurrency=3 会并发
        # 打同一个 backend 实例 (AppleScript / 单条 IMAP 均非并发安全), run_backend_io
        # 统一收编消除该并发不一致。
        # 不做 SQLite-based idempotency: 写操作协议层幂等, 直接调更可靠
        errors = []
        ok = True

        if has_read:
            success = await run_backend_io(
                self.backend.mark_as_read_by_id, internal_id, target_read, mailbox
            )
            if not success:
                ok = False
                errors.append(f"mark_as_read_by_id failed (target={target_read})")

        if has_flagged:
            success = await run_backend_io(
                self.backend.set_flag_by_id, internal_id, target_flagged, mailbox
            )
            if not success:
                ok = False
                errors.append(f"set_flag_by_id failed (target={target_flagged})")

        if not ok:
            return (False, "; ".join(errors))

        # 不再 update_local_flags: CLI / handler 端在 enqueue 之前已经做了
        # echo prevention 写 SQLite, fanout 这里写就是 idempotent no-op,
        # 且必须传两个 bool (target_read/flagged 可能 None) — 移走保持职责清晰:
        # fanout 只负责对外 API, SQLite cache 同步由发起端做。

        logger.info(
            f"[mailapp-fanout] applied internal_id={internal_id} "
            f"read={target_read} flagged={target_flagged}"
        )

        # Sprint 16 — 派发完成后 publish 让前端 SSE 拿到 internal_id 级精准 invalidate
        # (outbox.done 只带 outbox_id, 前端不知道哪封邮件变了 → 整列 invalidate 太粗).
        try:
            from src.events.publisher import safe_publish
            safe_publish(
                "email.flag_changed",
                internal_id=internal_id,
                data={
                    "target": "mailapp",
                    "is_read": target_read,
                    "is_flagged": target_flagged,
                    "outbox_source": entry.source,
                },
                source="mailapp_fanout",
            )
        except Exception:
            pass  # SSE failure 不能烧穿 fanout 主链路

        return (True, "done")
