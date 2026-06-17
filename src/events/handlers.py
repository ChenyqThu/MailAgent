"""
Webhook 事件处理器

处理从 Redis 队列收到的 Notion 变更事件：
- flag_changed: Is Read / Is Flagged 变化 → 同步到 Mail.app
- ai_reviewed: AI Review 完成 → 飞书通知
- completed: 用户标记已完成 → 移除 Mail.app 旗标
- create_draft: 创建 Mail.app 回复草稿
- page_updated: 通用事件 → 自动判断处理方式
"""

import asyncio
import json
import os
import time
from typing import TYPE_CHECKING, Awaitable, Callable, Dict, Optional
from loguru import logger

from src.mail.applescript_arm import AppleScriptArm
from src.mail.charset_utils import decode_mime_bytes
from src.mail.sync_store import SyncStore
from src.notify.feishu import FeishuNotifier
from src.notion.sync import NotionSync
from src.repository import EmailRepository
from src.sync.outbox import OutboxRepository

if TYPE_CHECKING:
    from src.mail.backend.base import IMailBackend


class EventHandlers:
    """Webhook 事件处理集合"""

    FLAG_ACTIONS = {"需要回复", "需要决策", "需要Review", "需要会议", "需要跟进", "等待响应"}

    def __init__(
        self,
        arm: AppleScriptArm,
        sync_store: SyncStore,
        feishu: Optional[FeishuNotifier] = None,
        notion_sync: Optional[NotionSync] = None,
        result_callback: Optional[Callable[[str, Dict], Awaitable[None]]] = None,
        email_repo: Optional[EmailRepository] = None,
        outbox_repo: Optional[OutboxRepository] = None,
        backend: Optional["IMailBackend"] = None,
    ):
        self.arm = arm
        self.sync_store = sync_store
        self.feishu = feishu
        self.notion_sync = notion_sync
        # v4 SSoT: 注入 EmailRepository 让 handle_fetch_mail_content 优先读 SQLite,
        # miss 时退回 AppleScript（保持向后兼容老邮件）
        self.email_repo = email_repo
        # Sprint 15 SSoT inversion: 注入后 handle_flag_changed/completed/ai_reviewed
        # 改写为「写 SQLite intent + outbox」, 不直调 AppleScript / NotionSync。
        # 详 SPRINT15-HANDOFF.md §3.3 (B) + plan Stage 1.4。
        self.outbox_repo = outbox_repo
        # Sprint 16 dual-backend: 注入 IMailBackend 让 handle_create_draft 在 davmail
        # 模式下走 IMAP APPEND 替代 scripts/create_reply_draft.sh AppleScript GUI 注入.
        # arm 仍保留作 AppleScript 兼容接口 (davmail mode 下 arm = backend).
        self.backend = backend
        self._result_callback = result_callback
        self._radar = None  # 延迟初始化
        self._stats = {
            "flag_changed": 0,
            "ai_reviewed": 0,
            "completed": 0,
            "create_draft": 0,
            "create_draft_success": 0,
            "create_draft_error": 0,
            "query_mail": 0,
            "fetch_mail_content": 0,
            "fetch_mail_content_sqlite_hit": 0,
            "fetch_mail_content_sqlite_miss": 0,
            "search_email_bodies": 0,
            "search_email_bodies_hits": 0,
            "search_email_bodies_empty": 0,
            "search_email_bodies_error": 0,
            # PR-2b: 附件 FTS 搜索 stats
            "search_email_attachments": 0,
            "search_email_attachments_hits": 0,
            "search_email_attachments_empty": 0,
            "search_email_attachments_error": 0,
            "feishu_notified": 0,
        }
        # v4 P2-04: rolling latency buffers (last 1000 samples per path) for P99
        # stats_reporter 通过 get_stats() 一并上报 dashboard
        self._latency_sqlite_ms: list[int] = []
        self._latency_applescript_ms: list[int] = []
        self._latency_search_ms: list[int] = []  # v4 P3-03: FTS5 search latency
        self._latency_buffer_max = 1000

    def get_stats(self) -> Dict:
        """返回事件处理统计 + P99 latency 指标（fetch_mail_content 两条路径）."""
        out = dict(self._stats)
        out["fetch_mail_content_sqlite_p99_ms"] = self._percentile(
            self._latency_sqlite_ms, 0.99
        )
        out["fetch_mail_content_sqlite_p50_ms"] = self._percentile(
            self._latency_sqlite_ms, 0.50
        )
        out["fetch_mail_content_applescript_p99_ms"] = self._percentile(
            self._latency_applescript_ms, 0.99
        )
        out["fetch_mail_content_applescript_p50_ms"] = self._percentile(
            self._latency_applescript_ms, 0.50
        )
        out["search_email_bodies_p99_ms"] = self._percentile(
            self._latency_search_ms, 0.99
        )
        out["search_email_bodies_p50_ms"] = self._percentile(
            self._latency_search_ms, 0.50
        )
        return out

    def _record_latency(self, buffer: list, latency_ms: int) -> None:
        buffer.append(latency_ms)
        if len(buffer) > self._latency_buffer_max:
            del buffer[: len(buffer) - self._latency_buffer_max]

    @staticmethod
    def _percentile(samples: list, p: float) -> int:
        if not samples:
            return 0
        s = sorted(samples)
        idx = int(len(s) * p)
        return int(s[min(idx, len(s) - 1)])

    async def _fetch_full_page_props(self, page_id: str) -> Dict:
        """从 Notion API 拉取完整页面属性，补全 webhook 缺失字段"""
        page = await self.notion_sync.client.client.pages.retrieve(page_id=page_id)
        raw_props = page.get("properties", {})
        result = {}
        def _text(p):
            for k in ("title", "rich_text"):
                items = p.get(k, [])
                if items:
                    return "".join(i.get("plain_text", "") for i in items)
            return ""
        def _select(p): return (p.get("select") or {}).get("name", "")
        def _email(p): return p.get("email", "") or ""
        def _checkbox(p): return bool(p.get("checkbox"))
        def _date(p): return (p.get("date") or {}).get("start", "")
        field_map = {
            "Subject": ("subject", _text),
            "From Name": ("from_name", _text),
            "From": ("from_email", _email),
            "To": ("to_addr", _text),
            "CC": ("cc_addr", _text),
            "Date": ("date", _date),
            "Action Type": ("ai_action", _select),
            "Priority": ("ai_priority", _select),
            "Mailbox": ("mailbox", _select),
            "Category": ("category", _select),
            "AI Summary": ("ai_summary", _text),
            "Reply Suggestion": ("reply_suggestion", _text),
            "Message ID": ("message_id", _text),
        }
        for notion_key, (out_key, extractor) in field_map.items():
            prop = raw_props.get(notion_key)
            if prop is not None:
                result[out_key] = extractor(prop)
        return result

    async def handle_flag_changed(self, event: Dict):
        """处理 flag 变化事件: Notion → Mail.app

        Sprint 15 起当 outbox_repo 注入时走新路径:
          1) 立即 update_local_flags 同步 SQLite (echo prevention)
          2) outbox.enqueue(target='mailapp', source='notion_webhook')
          3) target='notion' 由 OutboxRepository.enqueue echo prevention silent skip
          4) FanoutWorker 异步派发到 Mail.app

        outbox_repo=None 时走老路径（直接 AppleScript+sync_store）。
        """
        self._stats["flag_changed"] += 1
        props = event.get("properties", {})
        message_id = props.get("message_id", "")
        is_read = props.get("is_read")
        is_flagged = props.get("is_flagged")

        if not message_id:
            logger.warning(f"flag_changed event missing message_id: {event.get('id')}")
            return

        # 查找 internal_id
        record = self.sync_store.get_by_message_id(message_id)
        if not record:
            logger.warning(f"Email not found in SyncStore: {message_id[:40]}")
            return

        internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)
        mailbox = record.get('mailbox') if isinstance(record, dict) else getattr(record, 'mailbox', None)
        stored_read = bool(record.get('is_read') if isinstance(record, dict) else getattr(record, 'is_read', False))
        stored_flagged = bool(record.get('is_flagged') if isinstance(record, dict) else getattr(record, 'is_flagged', False))

        # ===== Sprint 15 新路径：outbox enabled =====
        if self.outbox_repo is not None and internal_id:
            payload: Dict[str, bool] = {}
            if is_read is not None and is_read != stored_read:
                payload['is_read'] = bool(is_read)
            if is_flagged is not None and is_flagged != stored_flagged:
                payload['is_flagged'] = bool(is_flagged)

            if not payload:
                logger.debug(
                    f"[flag_changed→outbox] noop, state matches: {message_id[:40]}"
                )
                return

            # 立即 echo prevention：刷 SQLite 到 target state, 避免下一轮 radar 误判
            new_read = is_read if is_read is not None else stored_read
            new_flagged = is_flagged if is_flagged is not None else stored_flagged
            self.sync_store.update_local_flags(internal_id, new_read, new_flagged)

            outbox_id = self.outbox_repo.enqueue(
                internal_id=internal_id,
                op_type='flag_sync',
                target='mailapp',
                payload=payload,
                source='notion_webhook',
            )
            logger.info(
                f"[flag_changed→outbox] internal_id={internal_id} "
                f"outbox_id={outbox_id} payload={payload}"
            )
            return

        # ===== 老路径：outbox disabled, 直接调 AppleScript =====
        changed = False

        # 同步 read 状态
        if is_read is not None and is_read != stored_read:
            if internal_id:
                success = self.arm.mark_as_read_by_id(internal_id, is_read, mailbox)
            else:
                success = self.arm.mark_as_read(message_id, is_read, mailbox)
            if success:
                changed = True
                logger.info(f"Flag sync: read={is_read} for {message_id[:40]}")

        # 同步 flagged 状态
        if is_flagged is not None and is_flagged != stored_flagged:
            if internal_id:
                success = self.arm.set_flag_by_id(internal_id, is_flagged, mailbox)
            else:
                success = self.arm.set_flag(message_id, is_flagged, mailbox)
            if success:
                changed = True
                logger.info(f"Flag sync: flagged={is_flagged} for {message_id[:40]}")

        # 更新 SyncStore 防止 echo
        if changed and internal_id:
            new_read = is_read if is_read is not None else stored_read
            new_flagged = is_flagged if is_flagged is not None else stored_flagged
            self.sync_store.update_local_flags(internal_id, new_read, new_flagged)

    async def handle_ai_reviewed(self, event: Dict):
        """处理 AI Review 完成事件: Mail.app 标旗 + 飞书通知 + 更新 Notion 状态"""
        self._stats["ai_reviewed"] += 1
        props = event.get("properties", {})
        page_id = event.get("page_id", "")
        ai_priority = props.get("ai_priority", "")
        ai_action = props.get("ai_action", "")
        message_id = props.get("message_id", "")
        mailbox = props.get("mailbox", "")

        # 查找 internal_id
        internal_id = None
        record = None
        if message_id and self.sync_store:
            record = self.sync_store.get_by_message_id(message_id)
            if record:
                internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)

        # Mail.app 标旗/已读
        # Sprint 15: 当 outbox enabled, 写 outbox(target='mailapp', source='ai_reviewed_handler')
        # 由 FanoutWorker 异步派发；同时立即 update_local_flags 做 echo prevention。
        # 注意 source 不用 'notion_webhook' 因为这个 intent 是 mailagent 主动产生的，
        # 不属于 Notion 用户手改场景，target='notion' 后续也应该允许（写 processing_status）。
        if internal_id:
            target_flagged = ai_action in self.FLAG_ACTIONS

            if self.outbox_repo is not None:
                payload = {'is_read': True, 'is_flagged': target_flagged}
                # Sprint 16 收尾: SSoT 反转修复 — 同步把 processing_status='已同步' 镜像到
                # SQLite (原本只写 outbox payload 给 Notion 派发, SQLite 字段一直为空,
                # 前端 listEnriched 读 SQLite 看不到状态). 跟 update_email_flags Notion 端写
                # 的'已同步'保持口径一致.
                self.sync_store.update_local_flags(
                    internal_id, True, target_flagged, processing_status='已同步'
                )
                outbox_id = self.outbox_repo.enqueue(
                    internal_id=internal_id,
                    op_type='flag_sync',
                    target='mailapp',
                    payload=payload,
                    source='ai_reviewed_handler',
                )
                logger.info(
                    f"[ai_reviewed→outbox] internal_id={internal_id} "
                    f"outbox_id={outbox_id} payload={payload}"
                )
            else:
                # 老路径
                # Sprint 16 收尾: 老路径同样镜像 processing_status='已同步' 到 SQLite,
                # 跟 outbox 主路径口径一致, 前端 listEnriched 立即读到 done 状态.
                if target_flagged:
                    self.arm.mark_as_read_by_id(internal_id, True, mailbox)
                    self.arm.set_flag_by_id(internal_id, True, mailbox)
                    self.sync_store.update_local_flags(
                        internal_id, True, True, processing_status='已同步'
                    )
                else:
                    self.arm.mark_as_read_by_id(internal_id, True, mailbox)
                    self.sync_store.update_local_flags(
                        internal_id, True, False, processing_status='已同步'
                    )

        # 飞书通知：重要/紧急 且 需要行动（发件箱不通知）
        notify_priorities = {"🔴 紧急", "🟡 重要"}
        should_notify = (
            ai_priority in notify_priorities
            and ai_action in self.FLAG_ACTIONS
            and mailbox != "发件箱"
        )
        if should_notify and self.feishu:
            # Notion webhook 只含变更字段，补全缺失的展示字段
            subject = props.get("subject", "")
            if not subject and record:
                subject = (record.get('subject') if isinstance(record, dict)
                           else getattr(record, 'subject', '')) or ''

            # 若 from_name/date/ai_summary 等缺失，从 Notion API 拉完整页面
            full_props = props
            needs_fetch = not props.get("from_name") and not props.get("date") and not props.get("ai_summary")
            if needs_fetch and page_id and self.notion_sync:
                try:
                    full_props = await self._fetch_full_page_props(page_id)
                    full_props.setdefault("subject", subject)
                    full_props.setdefault("ai_action", ai_action)
                    full_props.setdefault("ai_priority", ai_priority)
                    full_props.setdefault("mailbox", mailbox)
                    full_props.setdefault("message_id", message_id)
                except Exception as e:
                    logger.warning(f"Failed to fetch full page props for notification: {e}")

            self._stats["feishu_notified"] += 1
            await self.feishu.notify_important_email({
                "page_id": page_id,
                "message_id": message_id,
                "internal_id": internal_id,
                "subject": full_props.get("subject") or subject,
                "from_name": full_props.get("from_name", ""),
                "from_email": full_props.get("from_email", ""),
                "to_addr": full_props.get("to_addr", ""),
                "cc_addr": full_props.get("cc_addr", ""),
                "date": full_props.get("date", ""),
                "mailbox": mailbox,
                "ai_action": ai_action,
                "ai_priority": ai_priority,
                "ai_summary": full_props.get("ai_summary", ""),
                "reply_suggestion": full_props.get("reply_suggestion", ""),
                "category": full_props.get("category", ""),
            })

        # 更新 Notion: Is Read / Is Flagged + Processing Status → 已同步
        # Sprint 15: outbox enabled 时改走 outbox(target='notion', source='ai_reviewed_handler')
        # source 不是 'notion_webhook', echo prevention 不拦; FanoutWorker 派发到 Notion。
        # Synced to Mail (update_page_mail_sync_status) 仍走直接 API（小变更, 不值得 outbox）。
        if page_id and self.notion_sync:
            try:
                is_flagged_for_notion = ai_action in self.FLAG_ACTIONS

                if self.outbox_repo is not None and internal_id:
                    notion_payload = {
                        'is_read': True,
                        'is_flagged': is_flagged_for_notion,
                        'processing_status': '已同步',
                    }
                    self.outbox_repo.enqueue(
                        internal_id=internal_id,
                        op_type='flag_sync',
                        target='notion',
                        payload=notion_payload,
                        source='ai_reviewed_handler',
                    )
                    # update_page_mail_sync_status 仍直接调（带外 ack）
                    await self.notion_sync.update_page_mail_sync_status(
                        page_id, synced=True
                    )
                else:
                    # 老路径
                    await self.notion_sync.update_email_flags(
                        page_id,
                        is_read=True,
                        is_flagged=is_flagged_for_notion,
                        processing_status="已同步"
                    )
                    await self.notion_sync.update_page_mail_sync_status(
                        page_id, synced=True
                    )
            except Exception as e:
                logger.warning(f"Webhook: failed to update Notion status: {e}")

        # v14 (Sprint 16 收尾, codex P1): Notion webhook 带的 AI props 回写
        # llm_processing.labels_json + 双写 email_metadata.ai_priority/ai_action.
        # 之前外部源 (Notion Custom Agent / 人工改) 的 AI labels 只用于飞书通知,
        # 不入 SQLite, 前端 listEnriched 仅看本地 LLM 产出 → SSoT 缺一层. 修复:
        if internal_id:
            try:
                # AILabels schema 字段命名 (priority/action_type) vs Notion property
                # 命名 (ai_priority/ai_action) 映射. 仅传非空字段, COALESCE 不覆盖
                # 已有 labels_json (本地 LLM 产出比外部源权威, 这层只补外部漏掉的).
                external_labels = {}
                if ai_priority:
                    external_labels["priority"] = ai_priority
                if ai_action:
                    external_labels["action_type"] = ai_action
                # 其他 AI props (full_props from _fetch_full_page_props or webhook 直送)
                for src_key, dst_key in (
                    ("ai_summary", "ai_summary"),
                    ("category", "category"),
                    ("language", "language"),
                    ("sender_priority", "sender_priority"),
                    ("reply_suggestion", "reply_suggestion_md"),
                    ("key_points", "key_points"),
                ):
                    src = locals().get("full_props", props) or props
                    val = src.get(src_key, "")
                    if val:
                        external_labels[dst_key] = val
                if external_labels:
                    from src.llm_agent.store import LLMProcessingStore
                    if not hasattr(self, "_llm_store_lazy"):
                        self._llm_store_lazy = LLMProcessingStore()
                    self._llm_store_lazy.upsert_external_labels(
                        internal_id, external_labels,
                        source="ai_reviewed_handler",
                        notion_page_id=page_id or None,
                        mailbox=mailbox or None,
                    )
            except Exception as e:
                logger.warning(
                    f"upsert_external_labels failed (non-fatal) for "
                    f"internal_id={internal_id}: {e}"
                )

    async def handle_completed(self, event: Dict):
        """处理用户标记已完成事件: 移除 Mail.app 旗标

        Sprint 15 D 块守护: 必须 event.properties.processing_status (或 alias
        ai_review_status) == '已完成' 才动手. 之前 _detect_and_sync_flag_changes
        bug 会把 Notion processing_status 错写为'已完成', 触发本 handler 把用户
        刚 flag 的邮件 unflag, 形成死循环 (handoff §诊断). 即便 _detect 已禁,
        加一层 defensive guard 防止未来其它 race 误触发.
        """
        self._stats["completed"] += 1
        props = event.get("properties", {})
        message_id = props.get("message_id", "")

        if not message_id:
            logger.warning(f"completed event missing message_id: {event.get('id')}")
            return

        # Sprint 15 D 块: 强守护. props 里可能既没 processing_status 也没
        # ai_review_status 字段 (Notion webhook 只送变更字段), 这种 webhook 不可信,
        # 不该 unflag.
        status = (props.get("processing_status") or props.get("ai_review_status") or "")
        if status != "已完成":
            logger.debug(
                f"handle_completed: skipped, processing_status={status!r} (not '已完成') "
                f"for {message_id[:40]}"
            )
            return

        record = self.sync_store.get_by_message_id(message_id)
        if not record:
            logger.warning(f"Email not found in SyncStore: {message_id[:40]}")
            return

        internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)
        mailbox = record.get('mailbox') if isinstance(record, dict) else getattr(record, 'mailbox', None)
        stored_flagged = bool(record.get('is_flagged') if isinstance(record, dict) else getattr(record, 'is_flagged', False))
        stored_read = bool(record.get('is_read') if isinstance(record, dict) else getattr(record, 'is_read', False))
        stored_ps = (record.get('processing_status') if isinstance(record, dict) else getattr(record, 'processing_status', '')) or ''

        # Sprint 16 收尾 (codex 审 P1): early return 只在 "三个目标状态都已满足" 时才退,
        # 否则即便 flag 已是 False, 也要补 ps='已完成' 镜像. 防 Notion webhook 明确带
        # Processing Status=已完成 但 SQLite ps 字段保持空的 SSoT 漏洞.
        if not stored_flagged and stored_read and stored_ps == '已完成':
            logger.debug(f"Already in completed state, skipping: {message_id[:40]}")
            return

        # Sprint 15 新路径：outbox enabled
        # source='notion_webhook' + target='notion' 会被 echo prevention silent skip
        # 所以只写 target='mailapp'（Notion 那边用户已经手改, 不需要回写）
        if self.outbox_repo is not None and internal_id:
            # Sprint 16 收尾: SSoT 反转修复 — 同步把 processing_status='已完成' 镜像到
            # SQLite, 前端能立即区分"已同步" vs "已完成". guard 已校验 Notion 端是'已完成'.
            self.sync_store.update_local_flags(
                internal_id, True, False, processing_status='已完成'
            )
            outbox_id = self.outbox_repo.enqueue(
                internal_id=internal_id,
                op_type='flag_sync',
                target='mailapp',
                payload={'is_read': True, 'is_flagged': False},
                source='notion_webhook',
            )
            logger.info(
                f"[completed→outbox] internal_id={internal_id} "
                f"outbox_id={outbox_id} unflagged"
            )
        else:
            # 老路径
            # 移除旗标 + 标记已读
            if internal_id:
                self.arm.set_flag_by_id(internal_id, False, mailbox)
                self.arm.mark_as_read_by_id(internal_id, True, mailbox)
            else:
                self.arm.set_flag(message_id, False, mailbox)
                self.arm.mark_as_read(message_id, True, mailbox)

            # Echo prevention + Sprint 16 SSoT 镜像 processing_status='已完成'
            if internal_id:
                self.sync_store.update_local_flags(
                    internal_id, True, False, processing_status='已完成'
                )

            logger.info(f"Completed: unflagged {message_id[:40]}")

        # ping-island MailCompleted（默认关，fail-open；清掉 Phase 2 dock icon）
        try:
            from src.notify import island_dispatch
            if internal_id and island_dispatch.is_enabled():
                island_dispatch.dispatch_mail_completed(
                    internal_id=internal_id,
                    page_id=event.get("page_id", "") or "",
                    subject=(record.get('subject') if isinstance(record, dict)
                             else getattr(record, 'subject', '')) or "",
                    mailbox=mailbox or "",
                )
        except Exception as e:
            logger.debug(f"[island-hook] mail_completed dispatch failed: {e}")

    async def handle_create_draft(self, event: Dict):
        """创建邮件回复草稿（Notion 按钮 / Openclaw 触发）.

        Sprint 16 dual-backend:
          - davmail mode: 走 backend.append_draft (IMAP APPEND 到 Drafts), 富文本完美
          - applescript mode (默认): 走 scripts/create_reply_draft.sh (GUI 注入老路径)
        """
        self._stats["create_draft"] += 1
        import time as _time
        _t0 = _time.monotonic()

        props = event.get("properties", {})
        event_id = event.get("id", "")
        page_id = event.get("page_id", "")
        message_id = props.get("message_id", "")
        reply_suggestion = props.get("reply_suggestion", "")
        reply_suggestion_rich = props.get("reply_suggestion_rich")
        mailbox = props.get("mailbox", "收件箱")
        event_source = event.get("source", "webhook")

        logger.info(
            f"create_draft: start | source={event_source} page={page_id[:12]} "
            f"has_rich={reply_suggestion_rich is not None} has_md={bool(reply_suggestion)} "
            f"md_len={len(reply_suggestion)} mailbox={mailbox}"
        )

        if not reply_suggestion and not reply_suggestion_rich:
            logger.warning(f"create_draft: no reply_suggestion for {page_id}")
            await self._publish(event_id, {"status": "error", "error": "no reply_suggestion"})
            return

        # 查找 internal_id
        internal_id = None
        if message_id and self.sync_store:
            record = self.sync_store.get_by_message_id(message_id)
            if record:
                internal_id = record.get('internal_id') if isinstance(record, dict) else getattr(record, 'internal_id', None)

        # Sprint 16 dual-backend: davmail mode 走 IMAP APPEND, 不走 sh GUI 注入
        if self.backend is not None and getattr(self.backend, 'backend_origin', '') == 'davmail':
            await self._create_draft_via_imap(
                event=event, event_id=event_id, page_id=page_id,
                internal_id=internal_id, message_id=message_id,
                reply_suggestion=reply_suggestion,
                reply_suggestion_rich=reply_suggestion_rich,
                props=props, mailbox=mailbox, _t0=_t0,
            )
            return

        # 预设剪贴板（在 Mail.app 打开前完成 HTML 转换）
        clipboard_ready = False
        script_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "scripts")
        clipboard_py = os.path.join(script_path, "html_clipboard.py")

        clipboard_html_file = None
        if reply_suggestion_rich:
            from src.converter.notion_rich_text import rich_text_to_html
            html = rich_text_to_html(reply_suggestion_rich)
            logger.info(f"create_draft: path=rich_text items={len(reply_suggestion_rich)} html_len={len(html)}")
            proc_clip = await asyncio.create_subprocess_exec(
                "python3", clipboard_py, "--set-html",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await proc_clip.communicate(input=html.encode())
            clipboard_ready = proc_clip.returncode == 0
            # 保存 HTML 到临时文件，供脚本粘贴重试时使用
            if clipboard_ready:
                clipboard_html_file = os.path.join('/tmp', f'mail_draft_clip_{int(_t0 * 1000)}.html')
                with open(clipboard_html_file, 'w') as f:
                    f.write(html)
        elif reply_suggestion:
            logger.info(f"create_draft: path=markdown md_len={len(reply_suggestion)}")
            proc_clip = await asyncio.create_subprocess_exec(
                "python3", clipboard_py,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            await proc_clip.communicate(input=reply_suggestion.encode())
            clipboard_ready = proc_clip.returncode == 0

        _t1 = _time.monotonic()
        logger.info(f"create_draft: clipboard_ready={clipboard_ready} took={_t1 - _t0:.1f}s")

        # 构建脚本参数
        mode = props.get("mode", "reply-all")
        extra_to = props.get("extra_to", "")
        extra_cc = props.get("extra_cc", "")
        subject = props.get("subject", "")
        to_email = props.get("to", "") or props.get("to_email", "")

        draft_script = os.path.join(script_path, "create_reply_draft.sh")
        cmd = ["bash", draft_script, "--mode", mode, "--reply-text", reply_suggestion or "(rich text)", "--mailbox", mailbox]
        if clipboard_ready:
            cmd.append("--clipboard-ready")
        if clipboard_html_file:
            cmd.extend(["--clipboard-html-file", clipboard_html_file])
        if internal_id:
            cmd.extend(["--internal-id", str(internal_id)])
        elif message_id:
            cmd.extend(["--message-id", message_id])
        if extra_to:
            cmd.extend(["--extra-to", extra_to])
        if extra_cc:
            cmd.extend(["--extra-cc", extra_cc])
        if mode == "new":
            if to_email:
                cmd.extend(["--to", to_email])
            if subject:
                cmd.extend(["--subject", subject])

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
            output = stdout.decode().strip()

            if proc.returncode == 0:
                result = json.loads(output) if output else {}
                method = result.get("method", "unknown")
                _t2 = _time.monotonic()
                logger.info(f"create_draft: done | method={method} total={_t2 - _t0:.1f}s msg={message_id[:40]}")

                # 更新 Notion Processing Status
                if page_id and self.notion_sync:
                    await self.notion_sync.update_page_mail_sync_status(
                        page_id, synced=True, processing_status="草稿已创建"
                    )
                # §4.5.6 SSoT 反转: 镜像到 SQLite, 让前端 listEnriched 立即
                # 看到状态变更, 不等 Notion fanout 回灌. record 来自 line 580
                # get_by_message_id, applescript 路径下保持 read/flag 不变.
                if internal_id and record and self.sync_store:
                    self.sync_store.update_local_flags(
                        internal_id,
                        bool(record.get("is_read", 0)),
                        bool(record.get("is_flagged", 0)),
                        processing_status="草稿已创建",
                    )
                self._stats["create_draft_success"] += 1
                await self._publish(event_id, {"status": "success", **result})
            else:
                error = (stderr.decode()[:200] + " | " + output[:200]).strip(" |")
                self._stats["create_draft_error"] += 1
                logger.error(f"Draft script failed (rc={proc.returncode}): {error}")
                await self._publish(event_id, {"status": "error", "error": error})
        except asyncio.TimeoutError:
            self._stats["create_draft_error"] += 1
            logger.error(f"Draft script timeout for {message_id[:40]}")
            await self._close_mail_window()
            await self._publish(event_id, {"status": "error", "error": "timeout"})
        except Exception as e:
            self._stats["create_draft_error"] += 1
            logger.error(f"Draft creation error: {e}")
            await self._close_mail_window()
            await self._publish(event_id, {"status": "error", "error": str(e)})
        finally:
            # 清理临时 HTML 文件
            if clipboard_html_file and os.path.exists(clipboard_html_file):
                try:
                    os.unlink(clipboard_html_file)
                except OSError:
                    pass

    async def _create_draft_via_imap(
        self, *, event, event_id, page_id, internal_id, message_id,
        reply_suggestion, reply_suggestion_rich, props, mailbox, _t0,
    ):
        """Phase B.3: davmail mode 走 IMAP APPEND 创建草稿 (替代 AppleScript GUI 注入).

        步骤:
          1. 从 sync_store.get(internal_id) 拿原邮件 metadata (sender/to_addr/cc_addr/subject)
          2. 按 mode (reply-all / reply / new) 计算收件人; merge props extra_to/cc
          3. rich_text → HTML (notion_rich_text.rich_text_to_html) 或 markdown → HTML
             (html_clipboard.md_to_html); plain text 用 reply_suggestion 原值
          4. 拼 DraftRequest → self.backend.append_draft → DraftAppendResult
          5. publish result + Notion Processing Status='草稿已创建'
        """
        import time as _time
        from src.config import config as _cfg
        from src.mail.backend import DraftRequest

        try:
            self_email = (_cfg.user_email or "").lower().strip()
            mode = props.get("mode", "reply-all")
            extra_to = [e.strip() for e in (props.get("extra_to") or "").split(",") if e.strip()]
            extra_cc = [e.strip() for e in (props.get("extra_cc") or "").split(",") if e.strip()]
            subject = props.get("subject", "")

            # 1. 原邮件 metadata
            record = self.sync_store.get(internal_id) if internal_id else None

            # 2. 计算收件人
            to_list: list[str] = []
            cc_list: list[str] = []
            if mode == "new":
                if props.get("to_email") or props.get("to"):
                    to_list = [props.get("to_email") or props.get("to")]
            elif record:
                orig_from = (record.get("sender") or "").strip()
                orig_to = self._split_addrs(record.get("to_addr") or "")
                orig_cc = self._split_addrs(record.get("cc_addr") or "")
                if mode == "reply":
                    to_list = [orig_from] if orig_from else []
                else:  # reply-all
                    candidates = ([orig_from] if orig_from else []) + orig_to
                    to_list = [a for a in candidates if a.lower() != self_email]
                    cc_list = [a for a in orig_cc if a.lower() != self_email]
                # subject 自动加 Re: 前缀
                if not subject:
                    orig_subj = record.get("subject", "")
                    subject = orig_subj if orig_subj.lower().startswith("re:") else f"Re: {orig_subj}"
            to_list = list(dict.fromkeys(to_list + extra_to))  # dedup 保序
            cc_list = list(dict.fromkeys(cc_list + extra_cc))

            # 3. 拼 HTML + plain text
            html: Optional[str] = None
            plain_text = reply_suggestion or "(rich text body)"
            if reply_suggestion_rich:
                from src.converter.notion_rich_text import rich_text_to_html
                html = rich_text_to_html(reply_suggestion_rich)
            elif reply_suggestion:
                # md_to_html 已抽到 src/converter (打包态 site-packages 必含);
                # 旧版 dirname×3(__file__)/scripts 推路径在 .app 算错位 →
                # ModuleNotFoundError (同 compose 预填的 E_GENERIC 根因)。
                from src.converter.markdown_to_html import md_to_html
                html = md_to_html(reply_suggestion)

            # In-Reply-To: 原邮件 Message-ID 加 <> 包裹
            in_reply_to: Optional[str] = None
            references: Optional[str] = None
            msg_id_clean = (message_id or "").strip().strip("<>")
            if msg_id_clean:
                in_reply_to = f"<{msg_id_clean}>"
                # References chain (HIGH #4): Outlook 线程 fold 看 References 内任意
                # message-id 命中即归同线程; 用 thread_id (= 原线程头 msgid) + 原邮件
                # msgid 拼链, 覆盖大多数 reply 场景. 嵌套深的 chain 不完美但够用 —
                # cutover 后若发现 thread fold 失败再扩 (TODO: 走 backend.fetch 拿
                # raw References).
                tid = (record.get("thread_id") if record else "") or ""
                tid_clean = tid.strip().strip("<>")
                chunks: list[str] = []
                if tid_clean and tid_clean != msg_id_clean:
                    chunks.append(f"<{tid_clean}>")
                chunks.append(in_reply_to)
                references = " ".join(chunks)

            # 4. DraftRequest + backend.append_draft
            draft = DraftRequest(
                mode=mode,
                internal_id_for_threading=internal_id,
                to=to_list, cc=cc_list,
                subject=subject or "(no subject)",
                reply_text=plain_text,
                reply_html=html,
                in_reply_to=in_reply_to,
                references=references,
            )
            logger.info(
                f"create_draft (davmail/IMAP APPEND): mode={mode} "
                f"to={len(to_list)} cc={len(cc_list)} subject={subject[:40]!r} "
                f"html_len={len(html) if html else 0}"
            )

            result = self.backend.append_draft(draft)
            _t2 = _time.monotonic()

            if result.success:
                logger.info(
                    f"create_draft: done | method=imap_append uid={result.appended_uid} "
                    f"folder={result.drafts_folder!r} total={_t2 - _t0:.1f}s"
                )
                if page_id and self.notion_sync:
                    await self.notion_sync.update_page_mail_sync_status(
                        page_id, synced=True, processing_status="草稿已创建"
                    )
                # §4.5.6 SSoT 反转: 镜像到 SQLite, 让前端 listEnriched 立即
                # 看到状态变更, 不等 Notion fanout 回灌. record 来自 line 724
                # get(internal_id), davmail IMAP APPEND 路径下保持 read/flag 不变.
                if internal_id and record and self.sync_store:
                    self.sync_store.update_local_flags(
                        internal_id,
                        bool(record.get("is_read", 0)),
                        bool(record.get("is_flagged", 0)),
                        processing_status="草稿已创建",
                    )
                self._stats["create_draft_success"] += 1
                await self._publish(event_id, {
                    "status": "success",
                    "method": "imap_append",
                    "appended_uid": result.appended_uid,
                    "drafts_folder": result.drafts_folder,
                })
            else:
                self._stats["create_draft_error"] += 1
                logger.error(f"create_draft (davmail): IMAP APPEND failed: {result.error}")
                await self._publish(event_id, {
                    "status": "error",
                    "error": f"IMAP APPEND failed: {result.error}",
                })
        except Exception as e:
            self._stats["create_draft_error"] += 1
            logger.error(f"create_draft (davmail) error: {e}", exc_info=True)
            await self._publish(event_id, {"status": "error", "error": f"davmail draft: {e}"})

    @staticmethod
    def _split_addrs(addrs: str) -> list[str]:
        """split RFC 822 to/cc 字段, 提纯 email 地址.

        review MEDIUM: 旧版 ``split(",")`` 在 ``"LastName, FirstName" <a@b>`` 这种含
        逗号的 quoted display name 会错切. 改用 stdlib ``email.utils.getaddresses``
        正确处理 quoted string / IDN / nested groups.
        """
        if not addrs:
            return []
        from email.utils import getaddresses
        # 先把分号换成逗号 (Outlook 习惯 semicolon-separated; RFC 5322 要求 comma).
        normalized = addrs.replace(";", ",")
        out: list[str] = []
        try:
            pairs = getaddresses([normalized])
            for _name, email in pairs:
                email = (email or "").strip()
                if email:
                    out.append(email)
        except Exception:
            # 极端 malformed input → 退回旧式 split (best-effort, 别整个 crash)
            for piece in normalized.split(","):
                piece = piece.strip()
                if not piece:
                    continue
                if "<" in piece and ">" in piece:
                    start = piece.index("<")
                    end = piece.index(">", start)
                    out.append(piece[start + 1:end].strip())
                else:
                    out.append(piece)
        return out

    async def _publish(self, event_id: str, result: Dict):
        """发布事件执行结果到 Redis"""
        if event_id and self._result_callback:
            try:
                await self._result_callback(event_id, result)
            except Exception as e:
                logger.warning(f"Failed to publish result for {event_id}: {e}")

    @staticmethod
    async def _close_mail_window():
        """关闭 Mail.app 残留的回复窗口"""
        try:
            proc = await asyncio.create_subprocess_exec(
                "osascript", "-e",
                'tell application "Mail"\ntry\nclose front window\nend try\nend tell',
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=5)
        except Exception:
            pass

    def _get_radar(self):
        """延迟初始化 SQLite Radar（用于搜索 Mail.app 全量邮件）"""
        if self._radar is None:
            from src.mail.sqlite_radar import SQLiteRadar
            from src.config import config
            self._radar = SQLiteRadar(
                mailboxes=[mb.strip() for mb in config.sync_mailboxes.split(',') if mb.strip()] or ["收件箱"],
                account_url_prefix=config.mail_account_url_prefix,
            )
        return self._radar

    async def handle_query_mail(self, event: Dict):
        """查询邮件元数据

        支持两种数据源：
        - source=syncstore（默认）: 查 SyncStore，仅已同步邮件
        - source=mail: 查 Mail.app SQLite Envelope Index，覆盖全部邮件
        """
        self._stats["query_mail"] += 1
        props = event.get("properties", {})
        event_id = event.get("id", "")
        source = props.get("source", "syncstore")

        # 提取查询参数
        filters = {}
        for key in ("query", "from", "subject", "date_from", "date_to", "mailbox"):
            val = props.get(key)
            if val:
                filters[key] = val

        for key in ("is_flagged", "is_read"):
            val = props.get(key)
            if val is not None:
                filters[key] = bool(val)

        # has_notion 仅 syncstore 模式支持
        if source == "syncstore":
            val = props.get("has_notion")
            if val is not None:
                filters["has_notion"] = bool(val)

        limit = min(int(props.get("limit", 10)), 50)
        offset = int(props.get("offset", 0))

        logger.info(f"query_mail: source={source} filters={filters} limit={limit} offset={offset}")

        if source == "mail":
            # 直接查 Mail.app SQLite（覆盖全部 ~24k 邮件）
            radar = self._get_radar()
            if not radar.is_available():
                await self._publish(event_id, {"status": "error", "error": "Mail.app SQLite not available"})
                return
            result = radar.search_all_emails(filters, limit=limit, offset=offset)
            # 附加 SyncStore 中的 Notion 信息（如果有）
            for email in result["emails"]:
                iid = email.get("internal_id")
                record = self.sync_store.get(iid)
                if record:
                    page_id = record.get("notion_page_id")
                    if page_id:
                        email["notion_page_id"] = page_id
                        email["notion_url"] = f"https://www.notion.so/{page_id.replace('-', '')}"
                    email["sync_status"] = record.get("sync_status")
        else:
            # 查 SyncStore（仅已同步邮件）
            result = self.sync_store.search_emails(filters, limit=limit, offset=offset)
            notion_base = "https://www.notion.so/"
            for email in result["emails"]:
                page_id = email.get("notion_page_id")
                if page_id:
                    email["notion_url"] = f"{notion_base}{page_id.replace('-', '')}"

        result["source"] = source
        await self._publish(event_id, {"status": "success", **result})
        logger.info(f"query_mail: source={source} returned {len(result['emails'])}/{result['total']} emails")

    async def handle_fetch_mail_content(self, event: Dict):
        """获取邮件完整内容.

        v4 路径（SQLite SSoT 优先）:
            1. SQLite hit → 直接读 email_body + email_metadata，~5ms
            2. SQLite miss → AppleScript fallback（保持向后兼容历史未双写邮件），~1s

        请求参数:
            internal_id: int (必填)
            mailbox: str (可选，仅 AppleScript fallback 用得上)
            format: "full" | "text" (默认 full)

        返回:
            full: message_id, subject, sender, date, content(markdown/plaintext),
                  html, is_read, is_flagged, thread_id, source, latency_ms
            text: subject, sender, date, content, source, latency_ms
        """
        self._stats["fetch_mail_content"] += 1
        t0 = time.monotonic()
        props = event.get("properties", {})
        event_id = event.get("id", "")

        internal_id = props.get("internal_id")
        if not internal_id:
            await self._publish(event_id, {"status": "error", "error": "Missing required: internal_id"})
            return

        internal_id = int(internal_id)
        mailbox = props.get("mailbox")
        fmt = props.get("format", "full")

        logger.info(f"fetch_mail_content: internal_id={internal_id} mailbox={mailbox} format={fmt}")

        # v4: 先尝试 SQLite SSoT（dual-write 已落盘则直读，省 AppleScript 来回）
        sqlite_result = self._try_fetch_from_sqlite(internal_id, fmt)
        if sqlite_result is not None:
            self._stats["fetch_mail_content_sqlite_hit"] += 1
            latency_ms = int((time.monotonic() - t0) * 1000)
            self._record_latency(self._latency_sqlite_ms, latency_ms)
            sqlite_result["source"] = "sqlite-cache"
            sqlite_result["latency_ms"] = latency_ms
            await self._publish(event_id, {"status": "success", **sqlite_result})
            logger.info(
                f"fetch_mail_content: source=sqlite-cache internal_id={internal_id} "
                f"format={fmt} latency={latency_ms}ms"
            )
            return

        # SQLite miss → AppleScript fallback
        self._stats["fetch_mail_content_sqlite_miss"] += 1
        result_data = await self._fetch_from_applescript(internal_id, mailbox, fmt)
        if result_data is None:
            await self._publish(event_id, {
                "status": "error",
                "error": f"Failed to fetch email {internal_id}. Mail.app may not be running or email was deleted.",
            })
            return

        latency_ms = int((time.monotonic() - t0) * 1000)
        self._record_latency(self._latency_applescript_ms, latency_ms)
        result_data["source"] = "applescript-fresh"
        result_data["latency_ms"] = latency_ms
        await self._publish(event_id, {"status": "success", **result_data})
        logger.info(
            f"fetch_mail_content: source=applescript-fresh internal_id={internal_id} "
            f"format={fmt} latency={latency_ms}ms"
        )

    def _try_fetch_from_sqlite(self, internal_id: int, fmt: str) -> Optional[Dict]:
        """尝试从 SQLite SSoT 拼装邮件内容；不可用时返回 None 让 caller fallback.

        命中条件:
            - email_repo 已注入
            - sync_store 有 metadata 行
            - email_body 有行且 body_format != 'empty' 且 markdown 非空
        """
        if self.email_repo is None:
            return None
        try:
            metadata = self.sync_store.get(internal_id)
            if not metadata:
                return None

            body = self.email_repo.get_body(internal_id)
            if body is None or body.body_format == "empty" or not body.markdown:
                # body 未双写（历史邮件）或解析时为空 → 让 AppleScript 路径接手
                return None

            sender = metadata.get("sender") or ""
            sender_name = metadata.get("sender_name") or ""
            sender_display = (
                f"{sender_name} <{sender}>".strip()
                if sender_name and sender else (sender or sender_name or "")
            )

            base = {
                "internal_id": internal_id,
                "subject": metadata.get("subject") or "",
                "sender": sender_display,
                "date": metadata.get("date_received") or "",
                "content": body.markdown,
            }
            if fmt != "text":
                base.update({
                    "message_id": metadata.get("message_id") or body.message_id or "",
                    "html": body.html or "",
                    "is_read": bool(metadata.get("is_read")),
                    "is_flagged": bool(metadata.get("is_flagged")),
                    "thread_id": metadata.get("thread_id") or "",
                })

            page_id = metadata.get("notion_page_id")
            if page_id:
                base["notion_page_id"] = page_id
                base["notion_url"] = f"https://www.notion.so/{page_id.replace('-', '')}"
            return base
        except Exception as e:
            logger.warning(
                f"fetch_mail_content: SQLite read failed for internal_id={internal_id}: {e}; "
                f"falling back to AppleScript"
            )
            return None

    async def _fetch_from_applescript(
        self, internal_id: int, mailbox: Optional[str], fmt: str
    ) -> Optional[Dict]:
        """AppleScript fallback —— 历史未双写的邮件或 SQLite 异常时走这条路."""
        full_email = self.arm.fetch_email_content_by_id(internal_id, mailbox)
        if not full_email:
            return None

        # 解析 MIME 获取 HTML 正文
        source = full_email.get("source", "")
        html_body = ""
        plain_body = full_email.get("content", "")

        if source:
            try:
                import email as email_lib
                msg = email_lib.message_from_string(source)
                for part in msg.walk():
                    ct = part.get_content_type()
                    if ct == "text/html" and not html_body:
                        payload = part.get_payload(decode=True)
                        if payload:
                            html_body = decode_mime_bytes(payload, part.get_content_charset())
                    elif ct == "text/plain" and not plain_body:
                        payload = part.get_payload(decode=True)
                        if payload:
                            plain_body = decode_mime_bytes(payload, part.get_content_charset())
            except Exception as e:
                logger.warning(f"MIME parse error for {internal_id}: {e}")

        if fmt == "text":
            result_data = {
                "internal_id": internal_id,
                "subject": full_email.get("subject", ""),
                "sender": full_email.get("sender", ""),
                "date": full_email.get("date", ""),
                "content": plain_body,
            }
        else:
            result_data = {
                "internal_id": internal_id,
                "message_id": full_email.get("message_id", ""),
                "subject": full_email.get("subject", ""),
                "sender": full_email.get("sender", ""),
                "date": full_email.get("date", ""),
                "content": plain_body,
                "html": html_body,
                "is_read": full_email.get("is_read", False),
                "is_flagged": full_email.get("is_flagged", False),
                "thread_id": full_email.get("thread_id", ""),
            }

        record = self.sync_store.get(internal_id)
        if record and record.get("notion_page_id"):
            pid = record["notion_page_id"]
            result_data["notion_page_id"] = pid
            result_data["notion_url"] = f"https://www.notion.so/{pid.replace('-', '')}"

        return result_data

    async def handle_search_email_bodies(self, event: Dict):
        """FTS5 全文搜索邮件正文 + subject + sender（Search Query DSL v1, smart 默认）.

        请求参数 (event.properties):
            query: str (必填) — 自然语言关键词或 from:/subject:/after: 等查询语法
            mode: str (可选, 默认 'smart') — 'smart' = Search Query DSL v1 +
                CJK-aware 自动改写; 'raw' = 不动, 直接交给 FTS5
            limit: int (默认 50，最大 200)
            mailbox: str (可选) — 仅返回该邮箱（'收件箱' / '发件箱'）
            since_date / until_date: str (可选) — 'YYYY-MM-DD'，按 date_received 过滤

        响应:
            {status:'success', query, transformed_query (smart 时), parse_warnings?,
             mode,
             hits:[{internal_id, subject, sender, date_received, mailbox,
                    snippet, rank, notion_page_id, notion_url}],
             total_hits, latency_ms}

        Notes:
            - rank 是 bm25 分数，越小越相关；按 rank 升序返回
            - snippet 是 FTS5 高亮片段（默认 <mark>...</mark>）
            - 仅覆盖已 dual-written 的邮件；历史未 backfill 的邮件不会出现在结果里
            - smart 模式自动处理 unicode61 chunk-level token 命不中的洞,
              中文 query '产品' 自动转 '(产品* OR (产* AND 品*))' 等；
              含字段语法时按 Search Query DSL v1 编译
        """
        self._stats["search_email_bodies"] += 1
        t0 = time.monotonic()
        props = event.get("properties", {})
        event_id = event.get("id", "")

        query = (props.get("query") or "").strip()
        if not query:
            self._stats["search_email_bodies_error"] += 1
            await self._publish(event_id, {
                "status": "error",
                "error": "Missing required: query (FTS5 search query string)",
            })
            return

        if self.email_repo is None:
            self._stats["search_email_bodies_error"] += 1
            await self._publish(event_id, {
                "status": "error",
                "error": "Search unavailable: EmailRepository not initialized (v4 disabled?)",
            })
            return

        # cap limit to 200 防止 agent 误传大值压爆 dashboard
        try:
            limit = max(1, min(int(props.get("limit", 50)), 200))
        except (TypeError, ValueError):
            limit = 50

        mailbox = props.get("mailbox") or None
        since_date = props.get("since_date") or None
        until_date = props.get("until_date") or None

        # Search DSL v1: mode 'smart' (default) | 'raw' (FTS5 explicit)
        mode = (props.get("mode") or "smart").strip().lower()
        if mode not in ("smart", "raw"):
            mode = "smart"

        logger.info(
            f"search_email_bodies: query={query!r} mode={mode} "
            f"mailbox={mailbox} since={since_date} until={until_date}"
        )

        try:
            if hasattr(self.email_repo, "search_email_bodies_with_meta"):
                search_result = self.email_repo.search_email_bodies_with_meta(
                    query,
                    mode=mode,
                    limit=limit,
                    mailbox=mailbox,
                    since_date=since_date,
                    until_date=until_date,
                )
                hits = search_result.hits
                transformed_query = search_result.transformed_query
                parse_warnings = search_result.parse_warnings
            else:
                # 测试 fake / 旧 repo 兼容路径。
                if mode == "smart":
                    from src.repository.email_repository import smart_query_transform
                    transformed_query = smart_query_transform(query)
                else:
                    transformed_query = query
                hits = self.email_repo.search_email_bodies(
                    transformed_query,
                    limit=limit,
                    mailbox=mailbox,
                    since_date=since_date,
                    until_date=until_date,
                )
                parse_warnings = []
        except Exception as e:
            self._stats["search_email_bodies_error"] += 1
            logger.error(f"search_email_bodies: failed for query={query!r}: {e}")
            await self._publish(event_id, {"status": "error", "error": str(e)})
            return

        latency_ms = int((time.monotonic() - t0) * 1000)
        self._record_latency(self._latency_search_ms, latency_ms)

        if hits:
            self._stats["search_email_bodies_hits"] += len(hits)
        else:
            self._stats["search_email_bodies_empty"] += 1

        payload = {
            "status": "success",
            "query": query,
            "mode": mode,
            "total_hits": len(hits),
            "hits": [
                {
                    "internal_id": h.internal_id,
                    "subject": h.subject,
                    "sender": h.sender,
                    "date_received": h.date_received,
                    "mailbox": h.mailbox,
                    "snippet": h.snippet,
                    "rank": h.rank,
                    "notion_page_id": h.notion_page_id,
                    "notion_url": h.notion_url,
                    "source": h.source,
                    "filename": h.filename,
                }
                for h in hits
            ],
            "latency_ms": latency_ms,
        }
        if mode == "smart" and transformed_query != query:
            payload["transformed_query"] = transformed_query
        if parse_warnings:
            payload["parse_warnings"] = parse_warnings
        await self._publish(event_id, payload)
        logger.info(
            f"search_email_bodies: query={query!r} returned {len(hits)} hits "
            f"latency={latency_ms}ms mode={mode}"
        )

    async def handle_search_email_attachments(self, event: Dict):
        """FTS5 全文搜附件文本 (PR-2b, Sprint 19 M2).

        跟 handle_search_email_bodies 平行设计 — 但搜的是 attachment_text
        (PDF / docx / pptx / xlsx 抽出来的文本), JOIN email_attachment +
        email_metadata 拼上下文.

        请求参数 (event.properties):
            query: str (必填) — 自然语言关键词或 FTS5 query 语法
            mode: str (可选, 默认 'smart') — 'smart' (CJK-aware 改写) / 'raw'
            limit: int (默认 30, 最大 100)
            mailbox: str (可选) — 仅返回该邮箱
            since_date / until_date: str (可选) — YYYY-MM-DD

        响应:
            {status:'success', query, mode, [transformed_query],
             hits:[{attachment_id, internal_id, filename, content_type,
                    email_subject, email_sender, email_date, email_mailbox,
                    snippet, rank, notion_page_id, notion_url}],
             total_hits, latency_ms}

        Notes:
            - 只覆盖已经 attachment_text status='extracted' 的 attachment
              (worker 跑过 / CLI mailagent attachment extract --pending 完成的);
              未抽取的 attachment 不在结果里
            - 历史邮件需要先跑 ``mailagent attachment extract --include-missing``
              一次性补 enqueue 然后 extract
        """
        self._stats["search_email_attachments"] += 1
        t0 = time.monotonic()
        props = event.get("properties", {})
        event_id = event.get("id", "")

        query = (props.get("query") or "").strip()
        if not query:
            self._stats["search_email_attachments_error"] += 1
            await self._publish(event_id, {
                "status": "error",
                "error": "Missing required: query (FTS5 search query string)",
            })
            return

        if self.email_repo is None:
            self._stats["search_email_attachments_error"] += 1
            await self._publish(event_id, {
                "status": "error",
                "error": "Search unavailable: EmailRepository not initialized",
            })
            return

        # cap limit to 100 (attachment FTS hit 比 body 大, snippet 也长)
        try:
            limit = max(1, min(int(props.get("limit", 30)), 100))
        except (TypeError, ValueError):
            limit = 30

        mailbox = props.get("mailbox") or None
        since_date = props.get("since_date") or None
        until_date = props.get("until_date") or None

        mode = (props.get("mode") or "smart").strip().lower()
        if mode not in ("smart", "raw"):
            mode = "smart"

        if mode == "smart":
            from src.repository.email_repository import smart_query_transform
            transformed_query = smart_query_transform(query)
        else:
            transformed_query = query

        logger.info(
            f"search_email_attachments: query={query!r} mode={mode} "
            f"transformed={transformed_query!r} limit={limit} "
            f"mailbox={mailbox} since={since_date} until={until_date}"
        )

        try:
            hits = self.email_repo.search_attachment_texts(
                transformed_query,
                limit=limit,
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
            )
        except Exception as e:
            self._stats["search_email_attachments_error"] += 1
            logger.error(f"search_email_attachments: failed for query={query!r}: {e}")
            await self._publish(event_id, {"status": "error", "error": str(e)})
            return

        latency_ms = int((time.monotonic() - t0) * 1000)

        if hits:
            self._stats["search_email_attachments_hits"] += len(hits)
        else:
            self._stats["search_email_attachments_empty"] += 1

        payload = {
            "status": "success",
            "query": query,
            "mode": mode,
            "total_hits": len(hits),
            "hits": [
                {
                    "attachment_id": h.attachment_id,
                    "internal_id": h.internal_id,
                    "filename": h.filename,
                    "content_type": h.content_type,
                    "email_subject": h.email_subject,
                    "email_sender": h.email_sender,
                    "email_date": h.email_date,
                    "email_mailbox": h.email_mailbox,
                    "snippet": h.snippet,
                    "rank": h.rank,
                    "notion_page_id": h.notion_page_id,
                    "notion_url": h.notion_url,
                }
                for h in hits
            ],
            "latency_ms": latency_ms,
        }
        if mode == "smart" and transformed_query != query:
            payload["transformed_query"] = transformed_query
        await self._publish(event_id, payload)
        logger.info(
            f"search_email_attachments: query={query!r} returned {len(hits)} hits "
            f"latency={latency_ms}ms mode={mode}"
        )

    async def handle_page_updated(self, event: Dict):
        """通用事件: 根据内容自动判断"""
        props = event.get("properties", {})
        ai_review_status = props.get("ai_review_status", "")

        if ai_review_status == "AI Reviewed":
            await self.handle_ai_reviewed(event)
        elif ai_review_status == "已完成":
            await self.handle_completed(event)

        # 始终检查 flag 变化
        if "is_read" in props or "is_flagged" in props:
            await self.handle_flag_changed(event)
